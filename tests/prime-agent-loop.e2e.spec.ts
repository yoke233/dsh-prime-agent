import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { installLlmReplay, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { registerRealmIdentity } from '../src/realm/identity-tool.js'
import * as primeRuntime from '../src/runtime.js'

function toolCallResponse(rawCallId: string, code: string): StreamChunk[] {
  const id = CallId(rawCallId)
  const argumentsJson = JSON.stringify({ code, description: 'Prime agent-loop E2E step' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: RUN_CODE_NAME, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: RUN_CODE_NAME, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

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

describe('Prime realm across deterministic agent-loop turns', () => {
  it('keeps state while every model request and outer call uses only run_code', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-agent-loop-'))
    const stateDirectory = join(root, 'state')
    const overrideFile = join(root, 'replay.override.json')
    const script: ReplayEntry[] = [
      { kind: 'chunks', chunks: toolCallResponse('store-secret', 'state.secret = 424242; return "stored"') },
      { kind: 'chunks', chunks: textResponse('stored') },
      { kind: 'chunks', chunks: toolCallResponse('read-secret', 'return state.secret') },
      { kind: 'chunks', chunks: textResponse('424242') },
    ]
    await writeFile(overrideFile, JSON.stringify(script))

    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'code' } })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(primeRuntime, { stateDirectory })
    registerRealmIdentity(ctx, { stateDirectory })
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', (options, next) => {
      requests.push(options)
      return next()
    })
    const replay = installLlmReplay(ctx, {
      file: join(root, 'absent-session.jsonl'),
      overrideFile,
      providers: [{ id: 'prime-e2e', models: [{ id: 'scripted' }] }],
    })

    const agent = ctx.agentLoop.create(SessionId('prime-agent-loop'), {
      provider: 'prime-e2e',
      model: 'scripted',
    })
    await send(ctx, agent, 'Store the sentinel with run_code.')
    await send(ctx, agent, 'Read the sentinel with run_code.')
    replay.assertConsumed()

    expect(requests).toHaveLength(4)
    for (const request of requests) {
      expect(request.tools?.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    }
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) {
      expect(header.data.header.tools?.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    }

    const calls = agent.session.events.filter(event => event.type === 'tool/call')
    expect(calls).toHaveLength(2)
    expect(calls.every(event => event.data.name === RUN_CODE_NAME)).toBe(true)

    const results = agent.session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(JSON.stringify(results.at(-1)?.data.message)).toContain('424242')

    const handshakes = agent.session.events.filter(event => event.type === 'tool/code-dispatch'
      && event.data.name === 'prime_realm_identity')
    expect(handshakes).toHaveLength(2)

    const final = agent.session.events.findLast(event => event.type === 'assistant/message')
    const finalText = final?.type === 'assistant/message'
      ? final.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(finalText).toBe('424242')
  })
})
