// FIFO admission/eviction simulation (plan §5.2 / §5.3).
//
// Question: with per-slot billing (no identity dedup), does a `$out(id)`
// recirculation trace flush the history — in particular, does the id the model
// is actively using get evicted by its own re-entry?
//
// Pure simulation: entries carry recorded byte/node costs, not real payloads,
// so budgets can be swept cheaply. The costs come from the capture benchmark.
//
// Usage: node bench/fifo-bench.mjs
// Writes bench/results/fifo.json

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const MIB = 1024 * 1024

/**
 * Runtime-owned completion history with three budgets and FIFO eviction.
 *
 * `billing` selects the duplicate-handling policy under test:
 *   per-slot        every push takes a fresh slot and pays full cost (plan §5.2 default)
 *   identity-dedup  a repeat takes a fresh slot but pays nothing
 *   identity-reuse  a repeat takes NO new slot; the existing id is returned,
 *                   keeping its original FIFO position
 */
class History {
  constructor({ maxEntries, maxBytes, maxNodes, billing }) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.maxNodes = maxNodes
    this.billing = billing
    this.slots = new Map() // id -> { id, obj, bytes, nodes, billed }
    this.bytes = 0
    this.nodes = 0
    this.evicted = []
    this.rejected = []
  }

  /** True when a live slot already holds this exact object. */
  findIdentity(obj) {
    for (const slot of this.slots.values()) if (slot.obj === obj) return slot
    return null
  }

  push(id, obj, bytes, nodes) {
    if (bytes > this.maxBytes || nodes > this.maxNodes) {
      this.rejected.push(id) // retained:false, history untouched (plan §5.3)
      return { retained: false, id: null }
    }
    if (this.billing === 'identity-reuse') {
      const existing = this.findIdentity(obj)
      // The value is already retained under a stable id; no new slot, no recharge.
      if (existing) return { retained: true, id: existing.id, reused: true }
    }
    const duplicate = this.billing === 'identity-dedup' ? this.findIdentity(obj) : null
    // Under dedup billing a repeat costs nothing; the slot is added as an alias.
    const billedBytes = duplicate ? 0 : bytes
    const billedNodes = duplicate ? 0 : nodes
    while (
      this.slots.size + 1 > this.maxEntries ||
      this.bytes + billedBytes > this.maxBytes ||
      this.nodes + billedNodes > this.maxNodes
    ) {
      const oldest = this.slots.keys().next()
      if (oldest.done) break
      const slot = this.slots.get(oldest.value)
      this.slots.delete(oldest.value)
      this.bytes -= slot.billedBytes
      this.nodes -= slot.billedNodes
      this.evicted.push(oldest.value)
    }
    this.slots.set(id, { id, obj, bytes, nodes, billedBytes, billedNodes })
    this.bytes += billedBytes
    this.nodes += billedNodes
    return { retained: true, id }
  }

  liveIds() { return [...this.slots.keys()] }
  distinctObjects() { return new Set([...this.slots.values()].map((slot) => slot.obj)).size }
}

/** One synthetic cell: a completion value with its capture cost. */
function cell(obj, mibSize, nodesPerMib = 100000) {
  return { obj, bytes: Math.round(mibSize * MIB), nodes: Math.round(mibSize * nodesPerMib) }
}

/** Traces are (name, builder) pairs; builder returns a list of cells to push. */
function traces() {
  const list = []

  // 1. Explore, then recirculate one earlier result as the final expression.
  {
    const distinct = []
    for (let index = 0; index < 12; index++) distinct.push(cell({ tag: `d${index}` }, 2))
    const target = distinct[2]
    const cells = [...distinct]
    for (let repeat = 0; repeat < 8; repeat++) cells.push(target) // `$out(3)` as the last expression
    list.push({ name: 'explore-then-recirculate (12x2MiB, then $out(3) x8)', cells, watchIndex: 2 })
  }

  // 2. Interleaved: alternate a fresh small result with an echo of an old big one.
  {
    const big = cell({ tag: 'big' }, 8)
    const cells = [big]
    for (let index = 0; index < 10; index++) {
      cells.push(cell({ tag: `s${index}` }, 0.1))
      cells.push(big) // `_` / `$out(1)` echoed back
    }
    list.push({ name: 'echo-loop (1x8MiB echoed between 10 small results)', cells, watchIndex: 0 })
  }

  // 3. One result close to the whole byte budget, re-entered twice.
  {
    const heavy = cell({ tag: 'heavy' }, 24)
    const cells = [cell({ tag: 'pre' }, 1), heavy, heavy, heavy]
    list.push({ name: 'single-heavy-repeat (24MiB pushed 3x)', cells, watchIndex: 1 })
  }

  // 4. Filter chain: each cell derives a NEW smaller object (no identity reuse).
  {
    const cells = [cell({ tag: 'src' }, 16)]
    for (let index = 0; index < 10; index++) cells.push(cell({ tag: `f${index}` }, 0.5))
    list.push({ name: 'filter-chain (16MiB source, 10 derived slices)', cells, watchIndex: 0 })
  }

  return list
}

const budgets = [
  { name: 'entries=16 bytes=32MiB nodes=4M', maxEntries: 16, maxBytes: 32 * MIB, maxNodes: 4_000_000 },
  { name: 'entries=16 bytes=64MiB nodes=8M', maxEntries: 16, maxBytes: 64 * MIB, maxNodes: 8_000_000 },
  { name: 'entries=32 bytes=64MiB nodes=8M', maxEntries: 32, maxBytes: 64 * MIB, maxNodes: 8_000_000 },
  { name: 'entries=8  bytes=16MiB nodes=2M', maxEntries: 8, maxBytes: 16 * MIB, maxNodes: 2_000_000 },
]

const report = []
for (const budget of budgets) {
  for (const trace of traces()) {
    for (const billing of ['per-slot', 'identity-dedup', 'identity-reuse']) {
      const history = new History({ ...budget, billing })
      let nextId = 1
      const ids = []
      for (const item of trace.cells) {
        // An id is consumed only when a new slot is created; identity-reuse
        // hands the model back the id the value already has.
        const probe = history.findIdentity(item.obj)
        const reuse = billing === 'identity-reuse' && probe
        const id = reuse ? probe.id : nextId++
        ids.push(history.push(id, item.obj, item.bytes, item.nodes).id)
      }
      const watchedId = ids[trace.watchIndex]
      report.push({
        budget: budget.name,
        trace: trace.name,
        billing,
        pushes: trace.cells.length,
        liveSlots: history.slots.size,
        distinctObjectsRetained: history.distinctObjects(),
        evictions: history.evicted.length,
        rejected: history.rejected.length,
        idsConsumed: nextId - 1,
        watchedId,
        watchedIdSurvived: watchedId !== null && history.slots.has(watchedId),
        watchedObjectStillReachable: [...history.slots.values()].some((slot) => slot.obj === trace.cells[trace.watchIndex].obj),
        liveIds: history.liveIds(),
        bytesInUseMiB: Math.round((history.bytes / MIB) * 100) / 100,
      })
    }
  }
}

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'fifo.json'), JSON.stringify(report, null, 2))

for (const row of report) {
  process.stderr.write(
    `${row.budget} | ${row.trace}\n  ${row.billing.padEnd(14)} live=${row.liveSlots} distinct=${row.distinctObjectsRetained}` +
    ` evict=${row.evictions} watched#${row.watchedId} survived=${row.watchedIdSurvived}` +
    ` objReachable=${row.watchedObjectStillReachable}\n`,
  )
}
process.stderr.write(`\nwrote ${join(here, 'results', 'fifo.json')}\n`)
