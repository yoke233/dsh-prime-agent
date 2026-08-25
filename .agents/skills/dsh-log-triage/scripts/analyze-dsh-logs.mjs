#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

const { values } = parseArgs({
  options: {
    project: { type: 'string', default: process.cwd() },
    hours: { type: 'string' },
    since: { type: 'string' },
    until: { type: 'string' },
    'dsh-home': { type: 'string', default: path.join(homedir(), '.dsh') },
    examples: { type: 'string', default: '20' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (values.help) {
  console.log(`Usage:
  node analyze-dsh-logs.mjs --project <cwd> --hours <n>
  node analyze-dsh-logs.mjs --project <cwd> --since <local-iso> [--until <local-iso>]

Options:
  --dsh-home <path>  DSH state directory (default: ~/.dsh)
  --examples <n>     Maximum detailed errors (default: 20)
  --json             Emit machine-readable JSON`)
  process.exit(0)
}

if ((values.hours === undefined) === (values.since === undefined)) {
  fail('provide exactly one of --hours or --since')
}

const untilMs = values.until === undefined ? Date.now() : parseTimestamp(values.until, '--until')
const sinceMs = values.since === undefined
  ? untilMs - parsePositiveNumber(values.hours, '--hours') * 60 * 60 * 1000
  : parseTimestamp(values.since, '--since')
const examples = parseNonNegativeInteger(values.examples, '--examples')
if (sinceMs >= untilMs) fail('the start of the window must be before its end')

const projectKey = normalizePath(values.project)
const sessionsRoot = path.join(path.resolve(values['dsh-home']), 'sessions')
const reports = []
const warnings = []

for await (const file of sessionFiles(sessionsRoot)) {
  let metadata
  try {
    metadata = await stat(file)
  } catch (error) {
    warnings.push(`${file}: ${errorMessage(error)}`)
    continue
  }
  if (metadata.mtimeMs < sinceMs) continue
  try {
    const report = await analyzeSession(file, projectKey, sinceMs, untilMs)
    if (report !== undefined) reports.push(report)
  } catch (error) {
    warnings.push(`${file}: ${errorMessage(error)}`)
  }
}

const errors = reports.flatMap(report => report.errors).sort((left, right) => left.timestampMs - right.timestampMs)
const nestedToolErrors = errors.filter(error => error.kind === 'nested-tool').length
const fatalTurnErrors = errors.filter(error => error.kind === 'turn').length
const toolResults = reports.reduce((total, report) => total + report.toolResults, 0)
const categories = Object.fromEntries(
  [...errors.reduce((counts, error) => counts.set(error.category, (counts.get(error.category) ?? 0) + 1), new Map())]
    .sort((left, right) => right[1] - left[1]),
)
const payload = {
  project: path.resolve(values.project),
  window: {
    since: localIso(sinceMs),
    until: localIso(untilMs),
  },
  sessions: reports.length,
  toolResults,
  nestedToolErrors,
  fatalTurnErrors,
  toolErrorRate: toolResults === 0 ? 0 : nestedToolErrors / toolResults,
  categories,
  errors: errors.map(({ timestampMs: _, ...error }) => error),
  warnings,
}

if (values.json) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  printHuman(payload, examples)
}

if (warnings.length > 0) process.exitCode = 1

async function analyzeSession(file, expectedProject, startMs, endMs) {
  let cwd
  let provider
  let model
  let eventsInWindow = 0
  let toolResults = 0
  const calls = new Map()
  const errors = []

  for await (const { lineNumber, event } of readEvents(file)) {
    const type = event.type
    const data = isRecord(event.data) ? event.data : {}

    if (type === 'session' && typeof event.cwd === 'string') {
      cwd = event.cwd
      if (normalizePath(cwd) !== expectedProject) return undefined
    }
    if (cwd === undefined) continue

    if (type === 'request/context') {
      if (typeof data.provider === 'string') provider = data.provider
      if (typeof data.model === 'string') model = data.model
    }
    if (type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      calls.set(data.callId, data.name)
    }

    const timestampMs = eventTimestamp(event)
    if (timestampMs === undefined || timestampMs < startMs || timestampMs > endMs) continue
    eventsInWindow += 1

    if (type === 'tool/result') {
      toolResults += 1
      for (const message of nestedErrorTexts(data)) {
        const callId = sourceCallId(data)
        errors.push({
          kind: 'nested-tool',
          time: localIso(timestampMs),
          timestampMs,
          provider,
          model,
          outerTool: callId === undefined ? undefined : calls.get(callId),
          category: classify(message),
          message: oneLine(redact(message)),
          session: path.basename(path.dirname(file)),
          eventLine: lineNumber,
        })
      }
      continue
    }

    if (type === 'turn/end' && isRecord(data.reason) && data.reason.kind === 'error') {
      const failure = isRecord(data.reason.error) ? data.reason.error : {}
      const message = typeof failure.message === 'string' ? failure.message : 'unknown turn failure'
      errors.push({
        kind: 'turn',
        time: localIso(timestampMs),
        timestampMs,
        provider,
        model,
        code: typeof failure.code === 'string' ? failure.code : undefined,
        category: classify(message),
        message: oneLine(redact(message)),
        session: path.basename(path.dirname(file)),
        eventLine: lineNumber,
      })
    }
  }

  if (cwd === undefined || eventsInWindow === 0) return undefined
  return { session: path.basename(path.dirname(file)), cwd, provider, model, toolResults, errors }
}

async function* sessionFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    fail(`cannot read sessions directory ${directory}: ${errorMessage(error)}`)
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* sessionFiles(target)
    } else if (entry.isFile() && entry.name === 'session.jsonl.zstd') {
      yield target
    }
  }
}

async function* readEvents(file) {
  const source = await readFile(file)
  const { frames } = scanZstdFrames(source)
  let lineNumber = 0
  for (const frame of frames) {
    const plaintext = zstdDecompressSync(source.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of plaintext.split(/\r?\n/)) {
      if (line.length === 0) continue
      lineNumber += 1
      try {
        const event = JSON.parse(line)
        if (isRecord(event)) yield { lineNumber, event }
      } catch {
        // A malformed JSONL row carries no trustworthy diagnostic structure.
      }
    }
  }
}

function scanZstdFrames(source) {
  const frames = []
  let offset = 0
  while (offset < source.length) {
    const start = offset
    if (source.length - offset < 4) return { frames, tornStart: start }
    if (source.readUInt32LE(offset) !== 0xfd2fb528) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === source.length) return { frames, tornStart: start }

    const descriptor = source.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (source.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (source.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = source.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (source.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (source.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function nestedErrorTexts(value) {
  const errors = []
  visit(value)
  return [...new Set(errors)]

  function visit(current) {
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (!isRecord(current)) return
    if (current.isError === true) {
      for (const text of collectText(current.content)) {
        if (text.trimStart().startsWith('Error:')) errors.push(text)
      }
    }
    for (const child of Object.values(current)) visit(child)
  }
}

function collectText(value) {
  const texts = []
  visit(value)
  return texts

  function visit(current) {
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (!isRecord(current)) return
    if (typeof current.text === 'string') texts.push(current.text)
    for (const [key, child] of Object.entries(current)) {
      if (key !== 'text') visit(child)
    }
  }
}

function sourceCallId(data) {
  return isRecord(data.message) && isRecord(data.message.source) && typeof data.message.source.callId === 'string'
    ? data.message.source.callId
    : undefined
}

function eventTimestamp(event) {
  const raw = event.time ?? event.time0 ?? (event.type === 'session' ? event.createdAt : undefined)
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return raw > 10_000_000_000 ? raw : raw * 1000
}

function classify(message) {
  const text = message.toLowerCase()
  if (text.includes('regex parse error') || text.includes('grep pattern rejected')) return 'invalid regex or escaping'
  if (text.includes('hunk context') || text.includes('file changed since') || text.includes('old_string was not found')) return 'stale or ambiguous edit'
  if (text.includes('workspace-relative path') || text.includes('not found') || text.includes('系统找不到指定')) return 'wrong or missing path'
  if (text.includes('dynamic_import_callback_missing') || text.includes('require is not defined')) return 'unsupported Realm module loading'
  if (text.includes('use the repl tool') || text.includes('only `run_code` is callable')) return 'direct tool call outside Prime REPL'
  if (text.includes('timed out') || text.includes('ceiling reached') || text.includes('budget exhausted')) return 'timeout or budget'
  if (['expression expected', 'expected a semicolon', "expected ','", 'referenceerror:'].some(token => text.includes(token))) return 'generated REPL code error'
  if (['websocket', 'transport', 'authentication token', 'fetch failed'].some(token => text.includes(token))) return 'provider, transport, or authentication'
  return 'other'
}

function redact(message) {
  return message
    .replace(/(bearer\s+)([^\s,;"']+)/gi, '$1<REDACTED>')
    .replace(/((?:api[_-]?key|token|authorization|cookie)["'=:\s]+)([^\s,;"']+)/gi, '$1<REDACTED>')
    .replace(/sk-[A-Za-z0-9_-]{12,}/gi, '<REDACTED>')
}

function printHuman(result, maximumExamples) {
  console.log(`Project: ${result.project}`)
  console.log(`Window:  ${result.window.since} .. ${result.window.until}`)
  console.log(`Sessions: ${result.sessions}`)
  console.log(`Tool results: ${result.toolResults}`)
  console.log(`Nested tool errors: ${result.nestedToolErrors} (${(result.toolErrorRate * 100).toFixed(1)}%)`)
  console.log(`Fatal turn errors: ${result.fatalTurnErrors}`)
  if (Object.keys(result.categories).length > 0) {
    console.log('Categories:')
    for (const [category, count] of Object.entries(result.categories)) {
      console.log(`  ${String(count).padStart(3)}  ${category}`)
    }
  }
  if (result.errors.length > 0 && maximumExamples > 0) {
    console.log('Errors:')
    for (const error of result.errors.slice(0, maximumExamples)) {
      const context = [error.provider, error.model, error.outerTool].filter(Boolean).join(' ')
      console.log(`  ${error.time} [${error.kind}] [${error.category}] ${context}`.trimEnd())
      console.log(`    ${error.message}`)
    }
  }
  for (const warning of result.warnings) console.error(`warning: ${warning}`)
}

function normalizePath(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function localIso(timestampMs) {
  const date = new Date(timestampMs)
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(timestampMs - offsetMs).toISOString().slice(0, 19)
}

function parseTimestamp(value, option) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) fail(`${option} must be a valid ISO timestamp`)
  return timestamp
}

function parsePositiveNumber(value, option) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) fail(`${option} must be positive`)
  return number
}

function parseNonNegativeInteger(value, option) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) fail(`${option} must be a non-negative integer`)
  return number
}

function oneLine(value, limit = 600) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(2)
}
