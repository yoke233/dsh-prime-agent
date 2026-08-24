// Adversarial shapes for the admission budgets.
//
// 1. Shared-reference amplification. snapshotValue's `seen` set is a PATH set:
//    it deletes on exit (realm-worker.ts:674), so it rejects cycles but expands
//    every path through a shared sub-object. A DAG with tiny live heap therefore
//    snapshots and stringifies into something exponentially larger. Any node /
//    byte budget must be enforced DURING the traversal, not after it.
//
// 2. Recursion depth. snapshotValue recurses per level; this probes the depth
//    at which the boundary throws RangeError instead of a clean diagnostic.
//
// Usage: node --expose-gc --max-old-space-size=4096 bench/adversarial-bench.mjs
// Writes bench/results/adversarial.json

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sharedDag } from './lib/fixtures.mjs'
import { snapshotJsonCounting, stringify, utf8Bytes } from './lib/snapshot.mjs'
import { forceGc, heapUsed, settledHeap, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = { node: process.version, amplification: [], depth: {} }

/**
 * Distinct live objects/values in a sharedDag: one payload array of `leafCount`
 * numbers plus its wrapper, plus one parent object per level. The live graph is
 * a few kilobytes regardless of how large its snapshot expansion becomes, and
 * that is far below GC measurement noise, so it is counted rather than weighed.
 */
function liveNodes({ leafBytes, levels }) {
  const leafCount = Math.max(1, Math.floor(leafBytes / 10))
  return leafCount + 2 + levels
}

for (const spec of [
  { leafBytes: 1024, fanout: 2, levels: 8 },
  { leafBytes: 1024, fanout: 2, levels: 14 },
  { leafBytes: 1024, fanout: 2, levels: 18 },
  { leafBytes: 4096, fanout: 4, levels: 6 },
  { leafBytes: 16384, fanout: 8, levels: 4 },
]) {
  forceGc()
  const base = heapUsed()
  const value = sharedDag(spec)
  const liveHeap = settledHeap() - base
  let record
  try {
    const t0 = performance.now()
    const counted = snapshotJsonCounting(value)
    const t1 = performance.now()
    const bytes = utf8Bytes(stringify(counted.snapshot))
    const t2 = performance.now()
    record = {
      ...spec,
      liveHeapBytes: liveHeap,
      snapshotMs: ms(t1 - t0),
      stringifyMs: ms(t2 - t1),
      nodes: counted.nodes,
      liveNodes: liveNodes(spec),
      nodeAmplification: Math.round((counted.nodes / liveNodes(spec)) * 10) / 10,
      jsonBytes: bytes,
      ok: true,
    }
  } catch (error) {
    record = { ...spec, liveHeapBytes: liveHeap, ok: false, error: `${error.name}: ${error.message}` }
  }
  out.amplification.push(record)
  process.stderr.write(`dag fanout=${spec.fanout} levels=${spec.levels}: ${JSON.stringify(record)}\n`)
}

// --- recursion depth probe -------------------------------------------------
function chain(depth) {
  let node = { leaf: 1 }
  for (let level = 0; level < depth; level++) node = { v: node }
  return node
}

function survives(depth) {
  try {
    snapshotJsonCounting(chain(depth))
    return true
  } catch (error) {
    return error.name === 'RangeError' ? false : `other: ${error.name}`
  }
}

let low = 1
let high = 1
while (survives(high) === true && high < 2_000_000) {
  low = high
  high *= 2
}
while (high - low > 1) {
  const middle = Math.floor((low + high) / 2)
  if (survives(middle) === true) low = middle
  else high = middle
}
out.depth = { maxSurvivedDepth: low, firstFailingDepth: high, failureAt: survives(high) }
process.stderr.write(`recursion depth: survives ${low}, fails at ${high} (${JSON.stringify(out.depth.failureAt)})\n`)

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'adversarial.json'), JSON.stringify(out, null, 2))
process.stderr.write(`wrote ${join(here, 'results', 'adversarial.json')}\n`)
