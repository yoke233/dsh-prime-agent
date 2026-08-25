import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'

const PATCH_PATH = resolve(import.meta.dirname, '../cordis.patch.yml')
const PRIME_AGENT_URL = pathToFileURL(resolve(import.meta.dirname, '../lib/index.js')).href
const PRIME_RUNTIME_URL = pathToFileURL(resolve(import.meta.dirname, '../lib/runtime.js')).href
const PACKAGED_PRESET = resolve(import.meta.dirname, '../agent-presets/prime')
const testSignal = new AbortController().signal

let ctx: Context | undefined
let root: string | undefined
let callNumber = 0

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
})

function testAgent(id: string, cwd: string): { agent: Agent, events: { type: string, data: unknown }[] } {
  const events: { type: string, data: unknown }[] = []
  const agent = {
    id: SessionId(id),
    session: {
      // `header.id` is the spill owner the composed policy reads.
      header: { id: SessionId(id), cwd },
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    },
  } as unknown as Agent
  return { agent, events }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function completion(execution: ToolExecutionResult): { logs: string[], result?: unknown } {
  if (execution.isError) throw new Error(execution.error.message)
  if (!isRecord(execution.value) || !Array.isArray(execution.value.logs)
    || !execution.value.logs.every(log => typeof log === 'string')) {
    throw new Error('invalid run_code result')
  }
  return {
    logs: execution.value.logs,
    ...('result' in execution.value ? { result: execution.value.result } : {}),
  }
}

async function runCode(agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  if (ctx === undefined) throw new Error('test context was not booted')
  return completion(await ctx.tools.execute({
    callId: CallId(`prime-compose-${++callNumber}`),
    name: RUN_CODE_NAME,
    arguments: { code, description: 'Exercise the composed Prime runtime' },
    signal: testSignal,
    agent,
  }))
}

async function bootPrimeHost(includeOfficialRuntime: boolean): Promise<{
  hostRoot: string
  home: string
  spillRoot: string
}> {
  const hostRoot = await mkdtemp(join(tmpdir(), 'dsh-prime-compose-'))
  root = hostRoot
  const home = join(hostRoot, 'home')
  const spillRoot = join(hostRoot, 'spill')
  vi.stubEnv('DSH_HOME', home)
  const configPath = join(hostRoot, 'cordis.yml')
  const patchPath = join(hostRoot, 'cordis.patch.yml')
  await writeFile(patchPath, (await readFile(PATCH_PATH, 'utf8'))
    .replace('name: dsh-prime-agent/runtime', `name: ${PRIME_RUNTIME_URL}`))
  const officialRuntime = includeOfficialRuntime
    ? "- id: code-runtime\n  name: '@deepseek-ai/dsh-code-runtime-worker-thread'\n"
    : ''
  await writeFile(configPath, `
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: code
${officialRuntime}- id: agents
  name: '@deepseek-ai/dsh-agent'
- id: subagents
  name: '@deepseek-ai/dsh-subagent'
- id: prime-agent
  name: ${PRIME_AGENT_URL}
  config:
    stateDirectory: !!js dshHomePath('prime-agent')
    requireOrchestrationTools: false
`.trimStart())

  ctx = await boot(
    'prime-compose-e2e',
    configPath,
    loadOverlayPatches('prime-compose-e2e', patchPath),
    undefined,
    import.meta.url,
  )
  return { hostRoot, home, spillRoot }
}

describe('Prime host patch composition', () => {
  it('replaces the official runtime, authenticates through the real tool, and places the preset', async () => {
    const { hostRoot, home, spillRoot } = await bootPrimeHost(true)

    // Mount the npm-installed spill chain post-boot so this focused fixture can
    // supply its temporary backend root directly. All DSH modules in this test
    // resolve from package-lock.json; only this package's just-built entrypoints
    // use file URLs because it is the package under test, not an installed peer.
    await ctx.plugin(LocalSpillStore, { root: spillRoot })
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 1024 })

    // Project each row before asserting. A loader `Entry` holds `ctx`, a cordis
    // Context proxy that throws on any property it does not provide; vitest's
    // diff printer probes `$$typeof`, so asserting on entries themselves fails
    // with that crash instead of the assertion's own difference.
    // `loader.entries()` recurses into nested subtrees, so the rows the patch
    // inserted into the root Include appear here alongside the config's own.
    const rows = [...ctx.loader.entries()].map(entry => ({
      id: entry.options.id,
      name: entry.options.name,
      disabled: entry.options.disabled ?? false,
      mounted: Boolean(entry.fiber),
    }))

    // The runtime swap, both halves: the official row is retired without a
    // fiber, and the Prime row the patch inserted in its place is live.
    expect(rows).toContainEqual({
      id: 'code-runtime',
      name: '@deepseek-ai/dsh-code-runtime-worker-thread',
      disabled: true,
      mounted: false,
    })
    expect(rows).toContainEqual({
      id: 'prime-code-runtime',
      name: PRIME_RUNTIME_URL,
      disabled: false,
      mounted: true,
    })
    const alpha = testAgent('compose-alpha', hostRoot)
    const beta = testAgent('compose-beta', hostRoot)
    const first = await runCode(alpha.agent, 'const answer = 424242; answer')
    expect(first.result).toBe(424242)

    const second = await runCode(alpha.agent, 'answer')
    expect(second.result).toBe(424242)

    const isolated = await runCode(beta.agent, 'typeof answer === "undefined" ? null : answer')
    expect(isolated.result).toBeNull()
    expect(alpha.events.some(event => event.type === 'tool/code-dispatch'
      && isRecord(event.data) && event.data.name === 'prime_realm_identity')).toBe(true)

    const placed = join(home, '.agent-presets', 'prime')
    for (const filename of ['agent.cordis.yml', 'preset.yml']) {
      expect(await readFile(join(placed, filename), 'utf8'))
        .toBe(await readFile(join(PACKAGED_PRESET, filename), 'utf8'))
    }

    // Plan 1.4 composition acceptance: the loader-composed profile routes a
    // large outer result through the real spill chain — owner, backend, and
    // policy wired by the config above, not by hand in the test.
    const body = 'SPILL-'.repeat(1000)
    const big = await ctx.tools.execute({
      callId: CallId(`prime-compose-${++callNumber}`),
      name: RUN_CODE_NAME,
      arguments: { code: '"SPILL-".repeat(1000)', description: 'Exercise the composed spill chain' },
      signal: testSignal,
      agent: alpha.agent,
    })
    expect(big.isError).toBe(false)
    const bigValue = completion(big)
    expect(bigValue.result).toBe(body)

    const bigContent = big.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text).join('')
    expect(Buffer.byteLength(bigContent, 'utf8')).toBeLessThanOrEqual(1024)
    expect(bigContent).toContain('Full formatted result stored at:')
    expect(bigContent).not.toContain(body)

    const locator = /Full formatted result stored at: (.+?)\. Use read with/.exec(bigContent)?.[1]
    if (locator === undefined) throw new Error(`no spill locator in: ${bigContent.slice(-300)}`)
    expect(await readFile(locator, 'utf8')).toContain(body)
  })

  it('starts when the host has no public official runtime row', async () => {
    const { hostRoot } = await bootPrimeHost(false)
    if (ctx === undefined) throw new Error('test context was not booted')
    const rows = [...ctx.loader.entries()].map(entry => ({
      id: entry.options.id,
      name: entry.options.name,
      mounted: Boolean(entry.fiber),
    }))

    expect(rows.some(row => row.id === 'code-runtime')).toBe(false)
    expect(rows).toContainEqual({
      id: 'prime-code-runtime',
      name: PRIME_RUNTIME_URL,
      mounted: true,
    })

    const { agent } = testAgent('compose-tui', hostRoot)
    expect((await runCode(agent, 'const retained = 20260825; retained')).result).toBe(20260825)
    expect((await runCode(agent, 'retained')).result).toBe(20260825)
  })
})
