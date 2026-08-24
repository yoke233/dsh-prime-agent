// Heap cost per NODE, for shapes where JSON bytes badly underestimate heap.
//
// The byte budget cannot bound heap on its own: `[[],[],[],...]` costs 3 JSON
// bytes per element but a whole object per element in the heap. This measures
// the heap-per-node and heap-per-JSON-byte of the densest legal shapes, which
// is what maxCompletionHistoryNodes has to be sized against.
//
// One shape per child process: retaining a multi-hundred-MiB graph leaves the
// heap unsettled for the next shape, so in-process iteration produces negative
// deltas. The driver spawns a fresh child per shape.
//
// Usage: node bench/node-density-bench.mjs [--mib 16]
// Writes bench/results/node-density.json

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { snapshotJsonCounting, stringify, utf8Bytes } from './lib/snapshot.mjs'
import { forceGc, heapUsed, settledHeap, ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const MIB = 1024 * 1024

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

// Each builder is `bytesPerElement` -> array of that many elements.
const SHAPES = {
  'zeros': { bytesPerElement: 2, build: (count) => Array.from({ length: count }, () => 0) },
  'empty-arrays': { bytesPerElement: 3, build: (count) => Array.from({ length: count }, () => []) },
  'empty-objects': { bytesPerElement: 3, build: (count) => Array.from({ length: count }, () => ({})) },
  'one-key-objects': { bytesPerElement: 9, build: (count) => Array.from({ length: count }, (_, index) => ({ a: index % 10 })) },
  'empty-strings': { bytesPerElement: 3, build: (count) => Array.from({ length: count }, () => '') },
  'nulls': { bytesPerElement: 5, build: (count) => Array.from({ length: count }, () => null) },
}

const mib = Number(arg('mib', '16'))
const shape = arg('shape', null)

if (shape === null) {
  const rows = []
  for (const name of Object.keys(SHAPES)) {
    const row = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        '--expose-gc', '--max-old-space-size=12288',
        join(here, 'node-density-bench.mjs'), '--shape', name, '--mib', String(mib),
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('close', () => {
        const line = out.split('\n').find((text) => text.startsWith('__DENSITY__'))
        resolve(line ? JSON.parse(line.slice('__DENSITY__ '.length)) : { shape: name, error: err.slice(0, 200) })
      })
    })
    rows.push(row)
    process.stderr.write(
      `${row.shape.padEnd(17)} elements=${String(row.elements).padStart(9)} json=${Math.round((row.jsonBytes / MIB) * 10) / 10}MiB` +
      ` nodes=${row.nodes} liveHeap=${Math.round((row.liveHeapBytes / MIB) * 10) / 10}MiB` +
      ` snapHeap=${Math.round((row.snapshotHeapBytes / MIB) * 10) / 10}MiB` +
      ` heap/jsonByte=${row.liveHeapPerJsonByte} heap/node=${row.liveHeapPerNode}B snap=${row.snapshotMs}ms\n`,
    )
  }
  mkdirSync(join(here, 'results'), { recursive: true })
  writeFileSync(join(here, 'results', 'node-density.json'), JSON.stringify({ node: process.version, mib, rows }, null, 2))
  process.stderr.write(`wrote ${join(here, 'results', 'node-density.json')}\n`)
} else {
  const spec = SHAPES[shape]
  const count = Math.floor((mib * MIB) / spec.bytesPerElement)
  forceGc()
  const base = heapUsed()
  const value = spec.build(count)
  const liveHeap = settledHeap() - base
  const t0 = performance.now()
  const counted = snapshotJsonCounting(value)
  const snapshotMs = performance.now() - t0
  const json = stringify(counted.snapshot)
  const bytes = utf8Bytes(json)
  const afterSnapshot = settledHeap()
  const snapshotHeap = afterSnapshot - base - liveHeap
  process.stdout.write(`__DENSITY__ ${JSON.stringify({
    shape,
    elements: count,
    jsonBytes: bytes,
    nodes: counted.nodes,
    liveHeapBytes: liveHeap,
    snapshotHeapBytes: snapshotHeap,
    liveHeapPerJsonByte: Math.round((liveHeap / bytes) * 100) / 100,
    liveHeapPerNode: Math.round((liveHeap / counted.nodes) * 10) / 10,
    snapshotMs: ms(snapshotMs),
    probe: counted.snapshot.length + json.length,
  })}\n`)
}
