import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { parseRefineCommandOptions, registerRefineCommand } from '../src/continual/command.js'
import { HarnessStore } from '../src/continual/store.js'
import type { HarnessLimits } from '../src/continual/types.js'

const limits: HarnessLimits = {
  maxEntriesPerScope: 16,
  maxEntryIdChars: 64,
  maxEntryTitleChars: 100,
  maxEntryContentChars: 1000,
  maxReferenceToolChars: 64,
  maxEvidenceItems: 8,
  maxEvidenceChars: 500,
  maxEditsPerTransaction: 8,
  maxTransactions: 8,
  maxStateBytes: 65536,
  maxPromptEntriesPerScope: 16,
  maxPromptCharsPerScope: 8000,
}

function response(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class QueueAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly requested: Promise<void>
  private markRequested: () => void = () => {}

  constructor(private readonly outputs: Array<string | Promise<string>>) {
    super()
    this.requested = new Promise(resolve => { this.markRequested = resolve })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.markRequested()
    const output = await this.outputs.shift()
    if (output === undefined) throw new Error('missing test response')
    yield* response(output)
  }
}

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function harness(outputs: string[], allowGlobal = false): Promise<{ agent: Agent; store: HarnessStore; adapter: QueueAdapter }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-refine-command-'))
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  const adapter = new QueueAdapter(outputs)
  ctx.llm.registerAdapter(['test'], adapter)
  const store = new HarnessStore(join(root, 'continual'), limits)
  registerRefineCommand(ctx, store, { allowGlobal, limits, maxTokens: 2048, maxConversationChars: 10000 })
  const session = ctx.sessions.create(SessionId('refine-command-agent'))
  const agent = {
    id: session.id,
    session,
    options: { provider: 'test', model: 'model' },
    status: 'idle',
    ctx,
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
  } as unknown as Agent
  return { agent, store, adapter }
}

describe('/refine command', () => {
  it('parses manual and rollback forms', () => {
    expect(parseRefineCommandOptions(' --global focus on validation ')).toEqual({ scope: 'global', instructions: 'focus on validation' })
    expect(parseRefineCommandOptions('rollback tx-1 --global')).toEqual({ scope: 'global', rollbackId: 'tx-1' })
    expect(() => parseRefineCommandOptions('rollback')).toThrow('Usage: /refine')
  })

  it('runs a dedicated model review, commits edits, and reuses store rollback', async () => {
    const proposal = JSON.stringify({
      rationale: 'The correction repeated.',
      trigger: 'The user corrected the output format twice.',
      evidence: ['Correction in turn 2', 'Correction in turn 5'],
      expected_outcome: 'Future matching output preserves the requested order.',
      edits: [{ action: 'create', kind: 'memory', id: 'field-order', title: 'Preserve field order', content: 'Keep caller-provided field order.' }],
    })
    const { agent, store, adapter } = await harness([proposal])
    const signal = new AbortController().signal

    const execution = await ctx!.commands.execute(agent, '/refine focus on repeated corrections', [], signal)
    expect(execution?.result).toMatchObject({ kind: 'success' })
    const applied = await store.read('local', String(agent.id))
    expect(applied.revision).toBe(1)
    expect(applied.entries).toMatchObject([{ id: 'field-order', kind: 'memory' }])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'test', model: 'model', maxTokens: 2048, sessionId: agent.session.id })
    expect(adapter.requests[0]?.tools).toBeUndefined()

    const transactionId = applied.transactions[0]?.id
    expect(transactionId).toBeDefined()
    const rollback = await ctx!.commands.execute(agent, `/refine rollback ${transactionId}`, [], signal)
    expect(rollback?.result).toMatchObject({ kind: 'success' })
    expect((await store.read('local', String(agent.id))).entries).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  })

  it('logs a running command node before the model review settles', async () => {
    const proposal = JSON.stringify({ rationale: 'No stable lesson.', edits: [] })
    let release: (value: string) => void = () => {}
    const pendingOutput = new Promise<string>(resolve => { release = resolve })
    const { agent, adapter } = await harness([pendingOutput])
    const signal = new AbortController().signal

    const execution = ctx!.commands.execute(agent, '/refine', [], signal)
    await adapter.requested
    try {
      const running = agent.session.snapshotEvents().filter(event => event.type === 'command/run').at(-1)
      expect(running).toMatchObject({ type: 'command/run', data: { name: 'refine' } })
      expect(agent.session.snapshotEvents().some(event => event.type === 'command/done')).toBe(false)
    } finally {
      release(proposal)
    }

    const settled = await execution
    const done = agent.session.snapshotEvents().filter(event => event.type === 'command/done').at(-1)
    expect(done).toMatchObject({
      type: 'command/done',
      data: { commandId: settled?.commandId, kind: 'success' },
    })
  })

  it('accepts a no-op proposal and rejects disabled global writes before calling the model', async () => {
    const { agent, store, adapter } = await harness([JSON.stringify({ rationale: 'No stable lesson.', edits: [] })])
    const signal = new AbortController().signal
    const noop = await ctx!.commands.execute(agent, '/refine', [], signal)
    expect(noop?.result).toEqual({ kind: 'success', text: 'No refinement applied: No stable lesson.' })
    expect((await store.read('local', String(agent.id))).revision).toBe(0)

    const denied = await ctx!.commands.execute(agent, '/refine --global', [], signal)
    expect(denied?.result).toEqual({ kind: 'error', text: 'Global refinement is disabled by deployment policy.' })
    expect(adapter.requests).toHaveLength(1)
  })
})
