// Retention-policy heap curves (plan §5.2 / §9 Phase 0).
//
// Policy A ("identity"): history slot holds the ORIGINAL completion object.
// Policy B ("snapshot"): history slot holds the snapshot copy that boundary
//                        validation already built, and drops the original.
//
// Scenario 1 "bound":   a user binding also holds the original (const x = ...).
// Scenario 2 "unbound": the completion was a temporary; only history holds it.
// Scenario 3 "mutate":  after the slot exists, user code mutates the object in
//                       place; we measure how far the recorded capture bytes
//                       drift from reality under each policy.
//
// Usage:
//   node --expose-gc --max-old-space-size=8192 bench/retention-bench.mjs \
//     --shape record-array --unit-mib 8 --slots 8
// Writes bench/results/retention-<shape>-<unit>mib.json

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildFixture, flatNumberArray, MIB } from './lib/fixtures.mjs'
import { snapshotJson, stringify, utf8Bytes } from './lib/snapshot.mjs'
import { settledHeap, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const shape = arg('shape', 'record-array')
const unitMib = Number(arg('unit-mib', '8'))
const slots = Number(arg('slots', '8'))

const out = { shape, unitMib, slots, node: process.version, curves: {}, drift: {} }

/**
 * Build `slots` distinct completion values one at a time, retain them under one
 * policy, and record settled heap after each slot. `bound` decides whether a
 * simulated user binding also keeps the original alive.
 */
function heapCurve({ policy, bound }) {
  const history = []
  const bindings = []
  const base = settledHeap()
  const points = []
  let totalMs = 0
  for (let slot = 0; slot < slots; slot++) {
    // Each buildFixture call returns a fresh object graph, so slots are already
    // distinct by identity; contents are deliberately left identical so heap
    // readings differ only by policy. Nothing is appended, because appending a
    // heterogeneous element would change the array's V8 elements kind and
    // distort the comparison.
    let value = buildFixture(shape, unitMib)
    if (bound) bindings.push(value)
    const t0 = performance.now()
    const snapshot = snapshotJson(value)
    const bytes = utf8Bytes(stringify(snapshot))
    totalMs += performance.now() - t0
    history.push(policy === 'identity' ? value : snapshot)
    value = undefined
    points.push({ slot: slot + 1, heapBytes: settledHeap() - base, captureBytes: bytes })
  }
  const total = settledHeap() - base
  // keep both arrays reachable through the reading above
  const probe = history.length + bindings.length
  return { points, totalHeapBytes: total, captureMs: ms(totalMs), probe }
}

for (const policy of ['identity', 'snapshot']) {
  for (const bound of [true, false]) {
    const key = `${policy}/${bound ? 'bound' : 'unbound'}`
    out.curves[key] = heapCurve({ policy, bound })
    process.stderr.write(`${key}: total=${Math.round(out.curves[key].totalHeapBytes / MIB * 100) / 100} MiB\n`)
  }
}

// --- Scenario 3: in-place mutation after the slot is created ---------------
function driftCase(name, mutate) {
  const value = buildFixture(shape, unitMib)
  // A primitive completion (the long-string shape) cannot be mutated in place,
  // so identity retention carries no drift risk for it at all.
  if (value === null || typeof value !== 'object') {
    return { name, skipped: 'completion value is a primitive; not mutable in place' }
  }
  const snapshot = snapshotJson(value)
  const captureBytes = utf8Bytes(stringify(snapshot))
  const base = settledHeap()
  mutate(value)
  const afterMutationHeap = settledHeap() - base
  let realBytesNow = null
  let stillJson = true
  try {
    realBytesNow = utf8Bytes(stringify(snapshotJson(value)))
  } catch {
    stillJson = false
  }
  const snapshotBytesNow = utf8Bytes(stringify(snapshot))
  return {
    name,
    captureBytes,
    identityRealBytesNow: realBytesNow,
    identityStillLosslessJson: stillJson,
    identityDriftRatio: realBytesNow === null ? null : Math.round((realBytesNow / captureBytes) * 1000) / 1000,
    snapshotBytesNow,
    snapshotDriftRatio: Math.round((snapshotBytesNow / captureBytes) * 1000) / 1000,
    heapDeltaAfterMutationBytes: afterMutationHeap,
    probe: Array.isArray(value) ? value.length : Object.keys(value).length,
  }
}

out.drift.grow10x = driftCase('grow ~10x in place', (value) => {
  const filler = flatNumberArray(unitMib * MIB * 9)
  if (Array.isArray(value)) for (let index = 0; index < filler.length; index++) value.push(filler[index])
  else value.__grown = filler
})
out.drift.shrink = driftCase('truncate to 1 element', (value) => {
  if (Array.isArray(value)) value.length = 1
  else for (const key of Object.keys(value).slice(1)) delete value[key]
})
out.drift.nonJson = driftCase('mutate into non-JSON', (value) => {
  if (Array.isArray(value)) value.push(() => 1)
  else value.__fn = () => 1
})

mkdirSync(join(here, 'results'), { recursive: true })
const file = join(here, 'results', `retention-${shape}-${unitMib}mib.json`)
writeFileSync(file, JSON.stringify(out, null, 2))
process.stderr.write(`wrote ${file}\n`)
