// G1 exit gate: Phase 2 projection cost on the REAL PersistentRealm path.
//
// Plan §4.4 (G1 restatement), §9 Phase 2 exit criterion.
//   "除「根对象 own keys 恰好枚举一次、绝不二次枚举」外，捕获与投影成本 O(准入天花板)"
//
// Method. A setup cell builds the shape into `globalThis.__v` and returns a
// tiny completion, so building is never inside a measured window. The measured
// cell is `globalThis.__v` alone: its wall time is the boundary cost — capture
// walk, projection, wire, ledger — and nothing else. Two control cells run in
// the same worker: `undefined` (run overhead floor) and `Object.keys(__v).length`
// (the single-enumeration floor G1 exempts, measured in situ instead of quoted).
//
// One shape+size per child process, so RSS readings are not polluted.
//
// Usage (child):  node --expose-gc bench/g1-exit-gate.mjs --shape wide-object --mib 64
// Usage (driver): node bench/g1-exit-gate.mjs --sweep [--sizes 8,16,64,128] [--heap 512]

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SHAPES, setupProgram, MEASURE_PROGRAM, ENUMERATE_ONCE_PROGRAM, OWN_KEYS_ONCE_PROGRAM, TOUCH_STRING_PROGRAM, EMPTY_PROGRAM } from './lib/realm-programs.mjs'
import { startRssSampler } from './lib/rss-sampler.mjs'
import { ms } from './lib/measure.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const MIB = 1024 * 1024

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

// The shipped runtime defaults (src/runtime.ts), so the gate measures what
// deployments actually get rather than a bench-tuned configuration.
const BUDGETS = {
  computeMs: 600_000,
  maxWallMs: 900_000,
  maxOutputBytes: 67_108_864,
  maxOldGenerationSizeMb: Number(arg('heap', '512')),
}

if (process.argv.includes('--sweep')) {
  const sizes = arg('sizes', '8,16,64,128').split(',').map(Number)
  const shapes = arg('shapes', SHAPES.join(',')).split(',')
  const rows = []
  for (const shape of shapes) {
    for (const mib of sizes) {
      const row = await new Promise((resolve) => {
        const child = spawn(process.execPath, [
          '--expose-gc', join(here, 'g1-exit-gate.mjs'),
          '--shape', shape, '--mib', String(mib), '--heap', String(BUDGETS.maxOldGenerationSizeMb),
          ...process.argv.includes('--skip-controls') ? ['--skip-controls'] : [],
        ], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => { out += chunk })
        child.stderr.on('data', (chunk) => { err += chunk })
        child.on('close', (code) => {
          const line = out.split('\n').find((text) => text.startsWith('__G1__'))
          resolve(line ? JSON.parse(line.slice('__G1__ '.length)) : {
            shape, mib, ok: false,
            oom: /heap out of memory|Allocation failed/i.test(err),
            exitCode: code, stderrHead: err.slice(0, 300).replace(/\s+/g, ' '),
          })
        })
      })
      rows.push(row)
      process.stderr.write(
        `${row.shape.padEnd(13)} ${String(row.mib).padStart(4)}MiB ` +
        (row.ok
          ? `capture=${String(row.measureMs).padStart(9)}ms ownKeysFloor=${String(row.ownKeysMs).padStart(9)}ms objKeys=${String(row.enumerateMs).padStart(9)}ms ` +
            `touch=${row.touchStringMs}ms peakRSSΔ=${row.measurePeakRssDeltaMib}MiB ` +
            `kind=${row.resultKind} retained=${row.retained} wire=${row.wireBytes}B`
          : `FAILED${row.oom ? ' (OOM)' : ''} ${row.error ?? row.stderrHead ?? ''}`) + '\n',
      )
    }
  }
  mkdirSync(join(here, 'results'), { recursive: true })
  const file = join(here, 'results', arg('out', 'g1-exit-gate.json'))
  writeFileSync(file, JSON.stringify({
    node: process.version,
    budgets: BUDGETS,
    generatedAt: new Date().toISOString(),
    rows,
  }, null, 2))
  process.stderr.write(`\nwrote ${file}\n`)
} else {
  const shape = arg('shape', 'flat-array')
  const mib = Number(arg('mib', '64'))
  const { PersistentRealm } = await import('../lib/realm/realm.js')

  const sampler = await startRssSampler(2)
  const row = { shape, mib, ok: false, heapMb: BUDGETS.maxOldGenerationSizeMb }
  const realm = new PersistentRealm({ realmId: `g1-${shape}-${mib}`, budgets: BUDGETS })

  /** Run one cell, timing it and sampling process RSS across the call. */
  async function timed(program) {
    const baseRss = process.memoryUsage.rss()
    sampler.reset()
    const started = performance.now()
    const result = await realm.run({ program, bindings: [] })
    const elapsed = performance.now() - started
    return {
      elapsedMs: ms(elapsed),
      peakRssDeltaMib: Math.round(((sampler.peak() - baseRss) / MIB) * 10) / 10,
      peakRssMib: Math.round((sampler.peak() / MIB) * 10) / 10,
      result,
    }
  }

  try {
    // Warm the worker and the boundary path so the measured cell pays no
    // first-call cost that a real session would already have paid.
    await realm.run({ program: EMPTY_PROGRAM, bindings: [] })

    const setup = await timed(setupProgram(shape, mib))
    if (setup.result.error) throw new Error(`setup failed: ${setup.result.error.kind}: ${setup.result.error.message}`)
    row.setupMs = setup.elapsedMs
    row.setupPeakRssMib = setup.peakRssMib

    const empty = await timed(EMPTY_PROGRAM)
    row.emptyMs = empty.elapsedMs

    // Force any rope flattening BEFORE the measured cell, so a fixture's string
    // representation is never charged to the capture walk.
    const touched = await timed(TOUCH_STRING_PROGRAM)
    row.touchStringMs = touched.elapsedMs

    // The measured cell: `__v` as the completion value.
    const measured = await timed(MEASURE_PROGRAM)
    row.measureMs = measured.elapsedMs
    row.measurePeakRssDeltaMib = measured.peakRssDeltaMib
    row.measurePeakRssMib = measured.peakRssMib

    const wire = measured.result
    row.wireBytes = Buffer.byteLength(JSON.stringify(wire.value ?? null), 'utf8')
    if (wire.error) {
      row.resultKind = `error:${wire.error.kind}`
      row.errorMessage = wire.error.message.slice(0, 160)
    } else if (wire.value && typeof wire.value === 'object' && wire.value.truncated === true) {
      row.resultKind = 'projected'
      row.retained = wire.value.retained
      row.reason = wire.value.reason ?? null
      row.serializedBytesAtCapture = wire.value.serializedBytesAtCapture ?? null
      row.projectionType = wire.value.projection?.type ?? null
      row.projectionKeyCount = wire.value.projection?.keyCount ?? null
      row.projectionLength = wire.value.projection?.length ?? null
      row.sampleCount = wire.value.projection?.items?.length ?? wire.value.projection?.keys?.length ?? null
    } else {
      row.resultKind = 'full'
      row.retained = null
    }

    // Controls: exactly one root enumeration over the same value, same worker.
    // ownKeys is the floor the walk actually pays (realm-worker.ts:933).
    //
    // `--skip-controls` exists because the control is itself expensive on a huge
    // root array: enumerating a 13.4M-element array costs seconds and over a
    // GiB, which can take the worker out AFTER the measured cell already
    // succeeded. Skipping isolates the implementation from the instrument.
    if (!process.argv.includes('--skip-controls')) {
      const enumerated = await timed(ENUMERATE_ONCE_PROGRAM)
      row.enumerateMs = enumerated.elapsedMs
      row.enumerateResult = enumerated.result.value ?? null

      const ownKeys = await timed(OWN_KEYS_ONCE_PROGRAM)
      row.ownKeysMs = ownKeys.elapsedMs
    } else {
      row.controlsSkipped = true
    }

    // Second measured cell: identity-reuse means no new capture walk should be
    // needed, so a repeat of the same value isolates walk cost from wire cost.
    const repeat = await timed(MEASURE_PROGRAM)
    row.repeatMeasureMs = repeat.elapsedMs

    row.ok = true
  } catch (error) {
    row.error = `${error.name}: ${error.message}`
  } finally {
    await realm.dispose().catch(() => {})
    await sampler.stop()
  }
  process.stdout.write(`__G1__ ${JSON.stringify(row)}\n`)
  process.exit(0)
}
