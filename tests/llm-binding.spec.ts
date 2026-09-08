import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CodeBindingFunction } from '@deepseek-ai/dsh-code-runtime'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createLlmFunctions, LLM_BINDING_DEFAULTS, LLM_NAMESPACE_DOC, renderLlmMembers, type LlmBindingLimits } from '../src/llm/binding.js'

const limits: LlmBindingLimits = { maxPromptChars: 40, maxBatchSize: 4, maxConcurrency: 2, maxTokens: 256 }

function promptOf(options: GenerateOptions): string {
  const last = options.messages.at(-1)
  const block = last?.content.find(item => item.type === 'text')
  return block !== undefined && block.type === 'text' ? block.text : ''
}

/** Echoes every prompt back so reply order is verifiable independently of scheduling. */
class EchoAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  inFlight = 0
  peakInFlight = 0
  finishKind: 'stop' | 'max-tokens' = 'stop'
  failing = new Set<string>()

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.inFlight += 1
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight)
    try {
      await new Promise(resolve => setTimeout(resolve, 5))
      const prompt = promptOf(options)
      if (this.failing.has(prompt)) throw new Error(`refused ${prompt}`)
      const text = `echo:${prompt}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: this.finishKind } }
    } finally {
      this.inFlight -= 1
    }
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function harness(signal: AbortSignal = new AbortController().signal, adapter: EchoAdapter = new EchoAdapter()): Promise<{ agent: Agent; adapter: EchoAdapter; query: CodeBindingFunction; queryMany: CodeBindingFunction }> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['test'], adapter)
  const session = ctx.sessions.create(SessionId('llm-binding-agent'))
  const agent = { id: session.id, session, options: { provider: 'test', model: 'model' } } as unknown as Agent
  const functions = createLlmFunctions(ctx, agent, limits, signal)
  expect(Object.keys(functions)).toEqual(['query', 'queryMany'])
  return { agent, adapter, query: functions.query!, queryMany: functions.queryMany! }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

class FailingBatchAdapter extends EchoAdapter {
  readonly slowStarted = deferred()
  readonly allSlowStarted = deferred()
  readonly slowAborted = deferred()
  readonly releaseSlow = deferred()
  readonly settled: string[] = []
  private slowStarts = 0

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const prompt = promptOf(options)
    try {
      if (prompt.startsWith('slow')) {
        this.slowStarts += 1
        this.slowStarted.resolve()
        if (this.slowStarts === 2) this.allSlowStarted.resolve()
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            this.slowAborted.resolve()
            resolve()
          }
          if (options.signal?.aborted) onAbort()
          else options.signal?.addEventListener('abort', onAbort, { once: true })
        })
        await this.releaseSlow.promise
        throw new Error('slow aborted')
      }
      if (prompt === 'fail') {
        await this.slowStarted.promise
        throw new Error('original failure')
      }
      throw new Error(`queued prompt started: ${prompt}`)
    } finally {
      this.settled.push(prompt)
    }
  }
}

describe('agents.query / agents.queryMany bindings', () => {
  it('answers one prompt on the agent route with bounded maxTokens and the session id', async () => {
    const { agent, adapter, query } = await harness()
    const reply = await query({ prompt: 'hello', system: 'be brief', maxTokens: 9999 })
    expect(reply).toEqual({ text: 'echo:hello', truncated: false })
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(request.provider).toBe('test')
    expect(request.model).toBe('model')
    expect(request.system).toBe('be brief')
    expect(request.maxTokens).toBe(256)
    expect(request.sessionId).toBe(agent.session.id)
    expect(request.tools).toBeUndefined()
  })

  it('reports a reply cut at maxTokens as truncated rather than failing', async () => {
    const { adapter, query } = await harness()
    adapter.finishKind = 'max-tokens'
    expect(await query({ prompt: 'long' })).toEqual({ text: 'echo:long', truncated: true })
  })

  it('keeps queryMany replies in prompt order under the concurrency cap', async () => {
    const { adapter, queryMany } = await harness()
    const value = await queryMany({ prompts: ['a', 'b', 'c'], system: 'shared' }) as { replies: { text: string }[] }
    expect(value.replies.map(reply => reply.text)).toEqual(['echo:a', 'echo:b', 'echo:c'])
    expect(adapter.peakInFlight).toBeLessThanOrEqual(2)
    expect(adapter.requests.every(request => request.system === 'shared')).toBe(true)
  })

  it('names the failing prompt when one queryMany member is refused', async () => {
    const { adapter, queryMany } = await harness()
    adapter.failing.add('b')
    await expect(queryMany({ prompts: ['a', 'b'] })).rejects.toThrow(/prompts\[1\]: .*refused b/)
    adapter.failing.clear()
    await expect(queryMany({ prompts: ['retry'] })).resolves.toEqual({ replies: [{ text: 'echo:retry', truncated: false }] })
  })

  it('stops queued work, aborts in-flight siblings, and drains before reporting the original failure', async () => {
    const adapter = new FailingBatchAdapter()
    const { queryMany } = await harness(new AbortController().signal, adapter)
    const pending = queryMany({ prompts: ['fail', 'slow', 'queued-1', 'queued-2'] })
    await adapter.slowAborted.promise

    expect(adapter.requests.map(promptOf)).toEqual(['fail', 'slow'])
    expect(adapter.settled).toEqual(['fail'])
    let rejected = false
    void pending.catch(() => { rejected = true })
    await Promise.resolve()
    expect(rejected).toBe(false)

    adapter.releaseSlow.resolve()
    await expect(pending).rejects.toThrow(/prompts\[0\]: .*original failure/)
    expect(adapter.settled).toEqual(['fail', 'slow'])
  })

  it('propagates parent cancellation, drains the batch, and sends nothing when pre-cancelled', async () => {
    const controller = new AbortController()
    const adapter = new FailingBatchAdapter()
    const { queryMany } = await harness(controller.signal, adapter)
    const pending = queryMany({ prompts: ['slow', 'slow-2', 'queued-1'] })
    await adapter.allSlowStarted.promise
    controller.abort(new Error('turn cancelled'))
    await adapter.slowAborted.promise
    expect(adapter.requests.map(promptOf)).toEqual(['slow', 'slow-2'])
    adapter.releaseSlow.resolve()
    await expect(pending).rejects.toThrow('turn cancelled')

    const preCancelled = new AbortController()
    preCancelled.abort(new Error('already cancelled'))
    const session = ctx!.sessions.create(SessionId('llm-binding-pre-cancelled'))
    const preAgent = { id: session.id, session, options: { provider: 'test', model: 'model' } } as unknown as Agent
    const preFunctions = createLlmFunctions(ctx!, preAgent, limits, preCancelled.signal)
    await expect(preFunctions.queryMany!({ prompts: ['never'] })).rejects.toThrow('already cancelled')
    await expect(preFunctions.query!({ prompt: 'never either' })).rejects.toThrow('already cancelled')
    expect(adapter.requests.map(promptOf)).toEqual(['slow', 'slow-2'])
  })

  it('keeps cancellation scoped to the failing batch', async () => {
    const { adapter, queryMany } = await harness()
    adapter.failing.add('bad')
    const [failed, succeeded] = await Promise.allSettled([
      queryMany({ prompts: ['bad', 'peer'] }),
      queryMany({ prompts: ['independent'] }),
    ])
    expect(failed.status).toBe('rejected')
    expect(succeeded).toEqual({ status: 'fulfilled', value: { replies: [{ text: 'echo:independent', truncated: false }] } })
  })

  it('rejects arguments outside the budgets before any model call', async () => {
    const { adapter, query, queryMany } = await harness()
    await expect(query('hello')).rejects.toThrow('agents.query() takes one object argument')
    await expect(query({})).rejects.toThrow('prompt must be a non-empty string')
    await expect(query({ prompt: 'x'.repeat(41) })).rejects.toThrow('the limit is 40')
    await expect(query({ prompt: 'ok', temperature: 1 })).rejects.toThrow('unknown argument "temperature"')
    await expect(query({ prompt: 'ok', maxTokens: 0 })).rejects.toThrow('maxTokens must be a positive integer')
    await expect(queryMany({ prompts: [] })).rejects.toThrow('agents.queryMany() prompts must be a non-empty array')
    await expect(queryMany({ prompts: ['a', 'b', 'c', 'd', 'e'] })).rejects.toThrow('the limit is 4')
    await expect(queryMany({ prompts: ['a', 7] })).rejects.toThrow('prompts[1] must be a string')
    await expect(queryMany({ prompts: ['a', ' '] })).rejects.toThrow('prompts[1] must be a non-empty string')
    expect(adapter.requests).toHaveLength(0)
  })

  it('renders the members with their budgets for the generated agents declaration', () => {
    const lines = renderLlmMembers(LLM_BINDING_DEFAULTS)
    expect(lines).toContain('  query: (args: { prompt: string; system?: string; maxTokens?: number }) => Promise<{ text: string; truncated: boolean }>;')
    expect(lines).toContain('  queryMany: (args: { prompts: string[]; system?: string; maxTokens?: number }) => Promise<{ replies: { text: string; truncated: boolean }[] }>;')
    expect(LLM_NAMESPACE_DOC[0]).toBe('/**')
    expect(LLM_NAMESPACE_DOC.at(-1)).toBe(' */')
  })
})
