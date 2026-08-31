import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { REPL_TOOL_NAME } from '../src/repl/bridge.js'
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
    throw new Error('invalid repl result')
  }
  return {
    logs: execution.value.logs,
    ...('result' in execution.value ? { result: execution.value.result } : {}),
  }
}

async function runRepl(agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  if (ctx === undefined) throw new Error('test context was not booted')
  return completion(await ctx.tools.execute({
    callId: ToolCallId(`prime-compose-${++callNumber}`),
    name: REPL_TOOL_NAME,
    arguments: { code },
    signal: testSignal,
    agent,
  }))
}

/** Deterministic 43-char unpadded base64url Realm identity for one test seed. */
function realmId(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url')
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
    mode: native
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
  it('mounts the Prime service beside the official runtime and places the preset', async () => {
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
    // `loader.entries()` recurses into nested subtrees, so the row the patch
    // inserted into the root Include appears here alongside the config's own.
    const rows = [...ctx.loader.entries()].map(entry => ({
      id: entry.options.id,
      name: entry.options.name,
      disabled: entry.options.disabled ?? false,
      mounted: Boolean(entry.fiber),
    }))

    // The patch is a pure insert: the official row stays enabled and mounted,
    // and the Prime row lands beside it.
    expect(rows).toContainEqual({
      id: 'code-runtime',
      name: '@deepseek-ai/dsh-code-runtime-worker-thread',
      disabled: false,
      mounted: true,
    })
    expect(rows).toContainEqual({
      id: 'prime-code-runtime',
      name: PRIME_RUNTIME_URL,
      disabled: false,
      mounted: true,
    })

    // The model-facing REPL persists state while the official runtime row remains mounted independently.
    const alpha = testAgent('compose-alpha', hostRoot)
    const beta = testAgent('compose-beta', hostRoot)
    const first = await runRepl(alpha.agent, 'globalThis.carried = "persistent"\n1')
    expect(first.result).toBe(1)
    const second = await runRepl(alpha.agent, 'typeof globalThis.carried === "undefined" ? "fresh" : globalThis.carried')
    expect(second.result).toBe('persistent')
    // The Prime seam is the uniquely named service: one persistent realm per id.
    if (ctx === undefined) throw new Error('test context was not booted')
    const seeded = await ctx.primeRealmRuntime.run(realmId('compose-alpha'), {
      program: 'const answer = 424242; answer',
      bindings: [],
    })
    expect(seeded.error).toBeUndefined()
    expect(seeded.value).toBe(424242)
    const resumed = await ctx.primeRealmRuntime.run(realmId('compose-alpha'), { program: 'answer', bindings: [] })
    expect(resumed.error).toBeUndefined()
    expect(resumed.value).toBe(424242)
    const isolated = await ctx.primeRealmRuntime.run(realmId('compose-beta'), {
      program: 'typeof answer === "undefined" ? null : answer',
      bindings: [],
    })
    expect(isolated.value).toBeNull()

    const placed = join(home, '.agent-presets', 'prime')
    for (const filename of ['agent.cordis.yml', 'preset.yml']) {
      expect(await readFile(join(placed, filename), 'utf8'))
        .toBe(await readFile(join(PACKAGED_PRESET, filename), 'utf8'))
    }

    // The loader-composed profile routes a large outer result through the real
    // spill chain, with owner, backend and policy wired by config rather than by
    // hand in the test.
    const body = 'SPILL-'.repeat(1000)
    const big = await ctx.tools.execute({
      callId: ToolCallId(`prime-compose-${++callNumber}`),
      name: REPL_TOOL_NAME,
      arguments: { code: '"SPILL-".repeat(1000)' },
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

  it('mounts the Prime service when the host has no public official runtime row', async () => {
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

    // The trusted realm service works without any codeRuntime provider: the
    // official one-shot seam is nobody's business here.
    const seeded = await ctx.primeRealmRuntime.run(realmId('compose-tui'), {
      program: 'const retained = 20260825; retained',
      bindings: [],
    })
    expect(seeded.value).toBe(20260825)
    const resumed = await ctx.primeRealmRuntime.run(realmId('compose-tui'), { program: 'retained', bindings: [] })
    expect(resumed.value).toBe(20260825)
  })
})
