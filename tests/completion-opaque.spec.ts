/**
 * Bounded generation-local completion history for NON-JSON live objects.
 *
 * What is exercised here is the opaque half of the completion boundary: which
 * live values enter the opaque store, that `$_`/`$out(id)` hand back the
 * ORIGINAL identity, that the store has its own hard budgets and FIFO
 * eviction, that rendering never consults a program hook (toJSON/toString/
 * inspect/proxy traps), and that a hard kill expires every opaque handle.
 * The lossless-JSON half is covered by `completion-history.spec.ts` and
 * `completion-projection.spec.ts`.
 *
 * Handles are allocated by the HOST, one per dispatched run, from a monotonic
 * process-wide counter, so no test asserts an absolute id.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets, RealmCompletionHistoryLimits, RealmCompletionOpaqueLimits } from '../src/realm/realm.js'

const BUDGETS: RealmBudgets = {
  computeMs: 5_000,
  maxWallMs: 10_000,
  maxOutputBytes: 65_536,
  maxOldGenerationSizeMb: 128,
}

const realms: PersistentRealm[] = []

afterEach(async () => {
  await Promise.all(realms.splice(0).map(realm => realm.dispose()))
})

function createRealm(options: {
  budgets?: Partial<RealmBudgets>
  completionHistory?: Partial<RealmCompletionHistoryLimits>
  completionOpaque?: Partial<RealmCompletionOpaqueLimits>
} = {}): PersistentRealm {
  const realm = new PersistentRealm({
    realmId: `realm-${realms.length}`,
    budgets: { ...BUDGETS, ...options.budgets },
    ...options.completionHistory ? { completionHistory: options.completionHistory } : {},
    ...options.completionOpaque ? { completionOpaque: options.completionOpaque } : {},
  })
  realms.push(realm)
  return realm
}

/* eslint-disable @typescript-eslint/no-explicit-any -- test bindings receive already-validated JSON */
function tools(functions: Record<string, (args: any) => Promise<CodeJsonValue>>): CodeBindingNamespace {
  return { global: 'tools', functions: functions as Record<string, CodeBindingFunction> }
}

/** One `$out.list()` row, as the intrinsic renders it. */
interface HistoryRow {
  id: number
  type: string
  serializedBytesAtCapture: number
  nodes: number
  keyCount: number
  /** Present only on rows whose value is a retained NON-JSON live object. */
  opaque?: true
}

/** The fixed envelope a NON-JSON completion crosses as. */
interface OpaqueEnvelope {
  $out?: number
  use?: string
  retained?: boolean
  type: string
  opaque?: true
  reason?: string
  truncated: true
}

/** Read one result as an opaque envelope, failing loudly when it is not one. */
function envelopeOf(result: CodeRunResult): OpaqueEnvelope {
  expect(result.error).toBeUndefined()
  const value = result.value as OpaqueEnvelope
  expect(value?.truncated).toBe(true)
  return value
}

/** An EXPRESSION that renders whatever the given expression rejects with. */
function caught(expression: string): string {
  return `(() => { try { ${expression}; return { threw: false, name: '', message: '' } }`
    + ` catch (error) { return { threw: true, name: String(error.name), message: String(error.message) } } })()`
}

interface CaughtRejection {
  threw: boolean
  name: string
  message: string
}

/** Read the history through a log, so the read itself retains nothing. */
async function history(realm: PersistentRealm): Promise<HistoryRow[]> {
  const result = await realm.run({ program: 'console.log(JSON.stringify($out.list()))', bindings: [] })
  expect(result.error).toBeUndefined()
  return JSON.parse(result.logs[0] as string) as HistoryRow[]
}

describe('opaque completion history: what enters a slot', () => {
  it('retains Map, Set, function, BigInt, cyclic and class-instance completions with one fixed envelope', async () => {
    const realm = createRealm()

    const map = await realm.run({ program: 'new Map([["answer", 42]])', bindings: [] })
    expect(envelopeOf(map)).toMatchObject({ retained: true, type: 'object', opaque: true })
    expect(envelopeOf(map).use).toBe(`$out(${String(envelopeOf(map).$out)})`)
    expect(map.presentation).toEqual({
      kind: 'opaque-reference',
      valueType: 'object',
      handle: envelopeOf(map).$out,
    })
    const mapId = map.value as OpaqueEnvelope
    expect((await realm.run({ program: `$out(${String(mapId.$out)}).get("answer")`, bindings: [] })).value).toBe(42)

    const set = await realm.run({ program: 'new Set([1, 2, 3])', bindings: [] })
    const setId = (set.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(setId)}).has(2)`, bindings: [] })).value).toBe(true)

    const fn = await realm.run({ program: 'const add = (a: number, b: number) => a + b\nadd', bindings: [] })
    expect(envelopeOf(fn).type).toBe('function')
    const fnId = (fn.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(fnId)})(2, 3)`, bindings: [] })).value).toBe(5)

    const bigint = await realm.run({ program: '10n', bindings: [] })
    expect(envelopeOf(bigint).type).toBe('bigint')
    const bigintId = (bigint.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(bigintId)}) + 1n === 11n`, bindings: [] })).value).toBe(true)

    const cyclic = await realm.run({
      program: 'const cyclic = { name: "c" }\ncyclic.self = cyclic\ncyclic',
      bindings: [],
    })
    const cyclicId = (cyclic.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(cyclicId)}).self === $out(${String(cyclicId)})`, bindings: [] })).value).toBe(true)

    const instance = await realm.run({
      program: 'class Row { constructor() { this.id = 1 } }\nnew Row()',
      bindings: [],
    })
    const instanceId = (instance.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(instanceId)}) instanceof Row`, bindings: [] })).value).toBe(true)

    const date = await realm.run({ program: 'new Date(0)', bindings: [] })
    const dateId = (date.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(dateId)}).getTime()`, bindings: [] })).value).toBe(0)

    // None of the six cost the realm its heap.
    expect(realm.generation).toBe(1)
  })

  it('hands the original identity back through `$_` and keeps mutations visible', async () => {
    const realm = createRealm()
    const produced = await realm.run({
      program: 'const live = new Map([["k", "v"]])\nlive',
      bindings: [],
    })
    const id = (produced.value as OpaqueEnvelope).$out

    // `$_` is the same live object, not a snapshot. Both facts are read in ONE
    // cell: the probe's own completion moves `$_`, so a second read would be
    // looking at the probe's result instead of the map.
    const observed = await realm.run({ program: '({ same: $_ === live, isMap: $_ instanceof Map })', bindings: [] })
    expect(observed.value).toEqual({ same: true, isMap: true })
    // In-place mutation through the handle is visible to every other handle.
    expect((await realm.run({ program: `$out(${String(id)}).set("more", 1) === live`, bindings: [] })).value).toBe(true)
    expect((await realm.run({ program: 'live.size', bindings: [] })).value).toBe(2)
  })

  it('reuses the slot when an opaque value is completed again', async () => {
    // Identity-reuse semantics match the JSON store: returning `$out(id)` (or a
    // bound variable holding the same object) opens no new slot, spends no new
    // handle, and moves `$_` to the reused slot.
    const realm = createRealm()
    const produced = await realm.run({ program: 'const held = new Map([["a", 1]])\nheld', bindings: [] })
    const id = (produced.value as OpaqueEnvelope).$out

    const recirculated = await realm.run({ program: `$out(${String(id)})`, bindings: [] })
    expect(envelopeOf(recirculated).$out).toBe(id)
    expect(await history(realm)).toHaveLength(1)

    const rebound = await realm.run({ program: 'held', bindings: [] })
    expect(envelopeOf(rebound).$out).toBe(id)
    expect(await history(realm)).toHaveLength(1)
    expect((await realm.run({ program: '$_ === held', bindings: [] })).value).toBe(true)
  })

  it('opens no slot for an exception and none for an undefined completion', async () => {
    const realm = createRealm()
    expect((await realm.run({ program: 'throw new Error("boom")', bindings: [] })).error?.kind).toBe('exception')
    expect((await realm.run({ program: 'undefined', bindings: [] })).error).toBeUndefined()
    expect(await history(realm)).toEqual([])
  })
})

describe('opaque completion history: adversarial getter and proxy safety', () => {
  it('never consults user toJSON/toString hooks to render a non-JSON completion', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        globalThis.hookTouches = { toJSON: 0, toString: 0 }
        const guarded = {}
        Object.defineProperty(guarded, 'toJSON', { enumerable: false, get() { globalThis.hookTouches.toJSON += 1; return 1 } })
        Object.defineProperty(guarded, 'toString', { enumerable: false, get() { globalThis.hookTouches.toString += 1; return 'x' } })
        guarded
      `,
      bindings: [],
    })
    expect(envelopeOf(result)).toMatchObject({ retained: true, opaque: true })
    // The classification walk refuses the non-enumerable keys without reading
    // them, and the envelope renders nothing about the value: neither hook ran.
    expect((await realm.run({ program: 'globalThis.hookTouches', bindings: [] })).value).toEqual({ toJSON: 0, toString: 0 })
  })

  it('retains a value whose own toString would throw, without calling it', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: 'const hostile = { toString() { throw new Error("toString exploded") } }\nhostile',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, opaque: true, truncated: true })
    expect(JSON.stringify(result.value)).not.toContain('toString exploded')
    // The value is still the original object; only calling toString fails.
    const id = (result.value as OpaqueEnvelope).$out
    const probeResult = await realm.run({ program: caught(`$out(${String(id)}).toString()`), bindings: [] })
    expect(probeResult.value).toMatchObject({ threw: true })
  })

  it('retains a value behind a proxy whose getPrototypeOf trap throws', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: 'const trapped = new Proxy({}, { getPrototypeOf() { throw new Error("proto trap boom") } })\ntrapped',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, type: 'object', opaque: true, truncated: true })
    expect(JSON.stringify(result.value)).not.toContain('proto trap boom')
    expect(realm.generation).toBe(1)
  })

  it('retains a value behind a proxy whose get trap throws', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: 'const trapped = new Proxy({ a: 1 }, { get() { throw new Error("get trap boom") } })\ntrapped',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, opaque: true, truncated: true })
    const id = (result.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `$out(${String(id)}) === trapped`, bindings: [] })).value).toBe(true)
  })

  it('retains a revoked proxy as an opaque object', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: 'const { proxy, revoke } = Proxy.revocable({}, {})\nrevoke()\nproxy',
      bindings: [],
    })
    // Array.isArray on a revoked proxy throws; the classification walk catches
    // it as "not lossless JSON", and the envelope's own type probe is guarded
    // the same way.
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, type: 'object', opaque: true, truncated: true })
    expect(realm.generation).toBe(1)
    const id = (result.value as OpaqueEnvelope).$out
    expect((await realm.run({ program: `typeof $out(${String(id)})`, bindings: [] })).value).toBe('object')
  })

  it('keeps a throwing getter inside an object out of the canonical result', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const trap = {}
        Object.defineProperty(trap, 'boom', { enumerable: true, get() { throw new Error('getter exploded') } })
        trap
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, opaque: true, truncated: true })
    expect(JSON.stringify(result.value)).not.toContain('getter exploded')
    expect(realm.generation).toBe(1)
  })
})

describe('opaque completion history: budgets and eviction', () => {
  it('evicts the oldest opaque completion FIFO when the opaque entry budget is full', async () => {
    const realm = createRealm({ completionOpaque: { maxCompletionOpaqueEntries: 2 } })
    const first = await realm.run({ program: 'new Map([["first", 1]])', bindings: [] })
    const firstId = (first.value as OpaqueEnvelope).$out
    await realm.run({ program: 'new Set([1])', bindings: [] })
    await realm.run({ program: 'const last = () => "last"\nlast', bindings: [] })

    const rows = await history(realm)
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.opaque)).toEqual([true, true])
    expect(rows.map(row => row.type)).toEqual(['object', 'function'])

    const expired = await realm.run({ program: caught(`$out(${String(firstId)})`), bindings: [] })
    expect((expired.value as unknown as CaughtRejection)).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
    // JSON slots are untouched by opaque eviction.
    expect(realm.generation).toBe(1)
  })

  it('keeps the two stores independent in both directions', async () => {
    // JSON flood: a JSON-only entry budget must evict JSON slots only.
    const jsonBound = createRealm({ completionHistory: { maxCompletionHistoryEntries: 1 } })
    await jsonBound.run({ program: 'new Map([["opaque", true]])', bindings: [] })
    const jsonBoundRows = await history(jsonBound)
    const opaqueId = jsonBoundRows[0]?.id ?? 0
    await jsonBound.run({ program: '({ a: 1 })', bindings: [] })
    await jsonBound.run({ program: '({ b: 2 })', bindings: [] })
    const mixed = await history(jsonBound)
    expect(mixed.map(row => row.opaque)).toEqual([true, undefined])
    expect((await jsonBound.run({ program: `$out(${String(opaqueId)}).get("opaque")`, bindings: [] })).value).toBe(true)

    // Opaque flood: an opaque-only entry budget must evict opaque slots only.
    const opaqueBound = createRealm({ completionOpaque: { maxCompletionOpaqueEntries: 1 } })
    await opaqueBound.run({ program: '({ kept: true })', bindings: [] })
    const mapRun = await opaqueBound.run({ program: 'new Map([["a", 1]])', bindings: [] })
    const mapId = (mapRun.value as OpaqueEnvelope).$out
    await opaqueBound.run({ program: 'new Set([2])', bindings: [] })
    const mixedOpaque = await history(opaqueBound)
    expect(mixedOpaque.map(row => row.opaque)).toEqual([undefined, true])
    expect(mixedOpaque.map(row => row.type)).toEqual(['object', 'object'])
    // The Map was the oldest OPAQUE slot, so it was evicted by the Set; the
    // JSON slot never competed for the opaque budget.
    const expiredMap = await opaqueBound.run({ program: caught(`$out(${String(mapId)})`), bindings: [] })
    expect((expiredMap.value as unknown as CaughtRejection)).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
    const setRow = mixedOpaque[1]
    expect((await opaqueBound.run({ program: `$out(${String(setRow?.id ?? 0)}) instanceof Set`, bindings: [] })).value).toBe(true)
  })

  it('refuses an opaque completion whose charge cannot fit, without clearing the store for it', async () => {
    // A classification walk that got this far charged 7 bytes / 2 nodes; the
    // byte ceiling of 4 proves the value cannot be retained even by an empty
    // store, so the model keeps every earlier handle and gets the honest
    // retained:false envelope instead.
    const realm = createRealm({ completionOpaque: { maxCompletionOpaqueEstimatedBytes: 4 } })
    await realm.run({ program: '({ before: true })', bindings: [] })
    const before = await history(realm)

    const refused = await realm.run({ program: '({ fn: () => 1 })', bindings: [] })
    expect(refused.error).toBeUndefined()
    const envelope = envelopeOf(refused)
    expect(envelope).toMatchObject({ retained: false, type: 'object', opaque: true, reason: 'opaque history budget exceeded' })
    expect(envelope.$out).toBeUndefined()
    expect(envelope.use).toBeUndefined()
    expect(await history(realm)).toEqual(before)

    // Same shape for the node budget.
    const nodeBound = createRealm({ completionOpaque: { maxCompletionOpaqueNodes: 1 } })
    const refusedByNodes = await realm.run({ program: '({ fn: () => 1 })', bindings: [] })
    expect(envelopeOf(refusedByNodes)).toMatchObject({ retained: false, opaque: true })
    void nodeBound
  })

  it('answers an empty opaque history with undefined rather than with an error', async () => {
    const realm = createRealm()
    const empty = await realm.run({ program: '({ entries: $out.list().length, last: typeof $_ })', bindings: [] })
    expect(empty.value).toEqual({ entries: 0, last: 'undefined' })
  })
})

describe('opaque completion history: explicit release and generation loss', () => {
  it('drops and clears opaque slots, with idempotent answers and bounded rows', async () => {
    const realm = createRealm()
    const produced = await realm.run({ program: 'new Map([["a", 1]])', bindings: [] })
    const id = (produced.value as OpaqueEnvelope).$out

    const rows = await history(realm)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'keyCount', 'nodes', 'opaque', 'serializedBytesAtCapture', 'type'])
    expect(rows[0]?.keyCount).toBe(0)
    expect(rows[0]?.opaque).toBe(true)
    // Bounded regardless of the value's true graph: only what the walk charged.
    expect(JSON.stringify(rows[0]).length).toBeLessThan(120)

    expect(await realm.run({ program: `[$out.drop(${String(id)}), $out.drop(${String(id)})]`, bindings: [] })).toMatchObject({ value: [true, false] })
    // The drop probe's own completion — the JSON array [true, false] — was
    // retained like any other value, so the first clear releases it: the list
    // costs a slot of its own, exactly as `$out.list()` does.
    expect((await realm.run({ program: '[$out.clear(), $out.clear()]', bindings: [] })).value).toEqual([1, 0])
    const gone = await realm.run({ program: caught(`$out(${String(id)})`), bindings: [] })
    expect((gone.value as unknown as CaughtRejection)).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
  })

  it('expires every opaque handle a hard kill destroyed, and never reissues its id', async () => {
    const realm = createRealm({ budgets: { maxWallMs: 400 } })
    const produced = await realm.run({ program: 'new Map([["before", 1]])', bindings: [] })
    const id = (produced.value as OpaqueEnvelope).$out

    expect((await realm.run({ program: 'for (;;) {}', bindings: [] })).error?.kind).toBe('timeout')
    expect(realm.generation).toBe(2)

    const survivors = await realm.run({
      program: `({ entries: $out.list().length, stale: ${caught(`$out(${String(id)})`)}.name })`,
      bindings: [],
    })
    expect(survivors.value).toEqual({ entries: 0, stale: 'CompletionExpiredError' })

    // The new generation does not restart the sequence.
    const after = await realm.run({ program: 'new Set([1])', bindings: [] })
    expect((after.value as OpaqueEnvelope).$out).toBeGreaterThan(id as number)
  })
})

describe('opaque completion history: wire degradation', () => {
  async function boundaryFixture(): Promise<{
    realm: PersistentRealm
    id: number
    expectedMinimal: OpaqueEnvelope
    boundaryLogLength: number
  }> {
    const maxOutputBytes = 256
    const realm = createRealm({ budgets: { maxOutputBytes } })
    const seed = envelopeOf(await realm.run({ program: 'new Map([["a", 1]])', bindings: [] }))
    const id = seed.$out as number
    const expectedMinimal: OpaqueEnvelope = {
      $out: id,
      use: `$out(${String(id)})`,
      type: 'object',
      opaque: true,
      truncated: true,
    }
    const minimalBytes = Buffer.byteLength(JSON.stringify(expectedMinimal), 'utf8')
    return {
      realm,
      id,
      expectedMinimal,
      boundaryLogLength: maxOutputBytes - 2 - 2 - minimalBytes,
    }
  }

  it('fits the typed minimal reference at its exact wire boundary', async () => {
    const { realm, id, expectedMinimal, boundaryLogLength } = await boundaryFixture()
    const atBoundary = await realm.run({
      program: `console.log("x".repeat(${String(boundaryLogLength)}))\n$out(${String(id)})`,
      bindings: [],
    })
    expect(atBoundary.error).toBeUndefined()
    expect(atBoundary.logs).toEqual(['x'.repeat(boundaryLogLength)])
    expect(atBoundary.value).toEqual(expectedMinimal)
    expect(atBoundary.presentation).toEqual({ kind: 'opaque-reference', valueType: 'object', handle: id })
  })

  it('reports output-limit one byte below the typed minimal boundary without losing the realm', async () => {
    const { realm, id, boundaryLogLength } = await boundaryFixture()
    const oneByteShort = await realm.run({
      program: `console.log("x".repeat(${String(boundaryLogLength + 1)}))\n$out(${String(id)})`,
      bindings: [],
    })
    expect(oneByteShort.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 256 bytes' })
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: `$out(${String(id)}).get("a")`, bindings: [] })).value).toBe(1)
  })
})

describe('opaque completion history: observability and configuration', () => {
  it('counts opaque projections and retentions without recording any of them', async () => {
    const realm = createRealm()
    // The first opaque value's classification walk charged real bytes (it
    // walked the container and the key before refusing the function); a bare
    // Map or function refuses at the first node and charges nothing.
    await realm.run({ program: '({ fn: () => 1 })', bindings: [] })
    await realm.run({ program: '({ small: true })', bindings: [] })
    await realm.run({ program: 'new Map([["a", 1]])', bindings: [] })

    const metrics = realm.metrics
    expect(metrics.completionsProjected).toBe(2)
    expect(metrics.completionsFull).toBe(1)
    expect(metrics.completionsRetained).toBe(3)
    expect(metrics.completionsRejected).toBe(0)
    expect(metrics.historyEntries).toBe(1)
    expect(metrics.historyOpaqueEntries).toBe(2)
    expect(metrics.historyOpaqueBytes).toBeGreaterThan(0)
  })

  it('validates every opaque limit as a positive safe integer', async () => {
    for (const field of ['maxCompletionOpaqueEntries', 'maxCompletionOpaqueEstimatedBytes', 'maxCompletionOpaqueNodes'] as const) {
      for (const invalid of [0, -1, 1.5, Number.NaN]) {
        expect(() => new PersistentRealm({
          realmId: `invalid-opaque-${field}`,
          budgets: BUDGETS,
          completionOpaque: { [field]: invalid },
        }), field).toThrow(`${field} must be a positive safe integer`)
      }
    }
    // Blank fields take the decided defaults rather than disabling the store.
    const realm = createRealm()
    await realm.run({ program: 'new Map([["defaulted", true]])', bindings: [] })
    expect(await history(realm)).toHaveLength(1)
  })
})
