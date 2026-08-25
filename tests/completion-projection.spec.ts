/**
 * Completion projector behavior, budgets, and trusted host-output coverage.
 *
 * This suite owns the PROJECTOR: what the internal canonical completion
 * envelope looks like, and where each rung of the
 * `full -> rich -> minimal -> output-limit` chain sits,
 * and what the bounded walk does and does not read on the way there.
 *
 * Ownership boundary with its neighbours. `completion-history.spec.ts` owns
 * which values enter the history and what happens to them once they are in it;
 * `completion-contracts.spec.ts` owns the wire cap and the ledger arithmetic the
 * chain has to keep satisfying. What is pinned HERE is the envelope itself.
 *
 * Two mechanics shape most of the tests below:
 *
 * - Handles come from a process-wide counter, so no test asserts an absolute id.
 * - The capture walk stops once a value is beyond BOTH uses it could be put to,
 *   which is why several tests configure a small node budget AND a small
 *   full-value threshold: either alone leaves the walk running.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { MINIMAL_ENVELOPE_BYTES, MIN_OUTPUT_BYTES } from '../src/realm/protocol.js'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets, RealmCompletionHistoryLimits, RealmCompletionProjectionLimits } from '../src/realm/realm.js'

const BUDGETS: RealmBudgets = {
  computeMs: 5_000,
  maxWallMs: 10_000,
  maxOutputBytes: 65_536,
  maxOldGenerationSizeMb: 128,
}

/** The projector's limits, restated so a change has to be acknowledged here. */
const PROJECTION_DEPTH = 4
const PROJECTION_ARRAY_SAMPLE = 8
const PROJECTION_KEY_SAMPLE = 16
const PROJECTION_STRING_CHARS = 256

// Pin the largest legal minimal retained shape, including the longest safe
// opaque completion type and the largest handle accepted by the host parser.
it('sizes the minimal reference constant at the exact worst-case boundary', () => {
  const handle = Number.MAX_SAFE_INTEGER
  const envelope = {
    $out: handle,
    use: `$out(${handle})`,
    type: 'function',
    opaque: true,
    truncated: true,
  }
  expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBe(MINIMAL_ENVELOPE_BYTES)
  expect(MINIMAL_ENVELOPE_BYTES).toBe(105)
  expect(MINIMAL_ENVELOPE_BYTES + 2).toBeLessThanOrEqual(MIN_OUTPUT_BYTES)
})

const realms: PersistentRealm[] = []

afterEach(async () => {
  await Promise.all(realms.splice(0).map(realm => realm.dispose()))
})

function createRealm(options: {
  budgets?: Partial<RealmBudgets>
  completionHistory?: Partial<RealmCompletionHistoryLimits>
  completionProjection?: Partial<RealmCompletionProjectionLimits>
} = {}): PersistentRealm {
  const realm = new PersistentRealm({
    realmId: `realm-${realms.length}`,
    budgets: { ...BUDGETS, ...options.budgets },
    ...options.completionHistory ? { completionHistory: options.completionHistory } : {},
    ...options.completionProjection ? { completionProjection: options.completionProjection } : {},
  })
  realms.push(realm)
  return realm
}

/* eslint-disable @typescript-eslint/no-explicit-any -- test bindings receive already-validated JSON */
function tools(functions: Record<string, (args: any) => Promise<CodeJsonValue>>): CodeBindingNamespace {
  return { global: 'tools', functions: functions as Record<string, CodeBindingFunction> }
}

/** One sampled object key inside a projection. */
interface KeyEntry {
  key: string
  keyLength?: number
  value?: unknown
}

/** One projection node, as the worker renders a container or an over-long string. */
interface ProjectionNode {
  type: string
  length?: number
  prefix?: string
  keyCount?: number
  keys?: KeyEntry[]
  items?: unknown[]
}

/** One projected completion, as its envelope reaches the trusted host. */
interface Envelope {
  $out?: number
  use?: string
  retained?: boolean
  type: string
  serializedBytesAtCapture?: number
  projection?: ProjectionNode
  reason?: string
  truncated: true
}

/** Read one result as a projection envelope, failing loudly when it is not one. */
function envelopeOf(result: CodeRunResult): Envelope {
  expect(result.error).toBeUndefined()
  const value = result.value as Envelope
  expect(value?.truncated).toBe(true)
  return value
}

/** Exact wire bytes of one completion, in the ledger's own unit. */
function valueBytes(result: CodeRunResult): number {
  return Buffer.byteLength(JSON.stringify(result.value), 'utf8')
}

/** A program that builds an object of `count` short keys with short values. */
function wideObject(count: number): string {
  return `(() => { const wide = {}; for (let i = 0; i < ${count}; i++) wide['k' + i] = i; return wide })()`
}

describe('completion projection: capture-ceiling previews', () => {
  it('projects a value the node budget refused, keeping the key sample the walk took', async () => {
    // Refusing to RETAIN a value never means refusing to describe it, and the
    // key sample survives the budget refusal. Re-enumerating keys to rebuild the
    // sample is ruled out by the checked-in key-iteration measurements under
    // `bench/results/`, so a projection missing its keys has no cheap recovery.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryNodes: 50 },
      completionProjection: { maxCompletionFullBytes: 256 },
    })

    const result = await realm.run({ program: wideObject(80), bindings: [] })

    const envelope = envelopeOf(result)
    expect(envelope.retained).toBe(false)
    expect(envelope.type).toBe('object')
    // Not retained, so no handle: a `use` expression that was going to fail the
    // moment it was copied is worse than none at all.
    expect(envelope.$out).toBeUndefined()
    expect(envelope.use).toBeUndefined()
    // Not measured either — the walk stopped before it could be.
    expect(envelope.serializedBytesAtCapture).toBeUndefined()
    expect(envelope.reason).toBe('too large to capture')
    expect(result.presentation).toEqual({
      kind: 'unretained-preview',
      valueType: 'object',
      reason: 'too large to capture',
    })

    const keys = envelope.projection?.keys ?? []
    expect(keys).toHaveLength(PROJECTION_KEY_SAMPLE)
    expect(keys.map(entry => entry.key)).toEqual(Array.from({ length: 16 }, (_, index) => `k${index}`))
    expect(keys.map(entry => entry.value)).toEqual(Array.from({ length: 16 }, (_, index) => index))
  })

  it('names the siblings an aborted walk never reached, without reading them', async () => {
    // The depth-first walk may exhaust the ceiling inside the first child,
    // leaving later keys unvisited. Their NAMES are available from the single
    // enumeration; their values are not, and revisiting them would fire getters
    // the capture chose not to touch.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryNodes: 1 },
      completionProjection: { maxCompletionFullBytes: 256 },
    })

    const result = await realm.run({
      program: `({ big: "x".repeat(100000), untouched: { deep: true }, alsoUntouched: [1, 2, 3] })`,
      bindings: [],
    })

    const keys = envelopeOf(result).projection?.keys ?? []
    expect(keys.map(entry => entry.key)).toEqual(['big', 'untouched', 'alsoUntouched'])
    // The one child the walk did read is described; the two it did not are named
    // and nothing more. `value` is absent rather than null — a projected `null`
    // is a value the walk actually saw.
    expect((keys[0]?.value as ProjectionNode).type).toBe('string')
    expect(Object.hasOwn(keys[1] ?? {}, 'value')).toBe(false)
    expect(Object.hasOwn(keys[2] ?? {}, 'value')).toBe(false)
  })

  it('stops between charging a key name and reading its value', async () => {
    // The gap the walk has to be able to stop in. Charging the NAME can be what
    // crosses the ceiling, and the old loop read the property anyway before
    // noticing — so the one key whose name broke the budget was also the one key
    // whose getter ran. Sized so `later`'s name is the byte that crosses:
    // root braces 3, `pad` 6, its 100-character value 102, then `later` 8 = 119
    // over a ceiling of 115.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryEntryBytes: 115 },
      completionProjection: { maxCompletionFullBytes: 115 },
    })

    const result = await realm.run({
      program: `
        globalThis.laterTouched = false
        ;({ pad: "p".repeat(100), get later() { globalThis.laterTouched = true; return 1 } })
      `,
      bindings: [],
    })

    const keys = envelopeOf(result).projection?.keys ?? []
    expect(keys).toHaveLength(2)
    expect(keys[0]?.key).toBe('pad')
    expect(keys[1]).toEqual({ key: 'later' })
    expect(Object.hasOwn(keys[1] ?? {}, 'value')).toBe(false)

    const touched = await realm.run({ program: 'globalThis.laterTouched', bindings: [] })
    expect(touched.value).toBe(false)
  })

  it('answers successfully even when the key past the ceiling would have thrown', async () => {
    // The same gap, with the consequence that makes it worth a test of its own:
    // a getter that throws is `invalid-output` when the walk reaches it, so a
    // walk that stops one byte too late turns a run the projector was about to
    // answer into a failure. Nothing about the value changed — only whether the
    // walk touched it.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryEntryBytes: 115 },
      completionProjection: { maxCompletionFullBytes: 115 },
    })

    const result = await realm.run({
      program: `({ pad: "p".repeat(100), get later() { throw new Error("boom") } })`,
      bindings: [],
    })

    expect(result.error).toBeUndefined()
    const keys = envelopeOf(result).projection?.keys ?? []
    expect(keys.map(entry => entry.key)).toEqual(['pad', 'later'])
    expect(keys[1]).toEqual({ key: 'later' })

    // The same getter INSIDE the ceiling no longer fails the run: the walk
    // reached it, read it, and classified the value as a NON-JSON live object
    // retained by the opaque budgets.
    const reached = createRealm()
    const retained = await reached.run({
      program: `({ get later() { throw new Error("boom") } })`,
      bindings: [],
    })
    expect(retained.error).toBeUndefined()
    expect(retained.value).toMatchObject({ retained: true, opaque: true, truncated: true })
    expect(reached.generation).toBe(1)
  })

  it('never reads past the ceiling, so a getter beyond it is not invoked', async () => {
    // Once the ceiling is crossed, getters beyond it remain untouched.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryNodes: 1 },
      completionProjection: { maxCompletionFullBytes: 256 },
    })

    const result = await realm.run({
      program: `
        globalThis.probeTouched = false
        ;({ big: "x".repeat(100000), get later() { globalThis.probeTouched = true; return 1 } })
      `,
      bindings: [],
    })
    expect(envelopeOf(result).truncated).toBe(true)

    const touched = await realm.run({ program: 'globalThis.probeTouched', bindings: [] })
    expect(touched.value).toBe(false)
  })
})

describe('completion projection: the degradation chain', () => {
  it('sends a value verbatim up to the full-value threshold and references the byte after it', async () => {
    // The threshold is its own knob, deliberately not the wire budget. Both
    // realms have 64 KiB of wire to spare, so value size alone decides the shape.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 512 } })

    const fits = await realm.run({ program: '"y".repeat(510)', bindings: [] })
    expect(fits.error).toBeUndefined()
    expect(fits.value).toBe('y'.repeat(510))
    expect(valueBytes(fits)).toBe(512)
    expect(fits.presentation).toBeUndefined()

    const over = await realm.run({ program: '"y".repeat(511)', bindings: [] })
    const envelope = envelopeOf(over)
    expect(envelope.retained).toBe(true)
    expect(envelope.serializedBytesAtCapture).toBe(513)
    expect(envelope.projection).toMatchObject({ type: 'string', length: 511 })
    expect(over.presentation).toEqual({
      kind: 'retained-preview',
      valueType: 'string',
      serializedBytes: 513,
      handle: envelope.$out,
    })
  })

  it('degrades a rich envelope to a minimal reference when the projection budget cannot hold it', async () => {
    // The projection budget alone decides this rung — the wire has 64 KiB free.
    // The chain drops a WHOLE rung rather than sending a half-rendered projection.
    const rich = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const richResult = await rich.run({ program: wideObject(40), bindings: [] })
    const richEnvelope = envelopeOf(richResult)
    expect(richEnvelope.projection?.keys).toHaveLength(PROJECTION_KEY_SAMPLE)

    const minimal = createRealm({
      completionProjection: { maxCompletionFullBytes: 64, maxCompletionProjectionBytes: 64 },
    })
    const minimalResult = await minimal.run({ program: wideObject(40), bindings: [] })
    const minimalEnvelope = envelopeOf(minimalResult)
    expect(minimalEnvelope.projection).toBeUndefined()
    expect(minimalEnvelope.retained).toBeUndefined()
    expect(minimalEnvelope.use).toBe(`$out(${minimalEnvelope.$out ?? 0})`)
    expect(valueBytes(minimalResult)).toBeLessThanOrEqual(MINIMAL_ENVELOPE_BYTES)
    expect(minimalResult.presentation).toEqual({
      kind: 'retained-preview',
      valueType: 'object',
      handle: minimalEnvelope.$out,
    })
  })

  it('keeps retained and unretained minimal forms inside the reference-envelope constant', async () => {
    // Retained references now keep their safe type even after the projection is
    // dropped. The unretained shape remains smaller because it has no handle.
    const handled = createRealm({
      completionProjection: { maxCompletionFullBytes: 8, maxCompletionProjectionBytes: 8 },
    })
    const withHandle = await handled.run({ program: '({ a: 1, b: 2 })', bindings: [] })
    const handledEnvelope = envelopeOf(withHandle)
    expect(handledEnvelope.$out).toBeGreaterThan(0)
    expect(handledEnvelope.type).toBe('object')
    expect(valueBytes(withHandle)).toBeLessThanOrEqual(MINIMAL_ENVELOPE_BYTES)

    const unretained = createRealm({
      completionHistory: { maxCompletionHistoryNodes: 1 },
      completionProjection: { maxCompletionFullBytes: 8, maxCompletionProjectionBytes: 8 },
    })
    const withoutHandle = await unretained.run({ program: '({ a: 1, b: 2, c: 3 })', bindings: [] })
    const unretainedEnvelope = envelopeOf(withoutHandle)
    expect(unretainedEnvelope.$out).toBeUndefined()
    expect(unretainedEnvelope.type).toBe('object')
    expect(valueBytes(withoutHandle)).toBeLessThanOrEqual(MINIMAL_ENVELOPE_BYTES)
    expect(withoutHandle.presentation).toEqual({
      kind: 'unretained-preview',
      valueType: 'object',
    })
  })

  it('measures a value it refused to retain, and says which of the two happened', async () => {
    // Two different refusals with two different honesty obligations. A walk that
    // FINISHED knows the exact size even when the history would not take the
    // value, and reporting it costs nothing; a walk that stopped knows only that
    // it stopped, and a lower bound printed as an exact number would be a
    // measurement nobody took.
    //
    // Reaching the measured refusal takes the TOTAL history budget rather than
    // the per-slot one, and that is a property of where the early exit sits: a
    // value over the per-slot ceiling is also over the ceiling the walk stops
    // at, so it can only ever be the unmeasured kind.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryEstimatedBytes: 100 },
      completionProjection: { maxCompletionFullBytes: 128 },
    })

    const measured = await realm.run({ program: '"y".repeat(400)', bindings: [] })
    const envelope = envelopeOf(measured)
    expect(envelope.retained).toBe(false)
    expect(envelope.serializedBytesAtCapture).toBe(402)
    expect(envelope.reason).toBe('too large to retain')
    expect(envelope.projection).toMatchObject({ type: 'string', length: 400 })

    const capped = createRealm({
      completionHistory: { maxCompletionHistoryEntryBytes: 256 },
      completionProjection: { maxCompletionFullBytes: 128 },
    })
    const unmeasured = await capped.run({
      program: `({ big: "x".repeat(100000) })`,
      bindings: [],
    })
    const unmeasuredEnvelope = envelopeOf(unmeasured)
    expect(unmeasuredEnvelope.serializedBytesAtCapture).toBeUndefined()
    expect(unmeasuredEnvelope.reason).toBe('too large to capture')
  })
})

describe('completion projection: the projector\'s own limits', () => {
  it('stops sampling children at the depth limit but still reports their size', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({
      program: `
        let nested: unknown = { leaf: [1, 2, 3] }
        for (let level = 0; level < 8; level++) nested = { level, inner: nested }
        nested
      `,
      bindings: [],
    })

    let node = envelopeOf(result).projection as ProjectionNode | undefined
    // The root counts as depth 0, so four containers carry a key sample and the
    // fifth reports its shape alone.
    for (let depth = 0; depth < PROJECTION_DEPTH; depth++) {
      expect(node?.keys, `depth ${depth}`).toBeDefined()
      node = node?.keys?.find(entry => entry.key === 'inner')?.value as ProjectionNode | undefined
    }
    expect(node?.type).toBe('object')
    expect(node?.keyCount).toBe(2)
    expect(node?.keys).toBeUndefined()
  })

  it('samples the head of an array and reports the length of the whole', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({
      program: 'Array.from({ length: 200 }, (_, index) => index)',
      bindings: [],
    })

    const projection = envelopeOf(result).projection
    expect(projection?.type).toBe('array')
    expect(projection?.length).toBe(200)
    expect(projection?.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(projection?.items).toHaveLength(PROJECTION_ARRAY_SAMPLE)
  })

  it('samples the head of an object and reports the total key count', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({ program: wideObject(40), bindings: [] })

    const projection = envelopeOf(result).projection
    expect(projection?.type).toBe('object')
    expect(projection?.keyCount).toBe(40)
    expect(projection?.keys).toHaveLength(PROJECTION_KEY_SAMPLE)
  })

  it('cuts a long string to its head and says how long the whole was', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({ program: '({ body: "z".repeat(9000) })', bindings: [] })

    const body = envelopeOf(result).projection?.keys?.[0]?.value as ProjectionNode
    expect(body.type).toBe('string')
    expect(body.length).toBe(9000)
    expect(body.prefix).toBe('z'.repeat(PROJECTION_STRING_CHARS))
  })

  it('leaves a string at the character limit whole, as its own projection', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({
      program: `({ exact: "z".repeat(${PROJECTION_STRING_CHARS}), over: "z".repeat(${PROJECTION_STRING_CHARS + 1}) })`,
      bindings: [],
    })

    const keys = envelopeOf(result).projection?.keys ?? []
    expect(keys[0]?.value).toBe('z'.repeat(PROJECTION_STRING_CHARS))
    expect((keys[1]?.value as ProjectionNode).type).toBe('string')
  })

  it('never cuts a string between the halves of a surrogate pair', async () => {
    // A prefix ending in a lone high surrogate no longer names its original
    // character. The pair straddles the limit, so the correct answer is one
    // character shorter.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({
      program: `({ emoji: "a".repeat(${PROJECTION_STRING_CHARS - 1}) + "\u{1f600}" + "b".repeat(400) })`,
      bindings: [],
    })

    const emoji = envelopeOf(result).projection?.keys?.[0]?.value as ProjectionNode
    const prefix = emoji.prefix ?? ''
    expect(prefix).toHaveLength(PROJECTION_STRING_CHARS - 1)
    expect(prefix).toBe('a'.repeat(PROJECTION_STRING_CHARS - 1))
    // Round-tripping proves it: a lone surrogate survives `JSON` but not a
    // comparison against the well-formed text it was cut out of.
    expect([...prefix]).toHaveLength(PROJECTION_STRING_CHARS - 1)
  })

  it('truncates an over-long key and records how long it really was', async () => {
    // The boundary admits a 20,000-character key, so one key can consume the
    // projection budget unless cut like any other string. Its original length
    // distinguishes a 256-character prefix from a key the model could use.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({
      program: `(() => { const wide: Record<string, number> = {}; wide['k'.repeat(20000)] = 1; wide.short = 2; return wide })()`,
      bindings: [],
    })

    const keys = envelopeOf(result).projection?.keys ?? []
    expect(keys[0]?.key).toBe('k'.repeat(PROJECTION_STRING_CHARS))
    expect(keys[0]?.keyLength).toBe(20000)
    expect(keys[0]?.value).toBe(1)
    // A key inside the limit is reported as itself, with no length annotation.
    expect(keys[1]).toEqual({ key: 'short', value: 2 })
  })

  it('distinguishes a projected null from a key the walk never read', async () => {
    // Two absences that must not look alike. A `null` the walk SAW is rendered
    // as `value: null`; a key it never reached has no `value` key at all. Only
    // `Object.hasOwn` can tell them apart — `toEqual` treats a missing property
    // and an undefined one as the same thing, so it cannot pin this.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const seen = await realm.run({
      program: '({ nothing: null, empty: {}, none: [], blank: "", zero: 0, no: false })',
      bindings: [],
    })

    const keys = envelopeOf(seen).projection?.keys ?? []
    expect(keys.map(entry => entry.key)).toEqual(['nothing', 'empty', 'none', 'blank', 'zero', 'no'])
    for (const entry of keys) expect(Object.hasOwn(entry, 'value'), entry.key).toBe(true)
    expect(keys[0]?.value).toBeNull()
    expect(keys[1]?.value).toMatchObject({ type: 'object', keyCount: 0 })
    expect(keys[2]?.value).toMatchObject({ type: 'array', length: 0 })
    expect(keys[3]?.value).toBe('')
    expect(keys[4]?.value).toBe(0)
    expect(keys[5]?.value).toBe(false)

    // An empty container at the root is projected the same way, rather than
    // being mistaken for a value that could not be described.
    const bare = createRealm({ completionProjection: { maxCompletionFullBytes: 1 } })
    expect(envelopeOf(await bare.run({ program: '({})', bindings: [] })).projection)
      .toMatchObject({ type: 'object', keyCount: 0 })
    expect(envelopeOf(await bare.run({ program: '[]', bindings: [] })).projection)
      .toMatchObject({ type: 'array', length: 0 })
    expect(envelopeOf(await bare.run({ program: '""', bindings: [] })).projection).toBe('')
    expect(envelopeOf(await bare.run({ program: 'null', bindings: [] })).projection).toBeNull()
  })

  it('holds the whole envelope inside the projection budget whatever the value is', async () => {
    // The budget is what the model actually pays, so it is asserted over shapes
    // chosen to attack each limit separately: a very wide object, very long
    // keys, a deep chain and a long string.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const shapes = [
      wideObject(5000),
      `(() => { const wide: Record<string, number> = {}; for (let i = 0; i < 40; i++) wide['k'.repeat(1000) + i] = i; return wide })()`,
      `(() => { let deep: unknown = 1; for (let i = 0; i < 500; i++) deep = { deep }; return deep })()`,
      '"z".repeat(50000)',
      'Array.from({ length: 5000 }, (_, index) => ({ index, label: "row-" + index }))',
    ]

    for (const program of shapes) {
      const result = await realm.run({ program, bindings: [] })
      expect(envelopeOf(result).truncated, program.slice(0, 40)).toBe(true)
      expect(valueBytes(result), program.slice(0, 40)).toBeLessThanOrEqual(4_096)
    }
  })

  it('produces the same bytes for the same value', async () => {
    // The handle legitimately differs between runs, so it is removed before
    // comparing the otherwise byte-identical projections.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const program = 'Array.from({ length: 200 }, (_, index) => ({ index, label: "row-" + index }))'

    const first = envelopeOf(await realm.run({ program, bindings: [] }))
    const second = envelopeOf(await realm.run({ program, bindings: [] }))
    expect(first.$out).not.toBe(second.$out)

    const stripped = (envelope: Envelope): string => {
      const { $out: _handle, use: _use, ...rest } = envelope
      return JSON.stringify(rest)
    }
    expect(stripped(first)).toBe(stripped(second))
  })
})

describe('completion projection: what the envelope is and is not', () => {
  it('hands back the whole value through the handle the envelope carries', async () => {
    // Acceptance #1 and #2 in one cell pair: the cell succeeds with a bounded
    // projection, and the value it references is still complete afterwards.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 512 } })

    const produced = await realm.run({
      program: 'Array.from({ length: 400 }, (_, index) => ({ index, label: "row-" + index }))',
      bindings: [],
    })
    const envelope = envelopeOf(produced)
    expect(envelope.retained).toBe(true)

    const recovered = await realm.run({
      program: `(() => { const rows = $out(${envelope.$out ?? 0}); return { length: rows.length, last: rows[399] } })()`,
      bindings: [],
    })
    expect(recovered.value).toEqual({ length: 400, last: { index: 399, label: 'row-399' } })
  })

  it('gives the same object the same handle however many envelopes describe it', async () => {
    // The O2 identity rule survives projection: a value flowing back through
    // `$out(id)` keeps its slot, its handle and its FIFO position, so a model
    // reading a large result and returning it does not spend a second slot on
    // the object it already had a handle for. Only OBJECTS are scanned — two
    // equal strings are not the same result — so the string below is the control.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })

    const first = envelopeOf(await realm.run({ program: 'globalThis.rows = Array.from({ length: 200 }, (_, index) => index)', bindings: [] }))
    const again = envelopeOf(await realm.run({ program: 'globalThis.rows', bindings: [] }))
    expect(again.$out).toBe(first.$out)
    expect(realm.metrics.historyEntries).toBe(1)

    const text = envelopeOf(await realm.run({ program: 'globalThis.text = "z".repeat(500)', bindings: [] }))
    const textAgain = envelopeOf(await realm.run({ program: 'globalThis.text', bindings: [] }))
    expect(textAgain.$out).not.toBe(text.$out)
    expect(realm.metrics.historyEntries).toBe(3)
  })

  it('moves the last-result handle to the value, not to the envelope', async () => {
    // `$_` names what the cell produced. The envelope is the runtime's account of
    // it, and a `$_` that answered with the account would be describing the
    // history's own bookkeeping back to the model.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    await realm.run({ program: wideObject(40), bindings: [] })

    const last = await realm.run({ program: 'Object.keys($_).length', bindings: [] })
    expect(last.value).toBe(40)
  })

  it('treats a value the program shaped like an envelope as an ordinary completion', async () => {
    // Envelope SHAPE proves nothing because model code can write one. The
    // discriminator is a terminal-message marker quoting a per-run nonce the
    // program cannot read. A forged envelope remains an ordinary completion,
    // and its invented handle expires like any handle that names nothing.
    const realm = createRealm()
    const forged = await realm.run({
      program: '({ $out: 987654, use: "$out(987654)", retained: true, type: "object", truncated: true })',
      bindings: [],
    })
    expect(forged.error).toBeUndefined()
    expect(forged.value).toEqual({ $out: 987654, use: '$out(987654)', retained: true, type: 'object', truncated: true })
    expect(forged.presentation).toBeUndefined()
    expect(realm.metrics.completionsProjected).toBe(0)
    expect(realm.metrics.completionsFull).toBe(1)

    const followed = await realm.run({
      program: `(() => { try { $out(987654); return 'reached' } catch (error) { return String((error as Error).name) } })()`,
      bindings: [],
    })
    expect(followed.value).toBe('CompletionExpiredError')
    expect(realm.generation).toBe(1)
  })

  it('projects only through the runtime, so a forged envelope cannot borrow the marker', async () => {
    // The same boundary from the other side: a real projection and a forged one
    // in the same realm are told apart by the counter, not by their contents.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    await realm.run({ program: wideObject(40), bindings: [] })
    expect(realm.metrics.completionsProjected).toBe(1)

    await realm.run({ program: '({ $out: 1, use: "$out(1)", truncated: true })', bindings: [] })
    expect(realm.metrics.completionsProjected).toBe(1)
    expect(realm.metrics.completionsFull).toBe(1)
  })

  it('keeps every envelope lossless JSON on its own terms', async () => {
    // The projector's output is a completion like any other, so it has to
    // survive the same round trip the boundary demands of a program's value.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const result = await realm.run({
      program: `({ rows: Array.from({ length: 30 }, (_, i) => i), text: "z".repeat(500), nothing: null, flag: false })`,
      bindings: [],
    })

    const envelope = envelopeOf(result)
    const serialized = JSON.stringify(envelope)
    expect(JSON.stringify(JSON.parse(serialized) as unknown)).toBe(serialized)
    expect(serialized).not.toContain('undefined')
  })
})

describe('completion projection: the boundaries the early exit must not move', () => {
  it('still returns a node-over-budget value whole when its JSON fits', async () => {
    // Early exit must not turn a successful cell into `invalid-output`. A shared
    // subgraph expands into far more boundary nodes than live objects, so the
    // node budget refuses retention; its tiny serialization must still cross.
    const realm = createRealm({ completionHistory: { maxCompletionHistoryNodes: 200 } })
    const result = await realm.run({
      program: `
        let shared: unknown = { v: 1 }
        for (let level = 0; level < 8; level++) shared = { a: shared, b: shared }
        shared
      `,
      bindings: [],
    })

    expect(result.error).toBeUndefined()
    expect((result.value as { a: unknown }).a).toBeDefined()
    // Whole, not an envelope: nothing about it is truncated.
    expect((result.value as Record<string, unknown>).truncated).toBeUndefined()
    expect(realm.metrics.completionsFull).toBe(1)
  })

  it('does not let a small retention budget turn ordinary results into references', async () => {
    // The retention ceiling is where the walk stops, but stopping there would be
    // wrong for a value that is still small enough to show: a deployment that
    // retains little would silently start referencing mid-sized results, which is
    // a presentation contract set by an unrelated knob.
    const realm = createRealm({ completionHistory: { maxCompletionHistoryEntryBytes: 64 } })
    const result = await realm.run({ program: '"y".repeat(4000)', bindings: [] })

    expect(result.error).toBeUndefined()
    expect(result.value).toBe('y'.repeat(4000))
  })

  it('retains a non-lossless value the bounded walk actually reached, as opaque', async () => {
    // Inside the capture ceiling these values are refused the WIRE without
    // failing the cell. Each is retained under the opaque budgets, answered with
    // the fixed envelope, and remains reachable by identity through its handle.
    const realm = createRealm()
    const retained = [
      '({ big: 10n })',
      '({ fn: () => 1 })',
      '({ when: new Date() })',
      '({ size: NaN })',
      '[1, , 3]',
      // The array checks specifically: density and extra properties are verified
      // AFTER the element walk now, so that an aborted capture does not pay a
      // materialized key per element. Both must still be caught for an array the
      // walk finished.
      '(() => { const rows = [1, 2]; (rows as unknown as Record<string, unknown>).extra = 3; return rows })()',
    ]
    for (const program of retained) {
      const result = await realm.run({ program, bindings: [] })
      expect(result.error, program).toBeUndefined()
      expect(result.value, program).toMatchObject({ retained: true, opaque: true, truncated: true })
    }
  })

  it('stops checking array shape past the ceiling, like every other kind of validity', async () => {
    // Deferring the density check means an extra-propertied array is refused when
    // the walk finishes and projected when it does not, consistently with a
    // bigint hiding in an unread tail.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryEntryBytes: 128 },
      completionProjection: { maxCompletionFullBytes: 128 },
    })

    const result = await realm.run({
      program: `(() => {
        const rows = Array.from({ length: 400 }, (_, index) => index)
        ;(rows as unknown as Record<string, unknown>).extra = 'never read'
        return rows
      })()`,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(envelopeOf(result).projection).toMatchObject({ type: 'array', length: 400 })
  })

  it('succeeds on a non-lossless value hiding past the capture ceiling', async () => {
    // Validity is judged over what the bounded walk reached. The bigint below is
    // never read, so the run succeeds with a projection; the handle still
    // reaches the program's original object rather than the snapshot.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryNodes: 1 },
      completionProjection: { maxCompletionFullBytes: 256 },
    })

    const result = await realm.run({
      program: '({ big: "x".repeat(100000), hidden: 10n })',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(envelopeOf(result).projection?.keys?.map(entry => entry.key)).toEqual(['big', 'hidden'])
  })

  it('keeps a value out of the history when only its exception path ran', async () => {
    // Retention is still reached from the success arm alone; the projector did
    // not move it. An exception produces no envelope and no slot.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const failed = await realm.run({ program: 'throw new Error("boom")', bindings: [] })
    expect(failed.error?.kind).toBe('exception')
    expect(realm.metrics.completionsProjected).toBe(0)
    expect(realm.metrics.completionsRetained).toBe(0)
  })
})

describe('completion projection: bounded observability', () => {
  it('counts what the mechanism did without recording any of it', async () => {
    // The counters provide both inputs to the token-reduction ratio without
    // retaining anything that could identify a value.
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 512 } })

    await realm.run({ program: '({ small: true })', bindings: [] })
    await realm.run({ program: 'Array.from({ length: 400 }, (_, index) => index)', bindings: [] })

    const metrics = realm.metrics
    expect(metrics.completionsFull).toBe(1)
    expect(metrics.completionsProjected).toBe(1)
    // The projection was rich, so no rung was skipped.
    expect(metrics.completionsMinimal).toBe(0)
    expect(metrics.completionsRetained).toBe(2)
    expect(metrics.completionsRejected).toBe(0)
    expect(metrics.historyEntries).toBe(2)
    expect(metrics.captureBytes).toBeGreaterThan(1_000)
    expect(metrics.projectionBytes).toBeGreaterThan(0)
    // The whole point: a projection costs a fraction of what capturing it did.
    expect(metrics.projectionBytes).toBeLessThan(metrics.captureBytes / 4)
  })

  it('counts a reference envelope separately from a described one', async () => {
    // `completionsMinimal` records rung skips. A rate near zero shows the rich
    // rung is doing its job; a sustained rate provides evidence for resizing it.
    const realm = createRealm({
      completionProjection: { maxCompletionFullBytes: 8, maxCompletionProjectionBytes: 8 },
    })

    const result = await realm.run({ program: '({ a: 1, b: 2 })', bindings: [] })
    expect(envelopeOf(result).projection).toBeUndefined()

    const metrics = realm.metrics
    expect(metrics.completionsProjected).toBe(1)
    expect(metrics.completionsMinimal).toBe(1)
    expect(metrics.completionsFull).toBe(0)
    expect(metrics.projectionBytes).toBe(valueBytes(result))
    expect(metrics.captureBytes).toBe(13)
  })

  it('counts refusals, expiries and evictions without naming what was refused', async () => {
    const realm = createRealm({ completionHistory: { maxCompletionHistoryEntries: 2 } })
    await realm.run({ program: '({ one: 1 })', bindings: [] })
    await realm.run({ program: '({ two: 2 })', bindings: [] })
    await realm.run({ program: '({ three: 3 })', bindings: [] })
    expect(realm.metrics.slotsEvicted).toBe(1)
    expect(realm.metrics.historyEntries).toBe(2)

    await realm.run({
      program: `(() => { try { $out(1) } catch { /* expired */ } return 1 })()`,
      bindings: [],
    })
    expect(realm.metrics.handlesExpired).toBe(1)

    // A continuation left behind by an earlier run reaching for the history is
    // the refusal worth counting, and it is counted whether or not a run happens
    // to own the caller when it fires.
    const fenced = createRealm()
    await fenced.run({
      program: `
        let releaseDetached
        const detachedGate = new Promise(resolve => { releaseDetached = resolve })
        void detachedGate.then(() => {
          try { $out.list() } catch { /* refused */ }
          try { $out.clear() } catch { /* refused */ }
        })
        ;({ armed: true })
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(fenced.metrics.accessesRefused).toBe(0)

    await fenced.run({
      program: 'releaseDetached()\nawait new Promise(resolve => setTimeout(resolve, 30))\n1',
      bindings: [tools({ echo: async args => args })],
    })
    expect(fenced.metrics.accessesRefused).toBe(2)
  })

  it('counts an output-limit however the budget ran out', async () => {
    const realm = createRealm({ budgets: { maxOutputBytes: 256 } })
    const starved = await realm.run({
      program: 'console.log("x".repeat(222))\n({ rows: [1, 2, 3] })',
      bindings: [],
    })
    expect(starved.error?.kind).toBe('output-limit')
    expect(realm.metrics.outputLimits).toBe(1)
  })
})

describe('completion projection: configuration', () => {
  it('validates both projection ceilings as positive safe integers', async () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => new PersistentRealm({
        realmId: 'invalid-projection',
        budgets: BUDGETS,
        completionProjection: { maxCompletionFullBytes: invalid },
      })).toThrow('maxCompletionFullBytes must be a positive safe integer')
      expect(() => new PersistentRealm({
        realmId: 'invalid-projection',
        budgets: BUDGETS,
        completionProjection: { maxCompletionProjectionBytes: invalid },
      })).toThrow('maxCompletionProjectionBytes must be a positive safe integer')
    }
  })

  it('takes the runtime defaults for whatever a deployment leaves blank', async () => {
    // At the default 64 KiB full-value threshold, a 60 KiB result crosses whole
    // and a 70 KiB one does not.
    const realm = createRealm()

    const under = await realm.run({ program: '"y".repeat(60000)', bindings: [] })
    expect(under.error).toBeUndefined()
    expect((under.value as string).length).toBe(60000)

    const over = await realm.run({ program: '"y".repeat(70000)', bindings: [] })
    expect(envelopeOf(over).serializedBytesAtCapture).toBe(70002)
  })

  it('lets the two ceilings be set independently of each other', async () => {
    // No rule ties them together, and a deployment that wants everything
    // referenced is entitled to say so.
    const realm = createRealm({
      completionProjection: { maxCompletionFullBytes: 1, maxCompletionProjectionBytes: 4_096 },
    })
    const result = await realm.run({ program: '({ tiny: 1 })', bindings: [] })
    expect(envelopeOf(result).projection).toMatchObject({ type: 'object', keyCount: 1 })
  })
})
