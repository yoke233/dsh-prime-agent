import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as primeAgent from '../src/index.js'

class BindingRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'
  behavior: (request: CodeRunRequest) => Promise<CodeRunResult> = () => Promise.resolve({ logs: [] })

  run(request: CodeRunRequest): Promise<CodeRunResult> {
    return this.behavior(request)
  }
}

function ownerAgent(ctx: Context, idValue: string): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(idValue)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    options: {},
    session: { id, header: { version: 0, id, createdAt: 0 }, append: () => {} },
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('Prime RLM over real DSH subagent and jobs tools', () => {
  it('continues after background admission, then collects and persists the child result', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-orchestration-'))
    context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'code' })
    await context.plugin(BindingRuntime)
    await context.plugin(SubagentRuntime)
    await context.plugin(AgentRegistry)
    await context.plugin(LocalJobRegistry)
    await context.plugin(ToolJobs, {})

    let settleChild!: (result: SubagentResult) => void
    const childDone = new Promise<SubagentResult>((resolve) => { settleChild = resolve })
    const foregroundStarted: string[] = []
    let releaseForeground!: () => void
    const bothForegroundStarted = new Promise<void>((resolve) => { releaseForeground = resolve })
    context.subagents.registerProvider({
      name: 'scripted',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      async start(request) {
        if (request.label?.startsWith('parallel-')) {
          foregroundStarted.push(request.label)
          if (foregroundStarted.length === 2) releaseForeground()
          await bothForegroundStarted
          return {
            id: SessionId(`child-${request.label}`),
            localAgent: undefined,
            result: Promise.resolve({
              output: [{ type: 'text', text: `done ${request.label}` }], stopReason: 'completed',
            }),
            dispose: () => Promise.resolve(),
          }
        }
        return {
          id: SessionId(`child-of-${request.parent.id}`),
          localAgent: undefined,
          result: childDone,
          dispose: () => Promise.resolve(),
        }
      },
    })
    await context.plugin(ToolSubagent, {
      provider: 'scripted',
      toolName: 'subagent',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    })
    await context.plugin(primeAgent, { stateDirectory: join(root, 'state') })

    const agent = ownerAgent(context, 'rlm-parent')
    const runtime = context.codeRuntime as BindingRuntime
    runtime.behavior = async (request) => {
      const subagent = request.bindings[0]?.functions.subagent
      if (subagent === undefined) throw new Error('subagent binding missing')
      const results = await Promise.all([
        subagent({ description: 'parallel-one', prompt: 'one', run_in_background: false }),
        subagent({ description: 'parallel-two', prompt: 'two', run_in_background: false }),
      ])
      return { logs: [], value: results }
    }
    const parallel = await context.tools.execute({
      callId: 'foreground-parallel' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'return await Promise.all([tools.subagent(...), tools.subagent(...)])', description: 'Parallel delegation' },
      signal: new AbortController().signal,
      agent,
    })
    expect(parallel.isError).toBe(false)
    expect(foregroundStarted.sort()).toEqual(['parallel-one', 'parallel-two'])

    let admittedJob = ''
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]?.functions
      if (tools === undefined) throw new Error('tools binding missing')
      const admission = await tools.subagent?.({
        description: 'background research', prompt: 'Find the answer', run_in_background: true,
      }) as { jobId?: string; kind?: string }
      admittedJob = admission.jobId ?? ''
      const marker = await tools.prime_context?.({
        operation: 'put', expected_revision: 0, key: 'parent-progress', kind: 'text',
        summary: 'Work completed while the child was pending', value: 'parent kept working',
      })
      return { logs: [], value: { admission, marker } }
    }

    const admitted = await context.tools.execute({
      callId: 'background-admission' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'const child = await tools.subagent(...); await tools.prime_context(...); return child', description: 'Start and continue' },
      signal: new AbortController().signal,
      agent,
    })
    expect(admitted.isError).toBe(false)
    expect(admittedJob).toMatch(/^subagent-/)
    const beforeChildFinishes = new primeAgent.ContextStore(join(root, 'state', 'rlm'), {
      maxEntriesPerScope: 128, maxKeyChars: 160, maxSummaryChars: 500,
      maxValueBytes: 16 * 1024 * 1024, maxTotalBytesPerScope: 256 * 1024 * 1024,
      maxManifestBytes: 2 * 1024 * 1024, maxReadChars: 32_000,
      maxSearchQueryChars: 500, maxSearchMatches: 50, maxSearchWindowChars: 500,
      maxSearchChars: 2_000_000, maxCatalogEntries: 64, maxCatalogChars: 12_000,
    })
    expect(await beforeChildFinishes.get('local', String(agent.id), 'parent-progress'))
      .toMatchObject({ content: 'parent kept working' })

    settleChild({ output: [{ type: 'text', text: 'child research result' }], stopReason: 'completed' })
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]?.functions
      if (tools === undefined) throw new Error('tools binding missing')
      const output = await tools.job_output?.({ job_id: admittedJob, wait: true })
      const catalog = await tools.prime_context?.({ operation: 'catalog' }) as { revision: number }
      await tools.prime_context?.({
        operation: 'put', expected_revision: catalog.revision, key: 'child-result', kind: 'json',
        summary: 'Collected background child result', value: output,
      })
      return { logs: [], value: output }
    }
    const collected = await context.tools.execute({
      callId: 'background-collect' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'const output = await tools.job_output(...); await tools.prime_context(...); return output', description: 'Collect child' },
      signal: new AbortController().signal,
      agent,
    })
    expect(collected.isError).toBe(false)
    const persisted = await beforeChildFinishes.get('local', String(agent.id), 'child-result')
    expect(persisted.format).toBe('json-text')
    expect(persisted.content).toContain('child research result')
  })
})
