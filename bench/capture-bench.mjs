// Phase 0 capture benchmark: one (shape, size) case per process.
//
// Measures the CURRENT boundary cost (realm-worker.ts prepareCompletion:
// snapshotJson deep copy + JSON.stringify + Buffer.byteLength) and the
// INCREMENTAL cost of counting object-graph nodes in the same traversal.
//
// Usage:
//   node --expose-gc --max-old-space-size=4096 bench/capture-bench.mjs \
//     --shape flat-array --mib 64 --repeat 3
//
// Prints one `__BENCH__ {json}` line on stdout.

import { buildFixture } from './lib/fixtures.mjs'
import { snapshotJson, snapshotJsonCounting, stringify, utf8Bytes } from './lib/snapshot.mjs'
import { startRssSampler } from './lib/rss-sampler.mjs'
import { forceGc, heapUsed, settledHeap, startGcAccounting, ms } from './lib/measure.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const shape = arg('shape', 'flat-array')
const mib = Number(arg('mib', '1'))
const repeat = Number(arg('repeat', '3'))

const sampler = await startRssSampler(2)
const result = { shape, mib, repeat, ok: true }

try {
  const emptyHeap = settledHeap()
  const fixture = buildFixture(shape, mib)
  const fixtureHeap = settledHeap() - emptyHeap
  result.fixtureLiveHeapBytes = fixtureHeap

  // --- Phase A: current boundary path (deep copy + stringify), CPU + memory ---
  const plainRuns = []
  for (let iteration = 0; iteration < repeat; iteration++) {
    forceGc()
    const baseHeap = heapUsed()
    const baseRss = process.memoryUsage.rss()
    sampler.reset()
    const gcAccount = startGcAccounting()
    const t0 = performance.now()
    let snapshot = snapshotJson(fixture)
    const t1 = performance.now()
    let json = stringify(snapshot)
    const t2 = performance.now()
    const bytes = utf8Bytes(json)
    const t3 = performance.now()
    const transientHeap = heapUsed()
    const rssPeak = sampler.peak()
    const gc = gcAccount.stop()
    plainRuns.push({
      snapshotMs: ms(t1 - t0),
      stringifyMs: ms(t2 - t1),
      byteLengthMs: ms(t3 - t2),
      totalMs: ms(t3 - t0),
      jsonBytes: bytes,
      transientHeapDeltaBytes: transientHeap - baseHeap,
      rssPeakDeltaBytes: Math.max(0, rssPeak - baseRss),
      rssPeakBytes: rssPeak,
      gc,
    })
    snapshot = undefined
    json = undefined
  }
  result.plain = plainRuns

  // `--phases plain` stops here: one fixture, one capture, nothing retained —
  // the shape of a single real cell, used for the constrained-heap gate.
  if (arg('phases', 'all') === 'plain') {
    result.rssPeakOverallBytes = sampler.peak()
    result.maxRssBytes = process.resourceUsage().maxRSS * 1024
    await sampler.stop()
    process.stdout.write(`__BENCH__ ${JSON.stringify(result)}\n`)
    process.exit(0)
  }

  // --- Phase B: same traversal with node counting ---
  const countingRuns = []
  for (let iteration = 0; iteration < repeat; iteration++) {
    forceGc()
    sampler.reset()
    const t0 = performance.now()
    const counted = snapshotJsonCounting(fixture)
    const t1 = performance.now()
    let json = stringify(counted.snapshot)
    const t2 = performance.now()
    const bytes = utf8Bytes(json)
    const t3 = performance.now()
    countingRuns.push({
      snapshotMs: ms(t1 - t0),
      stringifyMs: ms(t2 - t1),
      totalMs: ms(t3 - t0),
      nodes: counted.nodes,
      jsonBytes: bytes,
      rssPeakBytes: sampler.peak(),
    })
    json = undefined
  }
  result.counting = countingRuns

  // --- Phase C: retained heap of the snapshot copy (retention option b) ---
  forceGc()
  const beforeRetain = heapUsed()
  const retained = snapshotJson(fixture)
  const retainedHeap = settledHeap() - beforeRetain
  result.snapshotRetainedHeapBytes = retainedHeap
  // keep `retained` reachable until after the reading above
  result.snapshotRetainedProbe = Array.isArray(retained) ? retained.length : typeof retained

  result.rssPeakOverallBytes = sampler.peak()
  result.maxRssBytes = process.resourceUsage().maxRSS * 1024
} catch (error) {
  result.ok = false
  result.error = `${error && error.name}: ${error && error.message}`
}

await sampler.stop()
process.stdout.write(`__BENCH__ ${JSON.stringify(result)}\n`)
