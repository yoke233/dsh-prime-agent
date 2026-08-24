// History budget gate: with a completion history filled to a candidate byte
// budget, does one more large capture still fit inside the worker's shipped
// 512 MiB old space (src/runtime.ts:44)?
//
// Retention is identity (history is the sole owner, the conservative case: the
// completion was a temporary, so history pays the full live heap). Entries use
// the record-array shape, which the capture benchmark showed has the worst
// live-heap-per-JSON-byte ratio of the realistic shapes.
//
// Usage (child):  node --expose-gc --max-old-space-size=512 bench/history-gate.mjs \
//                   --budget-mib 32 --entry-mib 4 --capture-mib 16
// Usage (driver): node bench/history-gate.mjs --sweep

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildFixture, MIB } from './lib/fixtures.mjs'
import { snapshotJsonCounting, stringify, utf8Bytes } from './lib/snapshot.mjs'
import { startRssSampler } from './lib/rss-sampler.mjs'
import { forceGc, heapUsed, settledHeap, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

if (process.argv.includes('--sweep')) {
  const heapMb = Number(arg('heap', '512'))
  const rows = []
  for (const budgetMib of [16, 32, 64, 128, 256]) {
    for (const captureMib of [16, 64]) {
      const row = await new Promise((resolve) => {
        const child = spawn(process.execPath, [
          '--expose-gc', `--max-old-space-size=${heapMb}`, join(here, 'history-gate.mjs'),
          '--budget-mib', String(budgetMib), '--entry-mib', '4', '--capture-mib', String(captureMib),
        ], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => { out += chunk })
        child.stderr.on('data', (chunk) => { err += chunk })
        child.on('close', (code) => {
          const line = out.split('\n').find((text) => text.startsWith('__GATE__'))
          if (!line) {
            resolve({
              budgetMib, captureMib, heapMb, survived: false,
              oom: /heap out of memory|Allocation failed/i.test(err),
              exitCode: code, stderrHead: err.slice(0, 200).replace(/\s+/g, ' '),
            })
            return
          }
          resolve(JSON.parse(line.slice('__GATE__ '.length)))
        })
      })
      rows.push(row)
      process.stderr.write(
        `heap=${heapMb}MiB historyBudget=${String(row.budgetMib).padStart(3)}MiB capture=${String(row.captureMib).padStart(2)}MiB -> ` +
        (row.survived
          ? `ok entries=${row.entries} historyHeap=${row.historyHeapMib}MiB captureMs=${row.captureMs} peakRSS=${row.peakRssMib}MiB heapAfter=${row.heapAfterMib}MiB`
          : `FAILED${row.oom ? ' (OOM)' : ''} ${row.stderrHead ?? row.error ?? ''}`) + '\n',
      )
    }
  }
  mkdirSync(join(here, 'results'), { recursive: true })
  writeFileSync(join(here, 'results', 'history-gate.json'), JSON.stringify({ node: process.version, heapMb, rows }, null, 2))
  process.stderr.write(`wrote ${join(here, 'results', 'history-gate.json')}\n`)
} else {
  const budgetMib = Number(arg('budget-mib', '32'))
  const entryMib = Number(arg('entry-mib', '4'))
  const captureMib = Number(arg('capture-mib', '16'))
  const sampler = await startRssSampler(2)
  const row = { budgetMib, entryMib, captureMib, heapMb: Number(arg('heap-label', '0')), survived: false }
  try {
    const base = settledHeap()
    const history = []
    let billedBytes = 0
    while (billedBytes + entryMib * MIB <= budgetMib * MIB) {
      const value = buildFixture('record-array', entryMib)
      billedBytes += utf8Bytes(stringify(snapshotJsonCounting(value).snapshot))
      history.push(value) // identity retention: the original object graph
    }
    row.entries = history.length
    row.billedBytes = billedBytes
    row.historyHeapMib = Math.round(((settledHeap() - base) / MIB) * 10) / 10

    // One more large completion arrives while the history is full.
    forceGc()
    const beforeRss = process.memoryUsage.rss()
    sampler.reset()
    const incoming = buildFixture('record-array', captureMib)
    const t0 = performance.now()
    const counted = snapshotJsonCounting(incoming)
    const json = stringify(counted.snapshot)
    const bytes = utf8Bytes(json)
    row.captureMs = ms(performance.now() - t0)
    row.captureBytes = bytes
    row.captureNodes = counted.nodes
    row.peakRssMib = Math.round((sampler.peak() / MIB) * 10) / 10
    row.peakRssDeltaMib = Math.round(((sampler.peak() - beforeRss) / MIB) * 10) / 10
    row.heapAfterMib = Math.round((heapUsed() / MIB) * 10) / 10
    row.survived = true
    row.probe = history.length + counted.nodes + json.length
  } catch (error) {
    row.error = `${error.name}: ${error.message}`
  }
  await sampler.stop()
  process.stdout.write(`__GATE__ ${JSON.stringify(row)}\n`)
}
