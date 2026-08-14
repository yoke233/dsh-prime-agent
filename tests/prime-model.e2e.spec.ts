import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { registerRealmIdentity } from '../src/realm/identity-tool.js'
import * as primeRuntime from '../src/runtime.js'

const SENTINEL = 'prime-model-424242'

function waitForIdle(context: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = context.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

async function send(context: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(context, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('Prime realm with a real DeepSeek model', () => {
  it('retains state across two agent turns while exposing only run_code', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-model-'))
    const stateDirectory = join(root, 'state')

    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {
      persona: 'You are testing persistent Code Mode state. Follow the user instructions exactly.',
    })
    await ctx.plugin(ToolRuntime, { mode: 'code' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LlmDeepSeek)
    await ctx.plugin(primeRuntime, { stateDirectory })
    registerRealmIdentity(ctx, { stateDirectory })

    const agent = ctx.agentLoop.create(SessionId('prime-real-model'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await send(
      ctx,
      agent,
      `Use one run_code program to set state.secret to "${SENTINEL}" and return it. After the tool result, reply exactly STORED.`,
    )
    await send(
      ctx,
      agent,
      'Use one run_code program to return state.secret. Reply with exactly the returned value.',
    )

    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) {
      expect(header.data.header.tools?.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    }

    const calls = agent.session.events.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every(event => event.data.name === RUN_CODE_NAME)).toBe(true)

    const final = agent.session.events.findLast(event => event.type === 'assistant/message')
    const finalText = final?.type === 'assistant/message'
      ? final.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(finalText).toContain(SENTINEL)
  }, 120_000)
})
