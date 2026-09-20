import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, isAgentLoopRequest, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
// @ts-expect-error The executable evaluation helper is intentionally plain JavaScript.
import { aggregateModelUsage } from '../scripts/eval/model-usage.mjs'
import * as contextManager from '../src/context-manager.js'
import { TaskNotes } from '../src/context/notes.js'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

type Attribution = 'main' | 'query' | 'unknown'
type Outcome = 'success' | 'failure' | 'aborted' | 'unknown'
interface UsageRecord {
  callId: string
  attribution: Attribution
  provider: string
  model: string
  outcome: Outcome
  usage?: TokenUsage
}
interface FixtureSource { version: number; value: string; evidenceId: string; material: string }
interface Commit { decision: string; evidenceIds: string[] }
interface ScenarioState { source: FixtureSource; commits: Commit[] }
interface EvaluationControl {
  readonly faults: { failures: number; truncations: number }
  readonly limits: { deadlineMs: number; maxMainCalls: number; maxTotalCalls: number }
  arm(agent: Agent): void
  stop(): void
}

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function registerFixtures(context: Context, state: ScenarioState): void {
  context.tools.register(defineTool({
    name: 'fixture_read',
    description: 'Read the current versioned task source. The evidenceId identifies the source fact used for a decision.',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => ({ ...state.source }),
  }))
  context.tools.register(defineTool({
    name: 'fixture_commit',
    description: 'Commit the final business decision once, with every evidenceId that supports it.',
    parameters: {
      decision: { type: 'string', required: true },
      evidenceIds: { type: 'array', items: { type: 'string' }, required: true },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async args => {
      const commit = { decision: args.decision, evidenceIds: [...args.evidenceIds] }
      state.commits.push(commit)
      return { accepted: true, commitNumber: state.commits.length, ...commit }
    },
  }))
}

function injectedTruncation(): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'The decision appears to be allow, but the source review is incom' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The decision appears to be allow, but the source review is incom' } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })()
}

function injectedFailure(): AsyncIterable<StreamChunk> {
  return (async function* () {
    throw new Error('injected query transport failure')
  })()
}

function observeCalls(
  context: Context,
  records: UsageRecord[],
  queryFaults: boolean,
): EvaluationControl {
  const limits = { deadlineMs: 120_000, maxMainCalls: 12, maxTotalCalls: 16 }
  const faults = { failures: 0, truncations: 0 }
  let serial = 0
  let mainCalls = 0
  let queryAttempt = 0
  let agent: Agent | undefined
  let deadline: NodeJS.Timeout | undefined
  context.on('llm/stream', (options, next) => {
    const attribution: Attribution = isAgentLoopRequest(options) ? 'main' : 'query'
    const callId = `model-eval-${++serial}`
    if (attribution === 'main') mainCalls++

    return (async function* () {
      let usage: TokenUsage | undefined
      let outcome: Outcome = 'unknown'
      try {
        if (mainCalls > limits.maxMainCalls || serial > limits.maxTotalCalls) {
          agent?.cancel({ kind: 'hook', reason: 'model evaluation call budget exceeded' })
          throw new Error(`model evaluation call budget exceeded: main=${mainCalls}, total=${serial}`)
        }
        let source: AsyncIterable<StreamChunk>
        if (queryFaults && attribution === 'query') {
          queryAttempt++
          if (queryAttempt === 1) {
            faults.failures++
            source = injectedFailure()
          } else if (queryAttempt === 2) {
            faults.truncations++
            source = injectedTruncation()
          } else source = next()
        } else source = next()
        for await (const chunk of source) {
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'finish') {
            outcome = chunk.reason.kind === 'error'
              ? 'failure'
              : chunk.reason.kind === 'aborted'
                ? 'aborted'
                : ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind) ? 'success' : 'unknown'
          }
          yield chunk
        }
      } catch (error) {
        outcome = options.signal?.aborted === true ? 'aborted' : 'failure'
        throw error
      } finally {
        records.push({ callId, attribution, provider: options.provider, model: options.model, outcome, ...(usage === undefined ? {} : { usage }) })
      }
    })()
  })
  return {
    faults,
    limits,
    arm(subject) {
      agent = subject
      deadline = setTimeout(() => subject.cancel({ kind: 'hook', reason: 'model evaluation deadline exceeded' }), limits.deadlineMs)
    },
    stop() {
      if (deadline !== undefined) clearTimeout(deadline)
      deadline = undefined
    },
  }
}

async function setup(scenario: string, source: FixtureSource, queryFaults = false) {
  root = await mkdtemp(join(tmpdir(), `prime-model-${scenario}-`))
  const stateDirectory = join(root, 'state')
  const state: ScenarioState = { source, commits: [] }
  const records: UsageRecord[] = []
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: 'Complete the task through the persistent TypeScript REPL. Treat fixture evidence IDs and commit decisions as exact business data.' },
  })
  await ctx.plugin(TokenMeter)
  await ctx.plugin(LocalSpillStore, { root: join(root, 'spill'), cleanupPeriodDays: 0 })
  await ctx.plugin(SpillPolicy, { maxInlineBytes: 12_000 })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek)
  await ctx.plugin(primeRuntime, { stateDirectory })
  registerFixtures(ctx, state)
  await ctx.plugin(primeAgent, {
    stateDirectory,
    requireOrchestrationTools: false,
    llm: { maxTokens: 1024 },
  })
  await ctx.plugin(contextManager, { stateDirectory, thresholdRatio: 0.99, retainTokens: 2000 })
  const control = observeCalls(ctx, records, queryFaults)
  const agent = await ctx.agentLoop.create(SessionId(`context-engineering-${scenario}`), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxTokens: 2048,
  })
  control.arm(agent)
  return { context: ctx, agent, state, records, stateDirectory, control }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
}

async function assessed(
  scenario: string,
  records: UsageRecord[],
  state: ScenarioState,
  agent: Agent,
  control: EvaluationControl,
  startedAt: number,
  body: () => void | Promise<void>,
): Promise<void> {
  let passed = false
  try {
    await body()
    passed = true
  } finally {
    control.stop()
    if (agent.status !== 'idle') agent.cancel({ kind: 'hook', reason: 'model evaluation finished' })
    await agent.whenIdle()
    console.log(JSON.stringify({
      scenario,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      durationMs: Date.now() - startedAt,
      business: { passed, commits: state.commits },
      limits: control.limits,
      injectedFaults: control.faults,
      usage: aggregateModelUsage(records),
    }))
  }
}

const runModel = process.env.DSH_RUN_MODEL_E2E === '1' && Boolean(process.env.DEEPSEEK_API_KEY)

describe.skipIf(!runModel)('Prime context-engineering tasks with a real DeepSeek model', () => {
  it('refreshes a changed source instead of committing a stale value', async () => {
    const startedAt = Date.now()
    const fixture: FixtureSource = { version: 1, value: 'release-1', evidenceId: 'SOURCE-V1', material: 'The current release is release-1.' }
    const { agent, state, records, control } = await setup('stale-source', fixture)
    await assessed('stale-source', records, state, agent, control, startedAt, async () => {
      await send(agent, 'Read fixture_read and retain its versioned value for a later decision. Do not call fixture_commit yet.')
      state.source = { version: 2, value: 'release-2', evidenceId: 'SOURCE-V2', material: 'The current release changed to release-2.' }
      await send(agent, 'The source changed after your earlier read. Re-read it, then call fixture_commit exactly once with the current value as decision and its current evidenceId.')
      expect(state.commits).toEqual([{ decision: 'release-2', evidenceIds: ['SOURCE-V2'] }])
    })
  }, 180_000)

  it('preserves a decisive negative condition in long material', async () => {
    const startedAt = Date.now()
    const padding = 'Routine approval evidence. '.repeat(700)
    const material = `${padding}\nEVIDENCE-NEG-77: DENY_DEPLOY is active for this release.\n${padding}`
    const { agent, state, records, control } = await setup('negative-exception', { version: 1, value: 'candidate', evidenceId: 'EVIDENCE-NEG-77', material })
    await assessed('negative-exception', records, state, agent, control, startedAt, async () => {
      await send(agent, 'Read fixture_read. Commit decision "allow" only if its complete material has no active DENY_DEPLOY condition; otherwise commit "block". Include the decisive evidenceId and commit exactly once.')
      expect(state.commits).toEqual([{ decision: 'block', evidenceIds: ['EVIDENCE-NEG-77'] }])
    })
  }, 180_000)

  it('recovers from failed and truncated query results before committing', async () => {
    const startedAt = Date.now()
    const padding = 'Candidate appears routine. '.repeat(500)
    const material = `${padding}\nEVIDENCE-QUERY-9: DENY_DEPLOY remains active.\n${padding}`
    const { agent, state, records, control } = await setup('query-recovery', { version: 1, value: 'candidate', evidenceId: 'EVIDENCE-QUERY-9', material }, true)
    await assessed('query-recovery', records, state, agent, control, startedAt, async () => {
      await send(agent, 'Read fixture_read and use agents.query to assess whether its complete material permits deployment. A failed call or truncated:true reply is incomplete: recover using the source and retry or narrow the request as needed. Then commit "allow" or "block" once with the decisive evidenceId.')
      expect(state.commits).toEqual([{ decision: 'block', evidenceIds: ['EVIDENCE-QUERY-9'] }])
      expect(records.some(record => record.attribution === 'query' && record.outcome === 'failure')).toBe(true)
      expect(control.faults).toEqual({ failures: 1, truncations: 1 })
    })
  }, 180_000)

  it('recovers task evidence across a host-requested window switch with stale notes', async () => {
    const startedAt = Date.now()
    const material = `${'Window evidence context. '.repeat(1200)}\nWINDOW-EVIDENCE-9001: the safe resumed decision is resume-safe.`
    const { context, agent, state, records, stateDirectory, control } = await setup('window-recovery', { version: 1, value: 'resume-safe', evidenceId: 'WINDOW-EVIDENCE-9001', material })
    await assessed('window-recovery', records, state, agent, control, startedAt, async () => {
      await send(agent, `Read fixture_read and identify the decision and evidenceId needed later. Do not commit yet. ${'Older turn padding. '.repeat(1600)}`)
      const notes = new TaskNotes(stateDirectory)
      const current = await notes.read(agent.session.id)
      await notes.write(agent.session.id, {
        revision: current.revision,
        content: 'STALE: this note predates the latest evidence and must be recovered from history.',
        updatedAtSessionOffset: agent.session.seq,
      }, new AbortController().signal)
      const compacted = await context.compaction.compactNow(agent, new AbortController().signal)
      expect(compacted).not.toBeNull()
      await send(agent, 'Continue the task after the window switch. Recover any needed evidence, verify the current source, and call fixture_commit exactly once with the supported decision and evidenceId.')
      expect(state.commits).toEqual([{ decision: 'resume-safe', evidenceIds: ['WINDOW-EVIDENCE-9001'] }])
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
    })
  }, 180_000)
})
