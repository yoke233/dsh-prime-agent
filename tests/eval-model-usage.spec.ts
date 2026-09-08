import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
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

  it('counts failed and retried stream attempts once and assigns child only from the Session header', () => {
    const header = { type: 'session', id: 'child', origin: 'subagent', parentSession: 'parent', seedLength: 2 }
    const events = [
      event(0, 'assistant/message', { turn: 1, step: 0, usage: { inputTokens: 999, outputTokens: 999 } }),
      event(1, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
      event(2, 'request/context', { provider: 'deepseek', model: 'model-a' }),
      event(3, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'usage', usage: { inputTokens: 30, outputTokens: 2, cacheWriteTokens: 6 } } }),
      event(4, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'finish', reason: { kind: 'error' } } }),
      event(5, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'usage', usage: { inputTokens: 31, outputTokens: 8, cacheReadTokens: 20 } } }),
      event(6, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }),
      event(7, 'assistant/message', { turn: 2, step: 0, usage: { inputTokens: 31, outputTokens: 8, cacheReadTokens: 20 } }),
      event(7, 'assistant/message', { turn: 2, step: 0, usage: { inputTokens: 31, outputTokens: 8, cacheReadTokens: 20 } }),
    ]

    const records = recordsFromSessionEvents(header, events, 'child-log')
    const report = aggregateModelUsage(records)
    expect(records).toHaveLength(2)
    expect(report.byAttribution.child.calls).toBe(2)
    expect(report.outcomes).toMatchObject({ success: 1, failure: 1 })
    expect(report.usage.fields.inputTokens.sum).toBe(61)
    expect(report.failed.usage.fields.cacheWriteTokens.sum).toBe(6)
  })

  it('keeps compaction unknown and does not claim invisible query calls from a main Session log', () => {
    const records = recordsFromSessionEvents({ type: 'session', id: 'main', delegationDepth: 0 }, [
      event(0, 'assistant/message', { turn: 1, step: 0, usage: { inputTokens: 12, outputTokens: 4 } }),
      event(1, 'compaction/summary', { compactionId: 'c1', llmStreamCall: true, provider: 'p', model: 'm', usage: { inputTokens: 8, outputTokens: 2 } }),
    ], 'main-log')

    expect(records.map(record => record.attribution)).toEqual(['main', 'unknown'])
    expect(records.some(record => record.attribution === 'query')).toBe(false)
  })

  it('settles usage from thrown, retried, and unknown-finish attempts without mixing them', () => {
    const records = recordsFromSessionEvents({ type: 'session', id: 'main' }, [
      event(0, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1 } } }),
      event(1, 'llm/retry-started', { turn: 1, step: 0, retryId: 'r', retry: 1 }),
      event(2, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } } }),
      event(3, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'future-reason' } } }),
      event(4, 'assistant/chunk', { turn: 2, step: 0, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } } }),
      event(5, 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'middleware threw', code: 'UNKNOWN' } } }),
    ], 'main-log')

    expect(records.map(record => record.outcome)).toEqual(['failure', 'unknown', 'failure'])
    expect(records.map(record => record.usage?.inputTokens)).toEqual([7, 8, 9])
  })

  it('keeps repeated usage in one stream as one call and accepts the tool-calls finish reason', () => {
    const records = recordsFromSessionEvents({ type: 'session', id: 'main' }, [
      event(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } }),
      event(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 2 } } }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }),
    ], 'main-log')

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'success', usage: { inputTokens: 11, outputTokens: 2 } })
  })

  it('pairs an unknown finish with its assistant message without changing the observed outcome', () => {
    const records = recordsFromSessionEvents({ type: 'session', id: 'main' }, [
      event(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'provider-extension' } } }),
      event(1, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 4, outputTokens: 1 } }),
    ], 'main-log')

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'unknown', usage: { inputTokens: 4, outputTokens: 1 } })
  })

  it('backfills message usage onto its finished call and separates a retried attempt', () => {
    const records = recordsFromSessionEvents({ type: 'session', id: 'main' }, [
      event(0, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'error' } } }),
      event(1, 'llm/retry-started', { turn: 1, step: 1, retryId: 'r', retry: 1 }),
      event(2, 'assistant/message', { turn: 1, step: 1, usage: { inputTokens: 6, outputTokens: 2 } }),
    ], 'main-log')

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ outcome: 'failure' })
    expect(records[0].usage).toBeUndefined()
    expect(records[1]).toMatchObject({ outcome: 'success', usage: { inputTokens: 6, outputTokens: 2 } })
  })

  it('reads explicitly named multi-frame zstd Session logs', async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-model-usage-'))
    const file = join(temporary, 'session.jsonl.zstd')
    const header = `${JSON.stringify({ type: 'session', version: 0, id: 's1', createdAt: 1, delegationDepth: 0 })}\n`
    const body = `${JSON.stringify(event(0, 'assistant/message', { turn: 1, step: 0, usage: { inputTokens: 5, outputTokens: 1 } }))}\n`
    await writeFile(file, Buffer.concat([zstdCompressSync(header), zstdCompressSync(body)]))

    const loaded = await readSessionLog(file)
    expect(loaded.header.id).toBe('s1')
    expect(loaded.events).toHaveLength(1)
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
    const headerStart = Buffer.from('{"type":"session","version":0,"id":"跨')
    const headerEnd = Buffer.from('帧","createdAt":1,"delegationDepth":0}\n')
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
