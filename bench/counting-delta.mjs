// Isolated measurement of the node-counting increment.
//
// The matrix driver runs all plain iterations before all counting iterations,
// so its A/B delta carries heap-state noise. This script interleaves the two
// variants in one process and reports min (cleanest CPU signal) and median.
//
// Usage: node --expose-gc --max-old-space-size=8192 bench/counting-delta.mjs \
//          [--sizes 1,8,16] [--repeat 9]
// Writes bench/results/counting-delta.json

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildFixture, SHAPES } from './lib/fixtures.mjs'
import { snapshotJson, snapshotJsonCounting } from './lib/snapshot.mjs'
import { forceGc, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const sizes = arg('sizes', '1,8,16').split(',').map(Number)
const repeat = Number(arg('repeat', '9'))

const min = (values) => Math.min(...values)
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

const rows = []
for (const size of sizes) {
  for (const shape of SHAPES) {
    const fixture = buildFixture(shape, size)
    const plain = []
    const counting = []
    let nodes = 0
    // one warm-up pair before timing
    snapshotJson(fixture)
    snapshotJsonCounting(fixture)
    forceGc()
    for (let iteration = 0; iteration < repeat; iteration++) {
      let t0 = performance.now()
      let held = snapshotJson(fixture)
      plain.push(performance.now() - t0)
      held = undefined
      forceGc()
      t0 = performance.now()
      let counted = snapshotJsonCounting(fixture)
      counting.push(performance.now() - t0)
      nodes = counted.nodes
      counted = undefined
      forceGc()
    }
    const row = {
      shape,
      mib: size,
      nodes,
      plainMinMs: ms(min(plain)),
      countingMinMs: ms(min(counting)),
      plainMedianMs: ms(median(plain)),
      countingMedianMs: ms(median(counting)),
      deltaMinPct: Math.round((min(counting) / min(plain) - 1) * 1000) / 10,
      deltaMedianPct: Math.round((median(counting) / median(plain) - 1) * 1000) / 10,
      nsPerNodePlain: nodes ? Math.round((min(plain) * 1e6) / nodes) : null,
      nsPerNodeCounting: nodes ? Math.round((min(counting) * 1e6) / nodes) : null,
    }
    rows.push(row)
    process.stderr.write(
      `${shape.padEnd(13)} ${String(size).padStart(3)}MiB nodes=${String(nodes).padStart(8)}` +
      ` plain=${row.plainMinMs}ms counting=${row.countingMinMs}ms delta=${row.deltaMinPct}%` +
      ` (median ${row.deltaMedianPct}%)\n`,
    )
  }
}

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'counting-delta.json'), JSON.stringify({ node: process.version, repeat, rows }, null, 2))
process.stderr.write(`wrote ${join(here, 'results', 'counting-delta.json')}\n`)
