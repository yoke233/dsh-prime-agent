// The projector benchmark showed a bounded projection costing ~0.003 ms on
// every shape EXCEPT wide-object, where it cost 787 ms at 64 MiB. The cause is
// `Object.keys(value)` — it materializes all 2.3M keys before the projector
// takes its first 16. This measures the alternatives.
//
// Usage: node --expose-gc --max-old-space-size=8192 bench/key-iteration-bench.mjs
// Writes bench/results/key-iteration.json

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildFixture } from './lib/fixtures.mjs'
import { forceGc, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const strategies = {
  'Object.keys().slice(0,16)': (value) => Object.keys(value).slice(0, 16),
  'Reflect.ownKeys().slice(0,16)': (value) => Reflect.ownKeys(value).slice(0, 16),
  'for..in + break at 16': (value) => {
    const keys = []
    for (const key of Object.keys(value)) { // eslint-disable-line
      keys.push(key)
      if (keys.length === 16) break
    }
    return keys
  },
  'for..in statement + break at 16': (value) => {
    const keys = []
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      keys.push(key)
      if (keys.length === 16) break
    }
    return keys
  },
}

const rows = []
for (const mib of [1, 16, 64]) {
  const value = buildFixture('wide-object', mib)
  for (const [name, strategy] of Object.entries(strategies)) {
    forceGc()
    const times = []
    for (let iteration = 0; iteration < 5; iteration++) {
      const t0 = performance.now()
      const keys = strategy(value)
      times.push(performance.now() - t0)
      if (keys.length !== 16) throw new Error(`${name} returned ${keys.length} keys`)
    }
    const row = { mib, strategy: name, minMs: ms(Math.min(...times)) }
    rows.push(row)
    process.stderr.write(`${String(mib).padStart(3)}MiB ${name.padEnd(32)} ${row.minMs}ms\n`)
  }
}

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'key-iteration.json'), JSON.stringify({ node: process.version, rows }, null, 2))
process.stderr.write(`wrote ${join(here, 'results', 'key-iteration.json')}\n`)
