// Driver for capture-bench.mjs: one fresh child process per (shape, size) case
// so heap and RSS readings are not polluted by earlier cases.
//
// Usage:
//   node bench/run-capture.mjs [--sizes 1,8,16,64] [--repeat 3] [--heap 6144]
// Writes bench/results/capture.json and prints a summary table.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SHAPES } from './lib/fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const sizes = arg('sizes', '1,8,16,64').split(',').map(Number)
const repeat = arg('repeat', '3')
const heapMb = arg('heap', '6144')

function runCase(shape, mib) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      `--max-old-space-size=${heapMb}`,
      join(here, 'capture-bench.mjs'),
      '--shape', shape,
      '--mib', String(mib),
      '--repeat', repeat,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => {
      const line = out.split('\n').find((text) => text.startsWith('__BENCH__'))
      if (!line) {
        resolve({ shape, mib, ok: false, error: `exit ${code}: ${err.slice(0, 400).replace(/\s+/g, ' ')}` })
        return
      }
      resolve(JSON.parse(line.slice('__BENCH__ '.length)))
    })
    child.on('error', reject)
  })
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const mib = (bytes) => Math.round((bytes / (1024 * 1024)) * 100) / 100

const results = []
for (const size of sizes) {
  for (const shape of SHAPES) {
    process.stderr.write(`running ${shape} @ ${size} MiB ...\n`)
    const result = await runCase(shape, size)
    results.push(result)
    if (!result.ok) {
      process.stderr.write(`  FAILED: ${result.error}\n`)
      continue
    }
    const plainTotal = median(result.plain.map((run) => run.totalMs))
    const plainSnapshot = median(result.plain.map((run) => run.snapshotMs))
    const countTotal = median(result.counting.map((run) => run.snapshotMs))
    process.stderr.write(
      `  json=${mib(result.plain[0].jsonBytes)}MiB live=${mib(result.fixtureLiveHeapBytes)}MiB` +
      ` snap=${plainSnapshot}ms total=${plainTotal}ms count+=${Math.round((countTotal / plainSnapshot - 1) * 1000) / 10}%` +
      ` nodes=${result.counting[0].nodes} peakRSSΔ=${mib(median(result.plain.map((run) => run.rssPeakDeltaBytes)))}MiB` +
      ` retainedSnap=${mib(result.snapshotRetainedHeapBytes)}MiB\n`,
    )
  }
}

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'capture.json'), JSON.stringify({
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  heapMb: Number(heapMb),
  repeat: Number(repeat),
  generatedAt: new Date().toISOString(),
  results,
}, null, 2))
process.stderr.write(`\nwrote ${join(here, 'results', 'capture.json')}\n`)
