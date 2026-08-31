/**
 * Continuable orchestration through the model-facing `repl` entry and the
 * cell-level `agents.*` / `jobs.*` aliases, over the real DSH subagent and job
 * services. The programs under test never name a subagent or job tool
 * directly: spawn/fork/list/send/interrupt and list/output/kill are the whole
 * model-visible surface.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { REPL_TOOL_NAME } from '../src/repl/bridge.js'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let root: string | undefined
let context: Context | undefined
let callNumber = 0

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  callNumber = 0
})

function ownerAgent(idValue: string): Agent {
  return context!.agentLoop.create(SessionId(idValue), {})
}

/** Query implementation needed by the official continuable-subagent catalog. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Run one cell through the sole model-facing entry and return its completion. */
async function completes(agent: Agent, code: string): Promise<{ logs: string[], result?: unknown }> {
  const execution = await context!.tools.execute({
    callId: ToolCallId(`continuable-orchestration-${++callNumber}`),
    name: REPL_TOOL_NAME,
    arguments: { code },
    signal: new AbortController().signal,
    agent,
  })
  if (execution.isError) throw new Error(`repl failed unexpectedly: ${execution.error.message}`)
  if (!isRecord(execution.value) || !Array.isArray(execution.value.logs)
    || !execution.value.logs.every(log => typeof log === 'string')) {
    throw new Error('invalid repl result')
  }
  return {
    logs: execution.value.logs as string[],
    ...('result' in execution.value ? { result: execution.value.result } : {}),
  }
}

/**
 * One scripted provider whose parallel-label foreground runs are gated behind
 * a barrier, so a test can prove the two spawns genuinely overlapped.
 */
function scriptedProvider(name: string, started: string[]): SubagentProvider {
  let releaseParallel: () => void = () => {}
  const parallelBarrier = new Promise<void>((resolve) => { releaseParallel = resolve })
  return {
    name,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: name === 'scripted-fork',
    async start(request) {
      if (request.label?.startsWith('parallel-')) {
        started.push(request.label)
        if (started.length === 2) releaseParallel()
        await parallelBarrier
        return {
          id: SessionId(`child-${request.label}`),
          localAgent: undefined,
          result: Promise.resolve({
            output: [{ type: 'text', text: `done ${request.label}` }], stopReason: 'completed',
          }),
          dispose: () => Promise.resolve(),
        }
      }
      // Foreground runs outside the parallel pair are not used by these tests.
      return {
        id: SessionId(`child-of-${request.parent.id}`),
        localAgent: undefined,
        result: new Promise<SubagentResult>(() => {}),
        dispose: () => Promise.resolve(),
      }
    },
    async prepareContinuable() { return {} },
  }
}

describe('continuable orchestration through the model-facing repl', () => {
  /** Boot the shipped continuable composition: real child materialization and the agents/jobs aliases. */
  async function bootContinuable(started: string[]): Promise<Agent> {
    root = await mkdtemp(join(tmpdir(), 'dsh-continuable-orchestration-'))
    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(AgentRegistry)
    await context.plugin(SubagentRuntime)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await context.plugin(AgentLoop, { agents: [] })
    await context.plugin(TestSessionQuery)
    await context.plugin(LocalJobRegistry)
    await context.plugin(ToolJobs, {})
    context.subagents.registerProvider(scriptedProvider('scripted', started))
    context.subagents.registerProvider(scriptedProvider('scripted-fork', started))
    await context.plugin(ToolSubagent, {
      provider: 'scripted', toolName: 'subagent', backgroundMode: 'continuable', maxDepth: 'provider-managed',
    })
    await context.plugin(ToolSubagent, {
      provider: 'scripted-fork', toolName: 'subagent_fork', backgroundMode: 'continuable', maxDepth: 'provider-managed',
    })
    await context.plugin(ToolSubagentControl)
    await context.plugin(ToolListAgents)
    await context.plugin(primeRuntime, { stateDirectory: join(root, 'state') })
    await context.plugin(primeAgent, { stateDirectory: join(root, 'state') })
    return ownerAgent('continuable-parent')
  }

  it('exposes only the documented agents and jobs aliases in every cell', async () => {
    const agent = await bootContinuable([])

    const surface = await completes(agent, `({ agents: Object.keys(agents).sort(), jobs: Object.keys(jobs).sort() })`)
    expect(surface.result).toEqual({
      agents: ['fork', 'interrupt', 'list', 'send', 'spawn'],
      jobs: ['kill', 'list', 'output'],
    })
  }, 30_000)

  it('starts independent foreground spawns concurrently through agents.spawn', async () => {
    const started: string[] = []
    const agent = await bootContinuable(started)

    const run = await completes(agent, `
      const results = await Promise.all([
        agents.spawn({ description: 'parallel-one', prompt: 'one', run_in_background: false }),
        agents.spawn({ description: 'parallel-two', prompt: 'two', run_in_background: false }),
      ])
      results.map(result => result.kind === 'foreground'
        ? result.output.filter(block => block.type === 'text').map(block => block.text).join('')
        : result.kind)
    `)
    const rows = run.result as string[]
    expect(started.sort()).toEqual(['parallel-one', 'parallel-two'])
    expect(rows).toEqual(['done parallel-one', 'done parallel-two'])
  }, 30_000)

  it('admits a continuable child, keeps its handle live, and manages it through the aliases', async () => {
    const agent = await bootContinuable([])

    // Admission returns a durable child id and the parent keeps working instead
    // of waiting for the child; the handle stays in the live namespace.
    const admitted = await completes(agent, `
      const child = await agents.spawn({ description: 'background research', prompt: 'Find the answer' })
      if (child.kind !== 'continuable') throw new Error('expected continuable child')
      const childId = child.subagentId
      const progress = ['parent kept working']
      const out = { child, childId, progress }
      out
    `)
    expect(admitted.result).toMatchObject({
      progress: ['parent kept working'],
      child: { kind: 'continuable', subagentId: expect.any(String) },
    })
    const admittedValue = admitted.result as { childId: string }
    expect(admittedValue.childId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)

    // The next cell still sees the handle and drives the child through the
    // roster, follow-up, and interrupt aliases — never through a job tool.
    const managed = await completes(agent, `
      const roster = await agents.list({})
      const sent = await agents.send({ subagent_id: childId, message: 'summarize the findings' })
      const stopped = await agents.interrupt({ agent_id: childId })
      const out = { roster, sent, stopped }
      out
    `)
    const managedValue = managed.result as {
      roster: Array<{ id: string }>,
      sent: { messageId: string },
      stopped: { accepted: boolean },
    }
    expect(managedValue.roster.some(item => item.id === admittedValue.childId)).toBe(true)
    expect(typeof managedValue.sent.messageId).toBe('string')
    expect(managedValue.stopped.accepted).toBe(true)
  }, 60_000)
})

describe('job ownership through the jobs aliases', () => {
  /** Boot the one-shot job composition; each test owns its child behavior. */
  async function bootJobs(idValue: string, start: SubagentProvider['start']): Promise<Agent> {
    root = await mkdtemp(join(tmpdir(), 'dsh-jobs-orchestration-'))
    context = new Context()
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(LlmRuntime)
    await context.plugin(SessionStore)
    await context.plugin(AgentRegistry)
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(AgentLoop, { agents: [] })
    await context.plugin(TestSessionQuery)
    await context.plugin(SubagentRuntime)
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
    await context.plugin(primeRuntime, { stateDirectory: join(root, 'state') })
    await context.plugin(primeAgent, { stateDirectory: join(root, 'state') })
    return ownerAgent(idValue)
  }

  it('kills an obsolete job, leaves no orphan, and never restarts it', async () => {
    let starts = 0
    let disposed = 0
    const agent = await bootJobs('jobs-parent', async (request) => {
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
    // cell with no sleeps: every await resolves off a jobs notification.
    const run = await completes(agent, `
      const admission = await agents.spawn({ description: 'obsolete probe', prompt: 'probe', run_in_background: true })
      if (admission.kind !== 'background') throw new Error('expected background job')
      const jobId = admission.jobId
      const kill = await jobs.kill({ job_id: jobId, reason: 'no longer needed' })
      const output = await jobs.output({ job_id: jobId, wait: true })
      const again = await jobs.kill({ job_id: jobId })
      const listed = await jobs.list({})
      const out = { admission, kill, output, again, listed }
      out
    `)
    const value = run.result as {
      admission: { kind: string, jobId: string },
      kill: { outcome: string, job: { status: string } },
      output: { job: { status: string } },
      again: { outcome: string, job: { status: string } },
      listed: Array<{ status: string }>,
    }
    expect(value.admission).toMatchObject({ kind: 'background', jobId: expect.stringMatching(/^subagent-/) })
    expect(value.kill.outcome).toBe('cancellation-requested')
    expect(value.output.job.status).toBe('killed')
    // A killed job is terminal: a second kill is a no-op, not a restart.
    expect(value.again).toMatchObject({ outcome: 'already-finished', job: { status: 'killed' } })
    expect(value.listed.some(job => job.status === 'killed')).toBe(true)
    expect(starts).toBe(1)
    expect(disposed).toBe(1)
  }, 30_000)

  it('reports a failed job as terminal and never restarts it', async () => {
    let starts = 0
    let disposed = 0
    const agent = await bootJobs('jobs-failed', async () => {
      starts += 1
      return {
        id: SessionId(`child-failed-${starts}`),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'boom' }], stopReason: 'error' }),
        dispose: () => { disposed += 1; return Promise.resolve() },
      }
    })

    const run = await completes(agent, `
      const admission = await agents.spawn({ description: 'doomed work', prompt: 'fail', run_in_background: true })
      if (admission.kind !== 'background') throw new Error('expected background job')
      const jobId = admission.jobId
      const first = await jobs.output({ job_id: jobId, wait: true })
      // Reading a terminal job again reports the same settled status.
      const second = await jobs.output({ job_id: jobId })
      const out = { first, second }
      out
    `)
    const value = run.result as { first: { job: { status: string } }, second: { job: { status: string } } }
    expect(value.first.job.status).toBe('failed')
    expect(value.second.job.status).toBe('failed')
    // `failed` is terminal: no automatic restart happened anywhere in the flow.
    expect(starts).toBe(1)
    expect(disposed).toBe(1)
  }, 30_000)
})
