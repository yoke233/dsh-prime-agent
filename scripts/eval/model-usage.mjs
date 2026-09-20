#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'

const ATTRIBUTIONS = ['main', 'query', 'child', 'unknown']
const OUTCOMES = ['success', 'failure', 'aborted', 'unknown']
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']

/** Aggregate one terminal record per physical model call. Duplicate call ids are counted once. */
export function aggregateModelUsage(records) {
  const calls = new Map()
  const conflicts = []
  for (const raw of records) {
    const record = normalizeRecord(raw)
    const prior = calls.get(record.callId)
    if (prior === undefined) calls.set(record.callId, record)
    else if (JSON.stringify(prior) !== JSON.stringify(record)) {
      calls.set(record.callId, conflictRecord(record.callId, prior, record))
      if (!conflicts.includes(record.callId)) conflicts.push(record.callId)
    }
  }

  const values = [...calls.values()]
  const summarize = selected => ({
    calls: selected.length,
    outcomes: Object.fromEntries(OUTCOMES.map(outcome => [outcome, selected.filter(call => call.outcome === outcome).length])),
    usage: usageSummary(selected),
    billing: billingSummary(selected),
  })
  return {
    schemaVersion: 1,
    ...summarize(values),
    failed: summarize(values.filter(call => call.outcome === 'failure' || call.outcome === 'aborted')),
    byAttribution: Object.fromEntries(ATTRIBUTIONS.map(attribution => [attribution, summarize(values.filter(call => call.attribution === attribution))])),
    diagnostics: { conflictingCallIds: conflicts.sort() },
  }
}

/** Convert one decoded Session log to call records. Query calls are not present in Session logs. */
export function recordsFromSessionEvents(header, events, source = String(header?.id ?? 'session')) {
  const attribution = header?.origin === 'subagent' && typeof header?.parentSession === 'string' ? 'child' : 'main'
  const inherited = Number.isSafeInteger(header?.inheritedEventCount) ? header.inheritedEventCount : 0
  const records = new Map()
  let context = {}
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < inherited) continue
    const data = isRecord(event.data) ? event.data : {}
    if (event.type === 'request/context') context = data
    if (event.type === 'request/header' && isRecord(data.header?.config)) context = { ...context, ...data.header.config }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      let usage = data.usage
      let outcome = data.interrupted === true ? 'aborted' : event.type === 'assistant/message' ? 'success' : 'unknown'
      for (const { chunk } of expandAssistantStream(data.stream ?? [])) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') {
          const reason = typeof chunk.reason === 'string' ? chunk.reason : chunk.reason.kind
          outcome = reason === 'error' ? 'failure' : reason === 'aborted' ? 'aborted' : ['stop', 'tool-calls', 'max-tokens'].includes(reason) ? 'success' : 'unknown'
        }
      }
      const callId = source + ':' + event.seq
      records.set(callId, { callId, attribution, outcome, usage, provider: context.provider, model: context.model })
    }
    if (event.type === 'compaction/summary' && data.llmStreamCall === true) {
      const callId = source + ':compaction:' + String(data.compactionId)
      records.set(callId, { callId, attribution: 'unknown', outcome: 'success', usage: data.usage, provider: data.provider, model: data.model })
    }
  }
  return [...records.values()]
}

/** Read one explicitly named DSH JSONL or multi-frame JSONL.zstd artifact. */
export async function readSessionLog(file) {
  const input = await readFile(file)
  const text = file.endsWith('.zstd') ? decodeZstdFrames(input) : input.toString('utf8')
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) throw new Error(`empty session log: ${file}`)
  const header = JSON.parse(lines[0])
  if (!isRecord(header) || header.type !== 'session') throw new Error(`first line is not a Session header: ${file}`)
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const line of lines.slice(1)) restore.decodeRow(JSON.parse(line))
  const artifact = restore.finish()
  return { header: { ...artifact.header, inheritedEventCount: artifact.inheritedEventCount }, events: artifact.events }
}

function normalizeRecord(raw) {
  if (!isRecord(raw) || typeof raw.callId !== 'string' || raw.callId.length === 0) throw new Error('each model usage record needs a non-empty callId')
  return {
    callId: raw.callId,
    attribution: ATTRIBUTIONS.includes(raw.attribution) ? raw.attribution : 'unknown',
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : 'unknown',
    ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}),
    ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
    ...(validUsage(raw.usage) ? { usage: Object.fromEntries(USAGE_FIELDS.filter(field => raw.usage[field] !== undefined).map(field => [field, raw.usage[field]])) } : {}),
    ...(raw.billing === undefined ? {} : { billing: raw.billing }),
  }
}

function conflictRecord(callId, a, b) {
  return {
    callId,
    attribution: a.attribution === b.attribution ? a.attribution : 'unknown',
    outcome: a.outcome === b.outcome ? a.outcome : 'unknown',
    ...(a.provider === b.provider && a.provider !== undefined ? { provider: a.provider } : {}),
    ...(a.model === b.model && a.model !== undefined ? { model: a.model } : {}),
  }
}

function usageSummary(calls) {
  const withUsage = calls.filter(call => call.usage !== undefined)
  return {
    callsWithUsage: withUsage.length,
    callsWithoutUsage: calls.length - withUsage.length,
    fields: Object.fromEntries(USAGE_FIELDS.map(field => {
      const known = withUsage.filter(call => call.usage[field] !== undefined)
      return [field, { sum: known.length === 0 ? null : known.reduce((sum, call) => sum + call.usage[field], 0), knownCalls: known.length, unknownCalls: calls.length - known.length }]
    })),
  }
}

function billingSummary(calls) {
  const reported = calls.filter(call => call.billing !== undefined).map(call => ({ callId: call.callId, value: call.billing }))
  return reported.length === 0 ? { status: 'unknown' } : { status: reported.length === calls.length ? 'reported' : 'partial', reported, unknownCalls: calls.length - reported.length }
}

function validUsage(usage) {
  if (!isRecord(usage)) return false
  return USAGE_FIELDS.some(field => Number.isFinite(usage[field]) && usage[field] >= 0) && USAGE_FIELDS.every(field => usage[field] === undefined || (Number.isFinite(usage[field]) && usage[field] >= 0))
}

function decodeZstdFrames(source) {
  const decoded = []
  let offset = 0
  while (offset < source.length) {
    const remaining = source.subarray(offset)
    let result
    try {
      result = zstdDecompressSync(remaining, { info: true })
    } catch (error) {
      throw new Error(`invalid or truncated Zstandard frame at byte ${offset}`, { cause: error })
    }
    const consumed = result.engine.bytesWritten
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > remaining.length) {
      throw new Error(`invalid Zstandard consumed-byte count at byte ${offset}: ${String(consumed)}`)
    }
    if (result.buffer.length === 0) throw new Error(`invalid or truncated Zstandard frame at byte ${offset}`)
    decoded.push(result.buffer)
    offset += consumed
  }
  const output = Buffer.concat(decoded)
  if (output.at(-1) !== 0x0a) throw new Error('invalid or truncated Zstandard JSONL input')
  return output.toString('utf8')
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

async function main(argv) {
  const files = parseInputPaths(argv)
  const loaded = await Promise.all(files.map(async file => ({ file: path.resolve(file), ...(await readSessionLog(file)) })))
  const records = loaded.flatMap(({ file, header, events }) => recordsFromSessionEvents(header, events, file))
  process.stdout.write(`${JSON.stringify({ files: loaded.map(item => item.file), report: aggregateModelUsage(records) }, null, 2)}\n`)
}

export function parseInputPaths(argv) {
  const files = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--') || argv[i + 1].trim().length === 0) throw new Error('--input requires a non-empty path')
      files.push(argv[++i])
    } else if (argv[i].startsWith('--')) throw new Error(`unknown option: ${argv[i]}`)
    else files.push(argv[i])
  }
  if (files.length === 0) throw new Error('usage: node scripts/eval/model-usage.mjs [--input] <session.jsonl[.zstd]> ...')
  return files
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
