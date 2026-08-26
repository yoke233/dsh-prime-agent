import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as primeRuntime from '../src/runtime.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const PRIME_AGENT_URL = pathToFileURL(resolve(PROJECT_ROOT, 'lib/index.js')).href
const REFINE_SKILL_URL = pathToFileURL(resolve(PROJECT_ROOT, 'lib/refine-skill-provider.js')).href
const PACKAGED_COMPOSITION = join(PROJECT_ROOT, 'agent-presets/prime/agent.cordis.yml')
const testSignal = new AbortController().signal

let ctx: Context | undefined
let root: string | undefined
let disposeAgent: (() => Promise<void>) | undefined
let callNumber = 0

afterEach(async () => {
  await disposeAgent?.()
  disposeAgent = undefined
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
})

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
  if (ctx === undefined) throw new Error('test context was not created')
  return completion(await ctx.tools.execute({
    callId: CallId(`prime-preset-mount-${++callNumber}`),
    name: 'repl',
    arguments: { code },
    signal: testSignal,
    agent,
  }))
}

/** The full host capability set the packaged Prime policy requires before assembly. */
const POLICY_REQUIRED_TOOLS = [
  'subagent', 'list_agents', 'send_message', 'interrupt_agent',
  'job_output', 'job_list', 'job_kill',
]

function registerOrchestrationPlaceholders(context: Context): void {
  for (const name of POLICY_REQUIRED_TOOLS) {
    context.tools.register(defineTool({
      name,
      description: `Test-only visible ${name} capability required by the packaged Prime policy.`,
      parameters: {},
      output: {
        schema: { type: 'null' },
        render: () => [{ type: 'text', text: 'unused' }],
      },
      execute: async () => null,
    }))
  }
}

describe('Prime packaged preset realm rows', () => {
  it('mounts them for one Agent and supplies the persistent repl binding', async () => {
    // Keep the temporary composition inside this package scope so Node's
    // ordinary upward lookup resolves the self-reference and explicit dev deps.
    root = await mkdtemp(join(PROJECT_ROOT, '.prime-preset-mount-'))
    const home = join(root, 'home')
    const presetRoot = join(root, 'presets')
    const presetDir = join(presetRoot, 'prime')
    await mkdir(presetDir, { recursive: true })

    // Keep the exact shipped `prime-agent` row — the packaged plugin name and
    // its `!!js dshHomePath(...)` stateDirectory expression — while excluding
    // the unrelated shell, filesystem, delegation, and UI tool rows. Their
    // composition is covered statically; this E2E targets the preset mount seam.
    const shipped = (await readFile(PACKAGED_COMPOSITION, 'utf8')).replace(/\r\n/g, '\n')
    const start = shipped.indexOf('- id: prime-agent\n')
    if (start < 0) throw new Error('packaged Prime realm row is missing')
    const end = shipped.indexOf('# ── shell', start)
    const realmRows = shipped.slice(start, end < 0 ? undefined : end)
      .replace(/^  name: dsh-prime-agent$/m, `  name: ${PRIME_AGENT_URL}`)
      .replace(/^  name: dsh-prime-agent\/refine-skill-provider$/m, `  name: ${REFINE_SKILL_URL}`)
    await writeFile(join(presetDir, 'agent.cordis.yml'), realmRows)

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(primeRuntime, { stateDirectory: join(home, 'prime-agent') })
    await ctx.plugin(AgentPresets, {
      default: 'prime',
      roots: [{ path: presetRoot, trust: 'system' }],
      includeUserRoot: false,
    })
    registerOrchestrationPlaceholders(ctx)

    const handle = await ctx.agents.create({
      sessionId: SessionId('prime-preset-agent'),
      meta: { cwd: root, agentPreset: 'prime' },
      setup: agentCtx => ctx!.agentPresets.mount(agentCtx, 'prime').then(() => undefined),
    })
    disposeAgent = () => handle.dispose()

    expect(ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('prime')
    const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent, agent: handle.agent })
    expect(assembly.tools.map(tool => tool.name)).toEqual(['repl'])
    expect(ctx.tools.get('refine', handle.agent)).toBeUndefined()
    const refineSkill = await ctx.skills.get('refine', { scope: handle.agent })
    expect(refineSkill?.content).toContain('await refine.run()')

    const first = await runRepl(
      handle.agent,
      'const presetSentinel = "mounted-prime"; presetSentinel',
    )
    expect(first.result).toBe('mounted-prime')

    const second = await runRepl(handle.agent, 'presetSentinel')
    expect(second.result).toBe('mounted-prime')
  })
})