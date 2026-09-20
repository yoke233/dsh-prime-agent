import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { aggregateModelUsage, parseInputPaths, readSessionLog, recordsFromSessionEvents } from '../scripts/eval/model-usage.mjs'

let temporary: string | undefined
afterEach(async () => {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
})

describe('model usage evaluation', () => {
  it('separates attribution and failed usage without turning missing fields into zero', () => {
    const report = aggregateModelUsage([
      { callId: 'main-1', attribution: 'main', outcome: 'success', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 75 } },
      { callId: 'query-1', attribution: 'query', outcome: 'failure', usage: { inputTokens: 40, outputTokens: 3 } },
      { callId: 'child-1', attribution: 'child', outcome: 'aborted' },
      { callId: 'unknown-1', attribution: 'not-real', outcome: 'not-real' },
    ])

    expect(report.calls).toBe(4)
    expect(report.failed.calls).toBe(2)
    expect(report.failed.usage.fields.inputTokens).toEqual({ sum: 40, knownCalls: 1, unknownCalls: 1 })
    expect(report.usage.fields.cacheReadTokens).toEqual({ sum: 75, knownCalls: 1, unknownCalls: 3 })
    expect(report.usage.fields.cacheWriteTokens.sum).toBeNull()
    expect(report.byAttribution.query.outcomes.failure).toBe(1)
    expect(report.byAttribution.unknown.calls).toBe(1)
    expect(report.billing).toEqual({ status: 'unknown' })
  })

  it('deduplicates repeated terminal records and refuses to choose between conflicts', () => {
    const repeated = { callId: 'retry-1', attribution: 'query', outcome: 'failure', usage: { inputTokens: 9, outputTokens: 1 } }
    const report = aggregateModelUsage([
      repeated,
      { ...repeated, usage: { ...repeated.usage } },
      { ...repeated, outcome: 'success', usage: { inputTokens: 10, outputTokens: 2 } },
    ])

    expect(report.calls).toBe(1)
    expect(report.outcomes.unknown).toBe(1)
    expect(report.usage.callsWithoutUsage).toBe(1)
    expect(report.diagnostics.conflictingCallIds).toEqual(['retry-1'])
  })

  it('counts failed and retried embedded attempts once and excludes inherited history', () => {
    const failure = event(2, 'assistant/attempt', { turn: 2, step: 0, stream: stream(30, 'error') })
    const success = event(3, 'assistant/message', { turn: 2, step: 0, stream: stream(31, 'stop') })
    const records = recordsFromSessionEvents({ id: 'child', origin: 'subagent', parentSession: 'parent', inheritedEventCount: 2 }, [
      event(0, 'assistant/message', { usage: { inputTokens: 999, outputTokens: 999 }, stream: [] }),
      failure, success, success,
    ], 'child-log')
    expect(records).toHaveLength(2)
    const report = aggregateModelUsage(records)
    expect(report.byAttribution.child.calls).toBe(2)
    expect(report.outcomes).toMatchObject({ success: 1, failure: 1 })
    expect(report.usage.fields.inputTokens.sum).toBe(61)
  })

  it('keeps compaction unattributed and does not invent invisible query calls', () => {
    const records = recordsFromSessionEvents({ id: 'main' }, [
      event(0, 'assistant/message', { usage: { inputTokens: 12, outputTokens: 4 }, stream: [] }),
      event(1, 'compaction/summary', { compactionId: 'c1', llmStreamCall: true, usage: { inputTokens: 8, outputTokens: 2 } }),
    ])
    expect(records.map(record => record.attribution)).toEqual(['main', 'unknown'])
  })

  it('retains cancellation and unknown settlement without guessing a failed attempt outcome', () => {
    const records = recordsFromSessionEvents({ id: 'main' }, [
      event(0, 'assistant/message', { interrupted: true, stream: [] }),
      event(1, 'assistant/attempt', { stream: [] }),
      event(2, 'assistant/attempt', { stream: stream(9, 'provider-extension') }),
    ])
    expect(records.map(record => record.outcome)).toEqual(['aborted', 'unknown', 'unknown'])
    expect(records[0].usage).toBeUndefined()
  })

  it('uses the last usage in one embedded stream without double-counting message usage', () => {
    const records = recordsFromSessionEvents({ id: 'main' }, [event(0, 'assistant/message', {
      usage: { inputTokens: 99, outputTokens: 99 },
      stream: [...stream(10, 'tool-calls'), ...stream(11, 'tool-calls')],
    })])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'success', usage: { inputTokens: 11, outputTokens: 2 } })
  })

  it('reads explicitly named multi-frame zstd Session logs', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-model-usage-'))
    const file = join(temporary, 'session.jsonl.zstd')
    const session = Session.create(SessionId('s1'))
    const header = JSON.stringify(sessionFormatCatalog.encodeCurrentHeader({ ...session.header, delegationDepth: 0 }, 0)) + '\n'
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'test', model: 'test' } }), stream: [], usage: { inputTokens: 5, outputTokens: 1 } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const body = session.snapshotEvents().map(event => JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(event))).join('\n') + '\n'
    await writeFile(file, Buffer.concat([zstdCompressSync(header), zstdCompressSync(body)]))

    const loaded = await readSessionLog(file)
    expect(loaded.header.id).toBe('s1')
    expect(loaded.events).toHaveLength(5)
    expect(aggregateModelUsage(recordsFromSessionEvents(loaded.header, loaded.events, file)).usage.fields.inputTokens.sum).toBe(5)
  })

  it('requires explicit non-empty CLI input paths', () => {
    expect(parseInputPaths(['--input', 'a.jsonl.zstd', 'b.jsonl'])).toEqual(['a.jsonl.zstd', 'b.jsonl'])
    expect(() => parseInputPaths(['--input', '--other'])).toThrow(/non-empty path/)
    expect(() => parseInputPaths(['--input', ''])).toThrow(/non-empty path/)
    expect(() => parseInputPaths([])).toThrow(/usage:/)
  })

  it('decodes UTF-8 characters split across zstd frame boundaries and rejects a truncated tail', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-model-usage-zstd-'))
    const file = join(temporary, 'session.jsonl.zstd')
    const encoded = JSON.stringify(sessionFormatCatalog.encodeCurrentHeader({ ...Session.create(SessionId('跨界帧')).header, delegationDepth: 0 }, 0)) + '\n'
    const [before, after] = encoded.split('界')
    const headerStart = Buffer.from(before!)
    const headerEnd = Buffer.from(after!)
    const split = Buffer.from('界').subarray(0, 2)
    const rest = Buffer.concat([Buffer.from('界').subarray(2), headerEnd])
    await writeFile(file, Buffer.concat([
      zstdCompressSync(Buffer.concat([headerStart, split])),
      zstdCompressSync(rest),
    ]))
    expect((await readSessionLog(file)).header.id).toBe('跨界帧')

    const valid = zstdCompressSync(Buffer.from('{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}\n'))
    await writeFile(file, Buffer.concat([valid, zstdCompressSync(Buffer.from('{}\n')).subarray(0, -1)]))
    await expect(readSessionLog(file)).rejects.toThrow(/invalid or truncated Zstandard/)
  })
})

function event(seq: number, type: string, data: unknown) {
  return { type, seq, time: seq + 1, data }
}

function stream(inputTokens: number, reason: string) {
  return [
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens, outputTokens: 2 } } },
    { type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: reason } } },
  ]
}
