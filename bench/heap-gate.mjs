// Constrained-heap gate: does ONE capture of a large completion survive the
// worker's real heap cap?
//
// src/runtime.ts:44 ships maxOldGenerationSizeMb = 512, and src/runtime.ts:43
// ships maxOutputBytes = 67_108_864 (64 MiB) — so a 64 MiB completion is a
// legal value the current boundary will try to deep-copy and stringify inside a
// 512 MiB old space.
//
// Usage: node bench/heap-gate.mjs [--heaps 512,768,1024] [--mib 64]
// Writes bench/results/heap-gate.json

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

const heaps = arg('heaps', '512,768,1024').split(',').map(Number)
const mib = Number(arg('mib', '64'))

function runCase(shape, heapMb) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      `--max-old-space-size=${heapMb}`,
      join(here, 'capture-bench.mjs'),
      '--shape', shape, '--mib', String(mib), '--repeat', '1', '--phases', 'plain',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => {
      const line = out.split('\n').find((text) => text.startsWith('__BENCH__'))
      if (!line) {
        const oom = /heap out of memory|Allocation failed|JavaScript heap/i.test(err)
        resolve({ shape, mib, heapMb, survived: false, oom, exitCode: code, stderrHead: err.slice(0, 300).replace(/\s+/g, ' ') })
        return
      }
      const parsed = JSON.parse(line.slice('__BENCH__ '.length))
      resolve({
        shape, mib, heapMb,
        survived: parsed.ok,
        error: parsed.error ?? null,
        totalMs: parsed.ok ? parsed.plain[0].totalMs : null,
        jsonBytes: parsed.ok ? parsed.plain[0].jsonBytes : null,
        rssPeakDeltaBytes: parsed.ok ? parsed.plain[0].rssPeakDeltaBytes : null,
        maxRssBytes: parsed.maxRssBytes ?? null,
      })
    })
  })
}

const rows = []
for (const heapMb of heaps) {
  for (const shape of SHAPES) {
    const row = await runCase(shape, heapMb)
    rows.push(row)
    process.stderr.write(
      `heap=${String(heapMb).padStart(5)}MiB ${shape.padEnd(13)} ${mib}MiB -> ` +
      (row.survived
        ? `ok in ${row.totalMs}ms, peakRSSΔ=${Math.round((row.rssPeakDeltaBytes / (1024 * 1024)) * 10) / 10}MiB, maxRSS=${Math.round((row.maxRssBytes / (1024 * 1024)) * 10) / 10}MiB`
        : `FAILED${row.oom ? ' (OOM)' : ''} ${row.error ?? row.stderrHead ?? ''}`) + '\n',
    )
  }
}

mkdirSync(join(here, 'results'), { recursive: true })
writeFileSync(join(here, 'results', 'heap-gate.json'), JSON.stringify({ node: process.version, mib, heaps, rows }, null, 2))
process.stderr.write(`wrote ${join(here, 'results', 'heap-gate.json')}\n`)
