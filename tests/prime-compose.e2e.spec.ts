import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

describe('Prime host patch composition', () => {
  it('replaces the official runtime, authenticates through the real tool, and places the preset', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-compose-'))
    const home = join(root, 'home')
    const spillRoot = join(root, 'spill')
    vi.stubEnv('DSH_HOME', home)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, `
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: code
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
- id: agents
  name: '@deepseek-ai/dsh-agent'
- id: subagents
  name: '@deepseek-ai/dsh-subagent'
- id: prime-agent
  name: dsh-prime-agent
  config:
    stateDirectory: !!js dshHomePath('prime-agent')
    requireOrchestrationTools: false
`.trimStart())

    ctx = await boot(
      'prime-compose-e2e',
      configPath,
      loadOverlayPatches('prime-compose-e2e', PATCH_PATH),
      undefined,
      import.meta.url,
    )

    // The spill chain mounts post-boot from the pinned harness SOURCE tree
    // rather than as loader rows: loader entries resolve through node_modules,
    // and the registry's @deepseek-ai/dsh-spill-policy (0.0.1-rc.1 at the time
    // of writing) lags the pinned checkout every other test in this suite
    // verifies against, so a loader row would compose a different policy than
    // the one the plan's focused E2E pins. The composition property under test
    // — owner, backend, and projection wired against the loader-booted profile
    // — is unchanged.
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
      name: 'dsh-prime-agent/runtime',
      disabled: false,
      mounted: true,
    })
    const alpha = testAgent('compose-alpha', root)
    const beta = testAgent('compose-beta', root)
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
})
