import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_WINDOW_EXCEEDED_CODE, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { installLlmReplay, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as contextManager from '../src/context-manager.js'
import * as primeAgent from '../src/index.js'
import * as primeRuntime from '../src/runtime.js'
import { readHistory, searchHistory } from '../src/context/history.js'
import { TaskNotes } from '../src/context/notes.js'

let ctx: Context | undefined, root: string | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined })

function cell(code: string): ReplayEntry {
  const id = ToolCallId(`cell-${Math.random()}`), argumentsJson = JSON.stringify({ code })
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'repl', argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'repl', arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }
}
function answer(text = 'done'): ReplayEntry {
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return { kind: 'chunks', chunks }
}
async function setup(script: ReplayEntry[], thresholdRatio = 0.99, runtimeLimits: { maxWallMs?: number } = {}) {
  root = await mkdtemp(join(tmpdir(), 'prime-context-'))
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(primeRuntime, { stateDirectory: root, ...runtimeLimits })
  await ctx.plugin(primeAgent, { stateDirectory: root, requireOrchestrationTools: false })
  await ctx.plugin(contextManager, { stateDirectory: root, thresholdRatio, retainTokens: 3000 })
  const requests: GenerateOptions[] = []
  ctx.on('llm/stream', (options, next) => { requests.push(options); return next() })
  const overrideFile = join(root, 'replay.json')
  await writeFile(overrideFile, JSON.stringify(script))
  const replay = installLlmReplay(ctx, {
    file: join(root, 'absent.jsonl'), overrideFile,
    providers: [{ id: 'context-test', models: [{ id: 'model', contextWindow: 100000 }] }],
  })
  const agent = ctx.agentLoop.create(SessionId('context-owner'), { provider: 'context-test', model: 'model' })
  return { context: ctx, agent, requests, replay }
}
async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason).toEqual({ kind: 'completed' })
}
function summaries(agent: Agent) { return agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary') }

describe('Prime history window on the real DSH loop', () => {
  it('keeps a small window usable when a requested rotation would increase its size', async () => {
    const { agent, replay } = await setup([cell('await tools.new_context({})'), answer()])
    await send(agent, 'small task')
    replay.assertConsumed()
    expect(summaries(agent)).toHaveLength(0)
    expect(searchHistory(agent.session, 'small task').hits.length).toBeGreaterThan(0)
  })
  it('rotates after a settled cell, keeps the Realm, and recovers evidence and persisted notes without a model summary', async () => {
    const { agent, requests, replay } = await setup([
      cell('let retained = 777; let n = await tools.notes_read({}); await tools.notes_write({ revision:n.revision, content:"Goal: retain the blue exception; evidence is in the initial user message" }); "x".repeat(12000)'),
      cell('await tools.new_context({})'),
      cell('let hits = await tools.history_search({query:"BLUE-EXCEPTION"}); let original = await tools.history_read({seq:hits.hits.at(-1).seq}); let note = await tools.notes_read({}); if (retained !== 777 || !original.text.includes("BLUE-EXCEPTION") || !note.content.includes("blue exception")) throw new Error("lost task state"); ({retained, hasEvidence:true, note:note.content})'),
      answer(),
    ])
    await send(agent, `BLUE-EXCEPTION: do not modify blue. ${'source-data '.repeat(4000)}`)
    replay.assertConsumed()
    expect(requests).toHaveLength(4)
    expect(requests.every(request => request.tools?.length === 1 && request.tools[0]?.name === 'repl')).toBe(true)
    expect(summaries(agent)).toHaveLength(1)
    expect(summaries(agent)[0]!.data.llmStreamCall).toBeUndefined()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results.every(result => !result.data.message.content[0].isError)).toBe(true)
    expect(JSON.stringify(results.at(-1)!.data)).toContain('777')
    expect(JSON.stringify(results.at(-1)!.data)).toContain('hasEvidence')
    expect(requests[2]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text.length > 40000))).toBe(false)
    const restored = Session.fromRestore(agent.session.id, agent.session.snapshotEvents(), agent.session.header, agent.session.inheritedEventCount)
    const original = searchHistory(restored, 'BLUE-EXCEPTION').hits.find(hit => hit.kind === 'user/message')!
    expect(readHistory(restored, original.seq).text).toContain('BLUE-EXCEPTION')
    expect((await new TaskNotes(root!).read(agent.session.id)).content).toContain('blue exception')
  })

  it('automatically reduces pressure and supports manual rotation without invoking a summarizer', async () => {
    const { context, agent, requests, replay } = await setup([cell('let alive = 91; "new-tail".repeat(2000)'), answer(), answer('later')], 0.2)
    await send(agent, 'evidence '.repeat(12000))
    expect(summaries(agent).length).toBeGreaterThan(0)
    expect(requests).toHaveLength(2)
    // Give manual rotation a useful completed span while preserving the last message.
    await send(agent, 'more evidence '.repeat(2000))
    const before = requests.length
    const result = await context.compaction.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    expect(requests).toHaveLength(before)
    expect(result!.shadowedSeqs.length).toBeGreaterThan(0)
    replay.assertConsumed()
  })

  it('recovers canonical provider overflow with a balanced window and no auxiliary model request', async () => {
    const { agent, requests, replay } = await setup([
      cell('let alive = 42; "tail"'),
      { kind: 'throw', chunks: [], message: 'too large', code: CONTEXT_WINDOW_EXCEEDED_CODE },
      cell('alive'), answer(),
    ])
    await send(agent, 'older raw evidence '.repeat(3000))
    replay.assertConsumed()
    expect(summaries(agent)).toHaveLength(1)
    expect(requests).toHaveLength(4)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').every(event => event.data.error === undefined)).toBe(true)
  })

  // Replay proves that recovery remains possible; the opt-in model suite checks
  // whether a model chooses the right evidence without a scripted trajectory.
  it.each(['empty', 'stale'] as const)('recovers an older correction after repeated automatic rotations with %s notes', async noteState => {
    const originalLimit = 9, correctedLimit = 5
    const initial = noteState === 'stale'
      ? `let allocation = ${originalLimit}; await tools.notes_write({revision:0,content:"Allocate ${originalLimit} units"}); "prepared"`
      : `let allocation = ${originalLimit}; "prepared"`
    const recovery = `
      let previousNote = await tools.notes_read({});
      let matches = [], before;
      do {
        let page = await tools.history_search({query:"ALLOCATION-CORRECTION", ...(before === undefined ? {} : {before})});
        matches.push(...page.hits.filter(hit => hit.kind === "user/message"));
        before = page.nextBefore;
      } while (before !== null);
      let source = matches[0];
      let encoded = "", offset = 0;
      do {
        let page = await tools.history_read({seq:source.seq,offset});
        encoded += page.text;
        offset = page.nextOffset;
      } while (offset !== null);
      let correction = JSON.parse(encoded).content.find(block => block.type === "text").text;
      allocation = Number(correction.match(/current limit=(\\d+)/)[1]);
      await tools.notes_write({revision:previousNote.revision,content:JSON.stringify({limit:allocation,evidence:source.seq})});
      await tools.commit_allocation({limit:allocation,evidence:source.seq});
    `
    const { context, agent, requests, replay } = await setup([
      cell(initial), answer(), answer(),
      ...Array.from({ length: 10 }, () => answer()),
      cell(recovery), answer(),
    ], 0.2)
    const commits: { limit: number; evidence: number }[] = []
    context.tools.register(defineTool({
      name: 'commit_allocation', description: 'Commit the allocation with its recorded source address.',
      parameters: { limit: { type: 'integer', required: true }, evidence: { type: 'integer', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { commits.push(args); return args },
    }))
    await send(agent, `Prepare an allocation of ${originalLimit} units, subject to later corrections.`)
    await send(agent, `ALLOCATION-CORRECTION: current limit=${correctedLimit}; this replaces the previous allocation. ${'source detail '.repeat(1000)}`)
    const correctionEvent = agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.startsWith('ALLOCATION-CORRECTION')))
    expect(correctionEvent).toBeDefined()
    for (let index = 0; index < 10; index++) {
      await send(agent, `Background material ${index}. ${'unrelated reference '.repeat(1500)}`)
    }
    expect(summaries(agent).length).toBeGreaterThanOrEqual(2)
    const noteBefore = await new TaskNotes(root!).read(agent.session.id)
    expect(noteBefore.content).toBe(noteState === 'empty' ? '' : `Allocate ${originalLimit} units`)
    // Neither the recent tail nor the eight-address directory carries this
    // correction now. It must be recovered from the original event log.
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('ALLOCATION-CORRECTION')
    await send(agent, 'Finish the allocation using the latest applicable correction and record its evidence address.')
    replay.assertConsumed()
    expect(commits).toEqual([{ limit: correctedLimit, evidence: correctionEvent!.seq }])
    expect(JSON.parse((await new TaskNotes(root!).read(agent.session.id)).content)).toEqual({ limit: correctedLimit, evidence: correctionEvent!.seq })
    expect(summaries(agent).every(event => event.data.llmStreamCall === undefined)).toBe(true)
    expect(requests).toHaveLength(15)
  })

  it('fails closed without an owner and does not mutate a cancelled manual window', async () => {
    const { context, agent } = await setup([answer()])
    const result = await context.tools.execute({ callId: ToolCallId('ownerless'), name: 'notes_read', arguments: {}, signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    await send(agent, 'evidence '.repeat(3000))
    const before = agent.session.seq
    expect(() => context.compaction.compactNow(agent, AbortSignal.abort(new Error('cancelled')))).toThrow('cancelled')
    expect(agent.session.seq).toBe(before)
  })

  it('recovers notes and recorded evidence after a Worker hard kill without pretending the old heap survived', async () => {
    const { agent, replay } = await setup([
      cell('let oldHeap = 19; await tools.notes_write({revision:0,content:"Resume from source proof"}); "saved"'),
      cell('for (;;) {}'),
      cell('let note = await tools.notes_read({}); let hits = await tools.history_search({query:"source proof"}); if (typeof oldHeap !== "undefined" || note.content !== "Resume from source proof" || hits.hits.length === 0) throw new Error("recovery failed"); "recovered"'),
      answer(),
    ], 0.99, { maxWallMs: 800 })
    await send(agent, 'Keep this source proof after a restart.')
    replay.assertConsumed()
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results.filter(result => result.data.message.content[0].isError)).toHaveLength(1)
    expect(results.at(-1)!.data.message.content[0].isError).toBe(false)
  })
})
