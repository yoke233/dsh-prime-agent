import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerContinual } from '../src/continual/plugin.js'
import * as RefineSkillProvider from '../src/refine-skill-provider.js'
import type { HarnessLimits } from '../src/continual/types.js'

const limits: HarnessLimits = {
  maxEntriesPerScope: 16, maxEntryIdChars: 64, maxEntryTitleChars: 100, maxEntryContentChars: 1000,
  maxReferenceToolChars: 64, maxEvidenceItems: 8, maxEvidenceChars: 500, maxEditsPerTransaction: 8,
  maxTransactions: 8, maxStateBytes: 65536, maxPromptEntriesPerScope: 16, maxPromptCharsPerScope: 8000,
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
  constructor(private readonly outputs: string[]) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const output = this.outputs.shift()
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

describe('refine skill scheduler', () => {
  it('queues one request, refines at turn stop, and resumes with the result', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-refine-skill-'))
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(RefineSkillProvider)
    const adapter = new QueueAdapter([JSON.stringify({ rationale: 'No stable change.', edits: [] })])
    ctx.llm.registerAdapter(['test'], adapter)
    const continual = registerContinual(ctx, {
      stateDirectory: join(root, 'continual'), allowGlobal: false, limits,
      maxTokens: 2048, maxConversationChars: 10000,
    })
    const session = ctx.sessions.create(SessionId('refine-skill-agent'))
    const steered: UserMessage[] = []
    const agent = {
      id: session.id, session, options: { provider: 'test', model: 'model' }, status: 'running', ctx,
      steer: (message: UserMessage) => { steered.push(message) },
    } as unknown as Agent
    const signal = new AbortController().signal
    const host = continual.bindingFor(agent).functions
    const status = host.status!
    const run = host.run!

    expect(ctx.tools.get('refine', agent)).toBeUndefined()
    expect(await status({})).toEqual({ pending: false, in_flight: false })
    expect(await run({ instructions: 'first focus' })).toEqual({ pending: true, in_flight: false, scheduled: true })
    await run({ instructions: 'updated focus' })
    expect(await status({})).toEqual({ pending: true, in_flight: false })

    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('updated focus')
    expect(steered).toHaveLength(1)
    expect(JSON.stringify(steered[0])).toContain('No refinement applied')

    const repeated = await run({})
    expect(repeated).toMatchObject({ scheduled: false, reason: 'refinement already ran for this turn' })
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    const nextTurn = await run({})
    expect(nextTurn).toMatchObject({ pending: true, scheduled: true })

    const skill = await ctx.skills.get('refine', { scope: agent })
    expect(skill?.content).toContain('await refine.run()')
    const global = await run({ scope: 'global' })
    expect(global).toMatchObject({ scheduled: false, reason: 'global refinement is disabled by deployment policy' })
  })
})
