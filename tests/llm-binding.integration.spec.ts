import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

function promptOf(options: GenerateOptions): string {
  const message = options.messages.at(-1)
  const block = message?.content.find(item => item.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class QueryManyAdapter extends LlmAdapter {
  readonly submodelPrompts: string[] = []
  readonly aborted: string[] = []
  active = 0
  activeWhenRetryStarted: number | undefined
  private outerCalls = 0
  private resolveSlowStarted!: () => void
  private readonly slowStarted = new Promise<void>(resolve => { this.resolveSlowStarted = resolve })

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.tools !== undefined) {
      this.outerCalls += 1
      if (this.outerCalls === 1) {
        const code = `
          let caught = "";
          try { await agents.queryMany({ prompts: ["fail", "slow", "queued"] }); }
          catch (error) { caught = String(error); }
          let retried = await agents.queryMany({ prompts: ["retry"] });
          ({ caught, retried });
        `
        const id = ToolCallId('query-many-cell')
        const argumentsJson = JSON.stringify({ code })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'repl', argumentsDelta: argumentsJson }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'repl', arguments: argumentsJson } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks('done')
      return
    }

    const prompt = promptOf(options)
    this.submodelPrompts.push(prompt)
    this.active += 1
    try {
      if (prompt === 'slow') {
        this.resolveSlowStarted()
        await new Promise<void>(resolve => {
          const onAbort = (): void => {
            this.aborted.push(prompt)
            resolve()
          }
          if (options.signal?.aborted) onAbort()
          else options.signal?.addEventListener('abort', onAbort, { once: true })
        })
        await new Promise(resolve => setTimeout(resolve, 10))
        throw new Error('slow aborted')
      }
      if (prompt === 'fail') {
        await this.slowStarted
        throw new Error('original failure')
      }
      if (prompt === 'retry') {
        this.activeWhenRetryStarted = this.active - 1
        yield* textChunks('retry-ok')
        return
      }
      throw new Error(`queued prompt started: ${prompt}`)
    } finally {
      this.active -= 1
    }
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

describe('LLM bindings through the real Prime Realm', () => {
  it('drains a failed queryMany before a same-cell retry without tool dispatch', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-llm-binding-'))
    ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(primeRuntime, { stateDirectory: root })
    await ctx.plugin(primeAgent, {
      stateDirectory: root,
      requireOrchestrationTools: false,
      llm: { maxConcurrency: 2 },
    })
    const adapter = new QueryManyAdapter()
    ctx.llm.registerAdapter(['query-many-integration'], adapter)
    const agent = ctx.agentLoop.create(SessionId('query-many-integration'), {
      provider: 'query-many-integration',
      model: 'model',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the batch.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.submodelPrompts).toEqual(['fail', 'slow', 'retry'])
    expect(adapter.aborted).toEqual(['slow'])
    expect(adapter.activeWhenRetryStarted).toBe(0)
    expect(adapter.active).toBe(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/code-dispatch')).toHaveLength(0)
    const result = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
    expect(JSON.stringify(result?.data)).toContain('prompts[0]')
    expect(JSON.stringify(result?.data)).toContain('retry-ok')
  })
})
