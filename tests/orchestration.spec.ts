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
import type { SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
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

function ownerAgent(ctx: Context, idValue: string, inject: (message: unknown) => void = () => {}): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(idValue)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject,
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
    const parentProgress: string[] = []
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]?.functions
      if (tools === undefined) throw new Error('tools binding missing')
      const admission = await tools.subagent?.({
        description: 'background research', prompt: 'Find the answer', run_in_background: true,
      }) as { jobId?: string; kind?: string }
      admittedJob = admission.jobId ?? ''
      // Work performed strictly after admission, while the child is still pending.
      parentProgress.push('parent kept working')
      return { logs: [], value: { admission } }
    }

    const admitted = await context.tools.execute({
      callId: 'background-admission' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'const child = await tools.subagent(...); /* continue */ return child', description: 'Start and continue' },
      signal: new AbortController().signal,
      agent,
    })
    expect(admitted.isError).toBe(false)
    expect(admittedJob).toMatch(/^subagent-/)
    // The child has not settled yet, and the parent already made progress.
    expect(parentProgress).toEqual(['parent kept working'])

    settleChild({ output: [{ type: 'text', text: 'child research result' }], stopReason: 'completed' })
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]?.functions
      if (tools === undefined) throw new Error('tools binding missing')
      const output = await tools.job_output?.({ job_id: admittedJob, wait: true })
      return { logs: [], value: output }
    }
    const collected = await context.tools.execute({
      callId: 'background-collect' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'return await tools.job_output(...)', description: 'Collect child' },
      signal: new AbortController().signal,
      agent,
    })
    expect(collected.isError).toBe(false)
    if (collected.isError) throw new Error(collected.error.message)
    expect(JSON.stringify(collected.value)).toContain('child research result')
  })
})

describe('Prime RLM job ownership over real DSH jobs', () => {
  /** Boot the jobs composition with one scripted provider; each test owns its child behavior. */
  async function bootJobs(idValue: string, start: SubagentProvider['start']): Promise<{ agent: Agent; runtime: BindingRuntime }> {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-orchestration-'))
    context = new Context()
    await context.plugin(SystemPrompt, {})
    await context.plugin(ToolRuntime, { mode: 'code' })
    await context.plugin(BindingRuntime)
    await context.plugin(SubagentRuntime)
    await context.plugin(AgentRegistry)
    await context.plugin(LocalJobRegistry)
    await context.plugin(ToolJobs, {})
    context.subagents.registerProvider({
      name: 'scripted',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })
    await context.plugin(ToolSubagent, {
      provider: 'scripted',
      toolName: 'subagent',
      backgroundMode: 'one-shot',
      maxDepth: 'provider-managed',
    })
    await context.plugin(primeAgent, { stateDirectory: join(root, 'state') })
    return { agent: ownerAgent(context, idValue), runtime: context.codeRuntime as BindingRuntime }
  }

  it('kills an obsolete job, leaves no orphan, and never restarts it', async () => {
    let starts = 0
    let disposed = 0
    const { agent, runtime } = await bootJobs('rlm-jobs-kill', async (request) => {
      starts += 1
      // A proper child settles `aborted` on cancellation instead of rejecting.
      const result = new Promise<SubagentResult>((resolve) => {
        request.signal?.addEventListener('abort', () => {
          resolve({ output: [], stopReason: 'aborted' })
        }, { once: true })
      })
      return {
        id: SessionId(`child-kill-${starts}`),
        localAgent: undefined,
        result,
        dispose: () => { disposed += 1; return Promise.resolve() },
      }
    })

    // Admit, decide the work is obsolete, kill, and confirm — one event-driven
    // program with no sleeps: every await resolves off a jobs notification.
    let kill!: { outcome: string }
    let output!: { job: { status: JobSnapshot['status'] } }
    let again!: { outcome: string; job: { status: JobSnapshot['status'] } }
    let listed!: Array<{ status: JobSnapshot['status'] }>
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]?.functions
      if (tools === undefined) throw new Error('tools binding missing')
      const admission = await tools.subagent?.({
        description: 'obsolete probe', prompt: 'probe', run_in_background: true,
      }) as { jobId: string }
      kill = await tools.job_kill?.({ job_id: admission.jobId, reason: 'no longer needed' }) as typeof kill
      output = await tools.job_output?.({ job_id: admission.jobId, wait: true }) as typeof output
      again = await tools.job_kill?.({ job_id: admission.jobId }) as typeof again
      listed = await tools.job_list?.({}) as typeof listed
      return { logs: [], value: null }
    }
    const run = await context!.tools.execute({
      callId: 'jobs-kill' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'kill the obsolete job', description: 'Kill obsolete job' },
      signal: new AbortController().signal,
      agent,
    })
    expect(run.isError).toBe(false)

    expect(kill.outcome).toBe('cancellation-requested')
    expect(output.job.status).toBe('killed')
    // A killed job is terminal: a second kill is a no-op, not a restart.
    expect(again.outcome).toBe('already-finished')
    expect(again.job.status).toBe('killed')
    expect(listed.map(job => job.status)).toEqual(['killed'])
    expect(starts).toBe(1)
    expect(disposed).toBe(1)
  })

  it('reports a failed job as terminal and never restarts it', async () => {
    let starts = 0
    let disposed = 0
    const { agent, runtime } = await bootJobs('rlm-jobs-failed', async () => {
      starts += 1
      return {
        id: SessionId(`child-failed-${starts}`),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'boom' }], stopReason: 'error' }),
        dispose: () => { disposed += 1; return Promise.resolve() },
      }
    })

    let first!: { job: { status: JobSnapshot['status'] } }
    let second!: { job: { status: JobSnapshot['status'] } }
    runtime.behavior = async (request) => {
      const tools = request.bindings[0]?.functions
      if (tools === undefined) throw new Error('tools binding missing')
      const admission = await tools.subagent?.({
        description: 'doomed work', prompt: 'fail', run_in_background: true,
      }) as { jobId: string }
      first = await tools.job_output?.({ job_id: admission.jobId, wait: true }) as typeof first
      // Reading a terminal job again reports the same settled status.
      second = await tools.job_output?.({ job_id: admission.jobId }) as typeof second
      return { logs: [], value: null }
    }
    const run = await context!.tools.execute({
      callId: 'jobs-failed' as never,
      name: RUN_CODE_NAME,
      arguments: { code: 'collect the failed job', description: 'Collect failed job' },
      signal: new AbortController().signal,
      agent,
    })
    expect(run.isError).toBe(false)

    expect(first.job.status).toBe('failed')
    expect(second.job.status).toBe('failed')
    // `failed` is terminal: no automatic restart happened anywhere in the flow.
    expect(starts).toBe(1)
    expect(disposed).toBe(1)
  })
})
