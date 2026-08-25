import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'

function toolCallResponse(rawCallId: string, code: string): StreamChunk[] {
  const id = CallId(rawCallId)
  const argumentsJson = JSON.stringify({ code })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'repl', argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'repl', arguments: argumentsJson } },
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
  it('keeps live bindings while every model request and outer call uses only repl', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-agent-loop-'))
    const stateDirectory = join(root, 'state')
    const overrideFile = join(root, 'replay.override.json')
    const script: ReplayEntry[] = [
      { kind: 'chunks', chunks: toolCallResponse('store-secret', 'const secret = 424242; "stored"') },
      { kind: 'chunks', chunks: textResponse('stored') },
      { kind: 'chunks', chunks: toolCallResponse('read-secret', 'secret') },
      { kind: 'chunks', chunks: textResponse('424242') },
      { kind: 'chunks', chunks: toolCallResponse('spill-large', '"SPILL-".repeat(1000)') },
      { kind: 'chunks', chunks: textResponse('spilled') },
    ]
    await writeFile(overrideFile, JSON.stringify(script))

    ctx = new Context()
    // Native tool presentation: the Prime plugin itself owns the `repl` surface.
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalSpillStore, { root: join(root, 'spill') })
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 1024 })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(primeRuntime, { stateDirectory })
    await ctx.plugin(primeAgent, { stateDirectory, requireOrchestrationTools: false })
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
    await send(ctx, agent, 'Store the sentinel with repl.')
    await send(ctx, agent, 'Read the sentinel with repl.')
    await send(ctx, agent, 'Return the large report with repl.')
    replay.assertConsumed()

    expect(requests).toHaveLength(6)
    for (const request of requests) {
      expect(request.tools?.map(tool => tool.name)).toEqual(['repl'])
    }
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) {
      expect(header.data.header.tools?.map(tool => tool.name)).toEqual(['repl'])
    }

    const calls = agent.session.events.filter(event => event.type === 'tool/call')
    expect(calls).toHaveLength(3)
    expect(calls.every(event => event.data.name === 'repl')).toBe(true)

    const results = agent.session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(3)
    const scalar = results[1]?.type === 'tool/result'
      ? results[1].data.message.content
        .filter(block => block.type === 'tool-result')
        .flatMap(block => block.content)
        .filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(scalar).toBe('424242')
    expect(scalar).not.toContain('{"logs"')
    // The DURABLE outer `tool/result` the agent loop committed for the
    // oversized completion is bounded — preview plus locator, never the full
    // body — and the artifact recovers the complete rendered text.
    const body = 'SPILL-'.repeat(1000)
    expect(JSON.stringify(results[2]?.data.message)).not.toContain(body)
    const spilled = results[2]?.type === 'tool/result'
      ? results[2].data.message.content
        .filter(block => block.type === 'tool-result')
        .flatMap(block => block.content)
        .filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(spilled).toContain('Full formatted result stored at:')
    expect(Buffer.byteLength(spilled, 'utf8')).toBeLessThanOrEqual(1024)
    const locator = /Full formatted result stored at: (.+?)\. Use read with/.exec(spilled)?.[1]
    if (locator === undefined) throw new Error(`no spill locator in: ${spilled.slice(-300)}`)
    expect(await readFile(locator, 'utf8')).toBe(body)

    // No handshake/bootstrap dispatch exists any more: the realm is routed by
    // the plugin's own identity resolution, and nothing probes a bootstrap tool.
    const dispatches = agent.session.events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches).toHaveLength(0)

    const final = agent.session.events.findLast(event => event.type === 'assistant/message')
    const finalText = final?.type === 'assistant/message'
      ? final.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(finalText).toBe('spilled')
  })
})