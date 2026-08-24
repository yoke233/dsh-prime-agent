// Bounded projector prototype (plan §4.4) — cost and envelope-size calibration.
//
// Purpose is not to fix the projector's final shape but to answer two Phase 0
// questions with numbers:
//   1. Is projection cost bounded by the BUDGET rather than by the value size?
//      (It must be, or large completions stay expensive after Phase 2.)
//   2. What does a rich projection and a minimal reference envelope actually
//      cost in wire bytes, so maxCompletionProjectionBytes has a floor?
//
// Usage: node --expose-gc bench/projection-bench.mjs
// Writes bench/results/projection.json

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildFixture, SHAPES } from './lib/fixtures.mjs'
import { stringify, utf8Bytes } from './lib/snapshot.mjs'
import { forceGc, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const LIMITS = {
  maxDepth: 4,
  maxArraySample: 8,
  maxObjectKeys: 16,
  maxStringChars: 256,
  maxNodes: 512,
}

/** Slice a string without splitting a surrogate pair (plan §6.2). */
function safeSlice(text, limit) {
  if (text.length <= limit) return text
  let end = limit
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1 // do not orphan a high surrogate
  return text.slice(0, end)
}

function project(value, limits, budget, depth = 0) {
  if (budget.nodes <= 0) return { type: 'elided' }
  budget.nodes -= 1
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'number') return value
  if (kind === 'string') {
    if (value.length <= limits.maxStringChars) return value
    return { type: 'string', length: value.length, head: safeSlice(value, limits.maxStringChars), truncated: true }
  }
  if (Array.isArray(value)) {
    if (depth >= limits.maxDepth) return { type: 'array', length: value.length }
    const take = Math.min(value.length, limits.maxArraySample)
    const sample = []
    for (let index = 0; index < take; index++) sample.push(project(value[index], limits, budget, depth + 1))
    return value.length > take
      ? { type: 'array', length: value.length, sample, truncated: true }
      : { type: 'array', length: value.length, sample }
  }
  const keys = Object.keys(value)
  if (depth >= limits.maxDepth) return { type: 'object', keys: keys.length }
  const take = Math.min(keys.length, limits.maxObjectKeys)
  const sample = {}
  for (let index = 0; index < take; index++) sample[keys[index]] = project(value[keys[index]], limits, budget, depth + 1)
  return keys.length > take
    ? { type: 'object', keys: keys.length, sample, truncated: true }
    : { type: 'object', keys: keys.length, sample }
}

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)

/** Rich projection envelope (plan §4.3). */
function richEnvelope(id, value, captureBytes, limits) {
  const budget = { nodes: limits.maxNodes }
  return {
    $out: id,
    use: `$out(${id})`,
    retained: true,
    type: typeOf(value),
    serializedBytesAtCapture: captureBytes,
    projection: project(value, limits, budget),
    truncated: true,
  }
}

/** Minimal reference envelope — the last rung before output-limit (plan §6.1). */
function minimalEnvelope(id, value, captureBytes, retained = true) {
  return { $out: id, use: `$out(${id})`, retained, type: typeOf(value), serializedBytesAtCapture: captureBytes }
}

const out = { node: process.version, limits: LIMITS, rows: [], envelopeFloor: {} }

// Worst-case constants for the minimal envelope: largest plausible id and bytes.
out.envelopeFloor = {
  minimalSmallestBytes: utf8Bytes(stringify(minimalEnvelope(1, [], 2))),
  minimalWorstCaseBytes: utf8Bytes(stringify(minimalEnvelope(999999999, {}, 9007199254740991, false))),
  richLimitsUsed: LIMITS,
}

for (const size of [1, 8, 16, 64]) {
  for (const shape of SHAPES) {
    const fixture = buildFixture(shape, size)
    const captureBytes = utf8Bytes(stringify(fixture))
    forceGc()
    const runs = []
    for (let iteration = 0; iteration < 7; iteration++) {
      const t0 = performance.now()
      const envelope = richEnvelope(17, fixture, captureBytes, LIMITS)
      const json = stringify(envelope)
      runs.push({ ms: performance.now() - t0, bytes: utf8Bytes(json) })
    }
    const fastest = runs.reduce((best, run) => (run.ms < best.ms ? run : best))
    const row = {
      shape,
      mib: size,
      captureBytes,
      richProjectionBytes: fastest.bytes,
      minimalBytes: utf8Bytes(stringify(minimalEnvelope(17, fixture, captureBytes))),
      projectMinMs: ms(fastest.ms),
      reductionRatio: Math.round((captureBytes / fastest.bytes) * 10) / 10,
    }
    out.rows.push(row)
    process.stderr.write(
      `${shape.padEnd(13)} ${String(size).padStart(3)}MiB capture=${captureBytes}B` +
      ` rich=${row.richProjectionBytes}B minimal=${row.minimalBytes}B project=${row.projectMinMs}ms` +
      ` reduction=${row.reductionRatio}x\n`,
    )
  }
}

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'projection.json'), JSON.stringify(out, null, 2))
process.stderr.write(`\nminimal envelope: ${out.envelopeFloor.minimalSmallestBytes}B .. ${out.envelopeFloor.minimalWorstCaseBytes}B\n`)
process.stderr.write(`wrote ${join(here, 'results', 'projection.json')}\n`)
