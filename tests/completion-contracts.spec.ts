/**
 * Completion-boundary contract pinning for the Realm history implementation.
 *
 * Each test states the behavior it currently defends. A failure here means the
 * Realm's canonical completion contract changed and the expectation must move
 * only with an intentional contract change.
 *
 * Ownership boundary with the neighbouring suites: `realm-worker.spec.ts` owns
 * REPL/lease/substrate semantics, `prime-runtime.spec.ts` owns routing and pool
 * governance, and `large-tool-output.e2e.spec.ts` owns the spill composition.
 * What is pinned HERE is only the completion boundary and the output ledger —
 * which values cross it, which are refused, and where every byte boundary sits.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets } from '../src/realm/realm.js'
import * as primeRuntime from '../src/runtime.js'

const BUDGETS: RealmBudgets = {
  computeMs: 5_000,
  maxWallMs: 10_000,
  maxOutputBytes: 65_536,
  maxOldGenerationSizeMb: 128,
}

/**
 * `MIN_OUTPUT_BYTES` in `src/realm/protocol.ts`, restated so a change to the
 * constant has to be acknowledged here too.
 */
const MIN_OUTPUT_BYTES = 256

/**
 * `NOTICE_RESERVE_BYTES` in `src/realm/runtime.ts`: the trailing namespace
 * notice is paid for out of the deployment's cap before the realm ever sees it.
 */
const NOTICE_RESERVE_BYTES = 512

const realms: PersistentRealm[] = []
const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  await Promise.all(realms.splice(0).map(realm => realm.dispose()))
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function createRealm(budgets: Partial<RealmBudgets> = {}): PersistentRealm {
  const realm = new PersistentRealm({ realmId: `realm-${realms.length}`, budgets: { ...BUDGETS, ...budgets } })
  realms.push(realm)
  return realm
}

/** Exact serialized bytes of one string as a JSON string, quotes included — the ledger's own unit. */
function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8')
}

function stateDirectory(): string {
  if (root === undefined) throw new Error('test root was not created')
  return join(root, 'state')
}

async function makeRoot(prefix: string): Promise<void> {
  root = await mkdtemp(join(tmpdir(), prefix))
}

/** Boot a real host row; a rejected plugin still leaves the context to be disposed. */
async function startHost(config: Record<string, unknown> = {}): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(primeRuntime, { stateDirectory: stateDirectory(), ...config })
  return context
}

/**
 * Deterministic 43-char unpadded base64url Realm identity for one test seed,
 * the exact shape the trusted seam accepts and the lease directory verifies.
 */
function realmId(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url')
}

/** The runtime's own namespace notices, separate from program output. */
function notices(result: CodeRunResult): string[] {
  return result.logs.filter(line => line.startsWith('[prime-realm] '))
}

/**
 * Everything one result puts on the wire, in the ledger's own units: the
 * serialized log array plus the serialized completion or diagnostic. This is the
 * number `maxOutputBytes` bounds whichever rung the degradation chain ends on.
 */
function wireBytes(result: CodeRunResult): number {
  const logs = Buffer.byteLength(JSON.stringify(result.logs), 'utf8')
  if (result.error) return logs + jsonStringBytes(result.error.message)
  return logs + (Object.hasOwn(result, 'value') ? Buffer.byteLength(JSON.stringify(result.value), 'utf8') : 0)
}

/** One projected completion, as the worker's envelope reaches the trusted host. */
interface Envelope {
  $out?: number
  use?: string
  retained?: boolean
  type: string
  serializedBytesAtCapture?: number
  projection?: Record<string, unknown>
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

describe('completion contract: values that cross the boundary unchanged', () => {
  it('returns a small lossless completion in its original shape', async () => {
    // A small value is returned verbatim, with no envelope, handle or metadata.
    const realm = createRealm()
    const result = await realm.run({
      program: '({ matches: [{ path: "a.ts", line: 1 }], total: 1, nested: { deep: { ok: true } } })',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ matches: [{ path: 'a.ts', line: 1 }], total: 1, nested: { deep: { ok: true } } })
    expect(result.logs).toEqual([])
  })

  it('returns every falsy lossless completion rather than treating it as absent', async () => {
    // Falsy is a value, not a missing result. `undefined` is the ONLY case that
    // omits `value` from the result object.
    const realm = createRealm()
    const falsy = [
      { program: '0', value: 0 },
      { program: 'false', value: false },
      { program: 'null', value: null },
      { program: '""', value: '' },
    ] as const

    for (const completion of falsy) {
      const result = await realm.run({ program: completion.program, bindings: [] })
      expect(result.error).toBeUndefined()
      expect(result.value).toEqual(completion.value)
      expect(Object.hasOwn(result, 'value')).toBe(true)
    }

    const absent = await realm.run({ program: 'undefined', bindings: [] })
    expect(absent.error).toBeUndefined()
    expect(absent.value).toBeUndefined()
    // Not merely `undefined`: the key is absent, which is how a caller tells a
    // valueless run from one that completed with `null`.
    expect(Object.hasOwn(absent, 'value')).toBe(false)
    expect(absent.presentation).toBeUndefined()
    expect(realm.generation).toBe(1)
  })

  it('accepts a null-prototype object and retains every other exotic prototype as opaque', async () => {
    // The boundary judges the PROTOTYPE, not the JSON round trip.
    // `Object.create(null)` is admitted and crosses whole; `Date` is refused the
    // wire without failing the cell. It is retained under the opaque budgets and
    // answered with the fixed envelope, and `toJSON` is never consulted.
    const realm = createRealm()
    const nullPrototype = await realm.run({
      program: 'Object.assign(Object.create(null), { adopted: true })',
      bindings: [],
    })
    expect(nullPrototype.error).toBeUndefined()
    expect(nullPrototype.value).toEqual({ adopted: true })

    for (const program of ['new Date(0)', 'Object.create({ inherited: true })', 'class Row { constructor() { this.id = 1 } }\nnew Row()']) {
      const result = await realm.run({ program, bindings: [] })
      expect(result.error, program).toBeUndefined()
      expect(result.value, program).toMatchObject({ retained: true, opaque: true, truncated: true })
    }
    expect(realm.generation).toBe(1)
  })
})

describe('completion contract: opaque retention', () => {
  it('retains every non-lossless completion with one fixed opaque envelope', async () => {
    // Non-lossless values do not fail the cell with a diagnostic. Each is
    // retained under the opaque budgets and answered with the SAME fixed
    // envelope — a handle, the safe typeof-grade type and the opaque marker —
    // while the original value remains reachable through `$out(id)`.
    const realm = createRealm()
    const retained = [
      { why: 'function', program: '(() => 42)' },
      { why: 'bigint', program: '10n' },
      { why: 'symbol', program: 'Symbol("completion")' },
      { why: 'cycle', program: 'const cyclic = { name: "c" }\ncyclic.self = cyclic\ncyclic' },
      { why: 'exotic prototype', program: 'new Map([["answer", 42]])' },
      { why: 'sparse array', program: '[1, , 3]' },
      { why: 'array with an extra property', program: 'const extra = [1, 2]\nextra.note = "x"\nextra' },
      { why: 'non-enumerable own property', program: 'const hidden = {}\nObject.defineProperty(hidden, "secret", { value: 1, enumerable: false })\nhidden' },
      { why: 'symbol-keyed own property', program: '({ visible: 1, [Symbol("tag")]: 2 })' },
      { why: 'negative zero', program: '-0' },
      { why: 'nested negative zero', program: '({ delta: -0 })' },
      { why: 'NaN', program: 'NaN' },
      { why: 'Infinity', program: 'Infinity' },
      { why: '-Infinity', program: '({ floor: -Infinity })' },
      { why: 'undefined inside an object', program: '({ present: 1, missing: undefined })' },
      { why: 'undefined inside an array', program: '[1, undefined]' },
    ] as const

    for (const completion of retained) {
      const result = await realm.run({ program: completion.program, bindings: [] })
      expect(result.error, completion.why).toBeUndefined()
      const envelope = result.value as Record<string, unknown>
      expect(envelope, completion.why).toMatchObject({ retained: true, opaque: true, truncated: true })
      expect(typeof envelope.$out, completion.why).toBe('number')
      expect(envelope.use, completion.why).toBe(`$out(${String(envelope.$out)})`)
    }
    // None of these cost the realm its heap: they are retained values, not
    // substrate failures.
    expect(realm.generation).toBe(1)
  })

  it('keeps a throwing getter as an opaque retention rather than as a program exception', async () => {
    // The boundary walk runs AFTER the program completed, so a getter that
    // throws during classification is charged to the completion, not to the
    // cell, and its message never enters trusted presentation metadata. The
    // value is retained as opaque and the cell succeeds.
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
    expect(JSON.stringify(result.value)).not.toContain('getter exploded')
    expect(result.value).toMatchObject({ retained: true, opaque: true, truncated: true })
    expect(realm.generation).toBe(1)
  })

  it('keeps bindings beside a non-lossless completion, which now succeeds', async () => {
    // The completion is judged after the program body ran, so completed
    // declarations persist beside a successful opaque retention.
    const realm = createRealm()
    const cases = [
      { name: 'keptBesideBigint', completion: '10n' },
      { name: 'keptBesideSymbol', completion: 'Symbol("s")' },
      { name: 'keptBesideFunction', completion: '(() => 1)' },
      { name: 'keptBesideSparseArray', completion: '[1, , 3]' },
      { name: 'keptBesideUndefinedMember', completion: '{ absent: undefined }' },
    ] as const

    for (const partial of cases) {
      const succeeded = await realm.run({
        program: `const ${partial.name} = { kept: true }\n;(${partial.completion})`,
        bindings: [],
      })
      expect(succeeded.error, partial.name).toBeUndefined()
      expect(succeeded.value, partial.name).toMatchObject({ retained: true, opaque: true, truncated: true })
      expect((await realm.run({ program: partial.name, bindings: [] })).value, partial.name).toEqual({ kept: true })
    }
    expect(realm.generation).toBe(1)
  })
})

describe('completion contract: output-limit byte boundaries', () => {
  it('admits a completion that exactly fills the cap and references the next byte', async () => {
    // The ledger opens at 2 bytes for the empty logs array, so a bare completion
    // may use `maxOutputBytes - 2` verbatim. The next byte produces a successful
    // bounded reference measured against the same cap rather than failing the
    // completion.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    const fits = MIN_OUTPUT_BYTES - 2 - 2 // minus the empty-array bytes, minus the JSON quotes

    const atCap = await realm.run({ program: `"y".repeat(${fits})`, bindings: [] })
    expect(atCap.error).toBeUndefined()
    expect(jsonStringBytes(atCap.value as string)).toBe(MIN_OUTPUT_BYTES - 2)

    const overCap = await realm.run({ program: `"y".repeat(${fits + 1})`, bindings: [] })
    const envelope = envelopeOf(overCap)
    // At this cap the rich envelope cannot fit either — it would carry a 253
    // character string that is under the projector's own truncation threshold —
    // so the chain lands on the minimal reference.
    expect(envelope.projection).toBeUndefined()
    expect(envelope.use).toBe(`$out(${envelope.$out ?? 0})`)
    expect(envelope.type).toBe('string')
    expect(overCap.presentation).toEqual({
      kind: 'retained-preview',
      valueType: 'string',
      handle: envelope.$out,
    })
    expect(wireBytes(overCap)).toBeLessThanOrEqual(MIN_OUTPUT_BYTES)
    // Still not a heap failure: the namespace survives, as it did when this was
    // reported as an overflow.
    expect(realm.generation).toBe(1)
  })

  it('charges the cap in UTF-8 bytes rather than in characters', async () => {
    // A 3-byte code point costs three times an ASCII one. The last assertion
    // catches a projector that switched to characters, which would let this
    // value cross whole.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    const fitting = Math.floor((MIN_OUTPUT_BYTES - 4) / 3)

    const ascii = await realm.run({ program: `"y".repeat(${fitting * 3})`, bindings: [] })
    expect(ascii.error).toBeUndefined()

    const multibyte = await realm.run({ program: `"中".repeat(${fitting})`, bindings: [] })
    expect(multibyte.error).toBeUndefined()
    expect(jsonStringBytes(multibyte.value as string)).toBe(fitting * 3 + 2)

    const overCap = await realm.run({ program: `"中".repeat(${fitting + 1})`, bindings: [] })
    expect(envelopeOf(overCap).truncated).toBe(true)
    expect(wireBytes(overCap)).toBeLessThanOrEqual(MIN_OUTPUT_BYTES)
    expect(realm.generation).toBe(1)
  })

  it('spends one shared budget on logs and the completion together', async () => {
    // Logs are admitted first and shrink what the completion may use. Once the
    // completion no longer fits what the logs left, it is referenced rather than
    // refused, and the logs it was competing with remain present.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    const logged = 'x'.repeat(100)
    const remaining = MIN_OUTPUT_BYTES - 2 - jsonStringBytes(logged)
    const program = (completionLength: number): string =>
      `console.log("x".repeat(100))\n"y".repeat(${completionLength})`

    const atCap = await realm.run({ program: program(remaining - 2), bindings: [] })
    expect(atCap.error).toBeUndefined()
    expect(atCap.logs).toEqual([logged])
    expect(jsonStringBytes(atCap.value as string)).toBe(remaining)

    const overCap = await realm.run({ program: program(remaining - 1), bindings: [] })
    expect(envelopeOf(overCap).truncated).toBe(true)
    expect(overCap.logs).toEqual([logged])
    expect(wireBytes(overCap)).toBeLessThanOrEqual(MIN_OUTPUT_BYTES)
    expect(realm.generation).toBe(1)
  })

  it('still reports output-limit when even a minimal reference does not fit', async () => {
    // When logs leave less room than the typed minimal reference costs, the run
    // reports `output-limit` rather than sending a truncated envelope. The
    // diagnostic wins, and logs are cut only at whole-entry boundaries to pay
    // for it.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    const logged = 'x'.repeat(222)

    const starved = await realm.run({
      program: `console.log("x".repeat(222))\n({ rows: [1, 2, 3] })`,
      bindings: [],
    })
    expect(starved.error).toEqual({ kind: 'output-limit', message: `outer output exceeded ${MIN_OUTPUT_BYTES} bytes` })
    // The whole-entry prefix rule decides the logs: this one entry plus the fixed
    // diagnostic does not fit, so it is dropped whole rather than sliced.
    expect(starved.logs).toEqual([])
    expect(jsonStringBytes(logged)).toBeGreaterThan(MIN_OUTPUT_BYTES - jsonStringBytes(`outer output exceeded ${MIN_OUTPUT_BYTES} bytes`))
    expect(wireBytes(starved)).toBeLessThanOrEqual(MIN_OUTPUT_BYTES)
    expect(realm.generation).toBe(1)
  })

  it('separates a completion overflow from a log overflow by whether the realm survives', async () => {
    // The asymmetry is load-bearing: a completion too large for the wire is
    // handled after the program finishes, so the namespace survives; a log
    // overflow is reported mid-run, costs the generation and drops every line.
    // This test pins both halves of that contract.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })

    const completionOverflow = await realm.run({
      program: 'const keptAcrossCompletionOverflow = "v1"\n"y".repeat(4000)',
      bindings: [],
    })
    expect(envelopeOf(completionOverflow).truncated).toBe(true)
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: 'keptAcrossCompletionOverflow', bindings: [] })).value).toBe('v1')

    const logOverflow = await realm.run({
      program: 'const lostToLogOverflow = "v1"\nconsole.log("x".repeat(4000))\n"ok"',
      bindings: [],
    })
    expect(logOverflow.error?.kind).toBe('output-limit')
    expect(logOverflow.logs).toEqual([])
    expect(logOverflow.presentation).toBeUndefined()
    expect(realm.generation).toBe(2)
    expect((await realm.run({ program: 'typeof lostToLogOverflow', bindings: [] })).value).toBe('undefined')
  })

  it('refuses a realm budget below the fixed diagnostic floor', async () => {
    // The cap cannot be small enough to truncate the overflow diagnostic. The
    // minimum reference-envelope constant is defined against the same floor.
    expect(() => new PersistentRealm({
      realmId: 'below-floor',
      budgets: { ...BUDGETS, maxOutputBytes: MIN_OUTPUT_BYTES - 1 },
    })).toThrow(`realm budget maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}`)

    expect(() => new PersistentRealm({
      realmId: 'fractional',
      budgets: { ...BUDGETS, maxOutputBytes: MIN_OUTPUT_BYTES + 0.5 },
    })).toThrow(`realm budget maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}`)

    // Exactly at the floor the realm is usable, and the diagnostic still fits.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    expect((await realm.run({ program: '21 * 2', bindings: [] })).value).toBe(42)
  })
})

describe('completion contract: adversarial value shapes', () => {
  it('carries surrogate pairs and lone surrogates through unchanged', async () => {
    // The lossless completion round-trip is exact, including a lone surrogate
    // that well-formed `JSON.stringify` escapes and `JSON.parse` restores. The
    // projector separately preserves surrogate pairs when truncating.
    const realm = createRealm()
    const result = await realm.run({
      program: `({ emoji: '\u{1f600}\u{1f469}‍\u{1f4bb}', mixed: 'aé中\u{1f600}', lone: '\\uD800', pair: '\\uD83D\\uDE00' })`,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({
      emoji: '\u{1f600}\u{1f469}‍\u{1f4bb}',
      mixed: 'aé中\u{1f600}',
      lone: '\uD800',
      pair: '\u{1f600}',
    })
    expect((result.value as { lone: string }).lone.length).toBe(1)
  })

  it('accepts an extremely long key, empty containers and null in every position', async () => {
    // Values inside the full-value threshold cross unchanged, including long
    // keys, empty containers and null at any position.
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const longKey = 'k'.repeat(20000)
        ;({
          [longKey]: 'v',
          emptyArray: [],
          emptyObject: {},
          nestedEmpty: [[], {}, [[]]],
          nulls: [null, { inner: null }],
          nullValue: null,
        })
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    const value = result.value as Record<string, unknown>
    expect(value['k'.repeat(20000)]).toBe('v')
    expect(value.emptyArray).toEqual([])
    expect(value.emptyObject).toEqual({})
    expect(value.nestedEmpty).toEqual([[], {}, [[]]])
    expect(value.nulls).toEqual([null, { inner: null }])
    expect(value.nullValue).toBeNull()
  })

  it('carries a deeply nested value across the boundary without a depth ceiling', async () => {
    // A deeply nested value inside the full-value threshold crosses whole; the
    // projector's depth limit applies only when projection is needed.
    const realm = createRealm()
    const depth = 200
    const result = await realm.run({
      program: `
        let deep: unknown = { leaf: true }
        for (let index = 0; index < ${depth}; index++) deep = { next: deep }
        deep
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()

    let walked = result.value as Record<string, unknown>
    let levels = 0
    while (Object.hasOwn(walked, 'next')) {
      walked = walked.next as Record<string, unknown>
      levels += 1
    }
    expect(levels).toBe(depth)
    expect(walked).toEqual({ leaf: true })
  })

  it('leaves `_` to the program while owning `$out` and `$_`', async () => {
    // `$out` and `$_` are non-enumerable, CONFIGURABLE accessors; configurable
    // because a non-configurable own global would make top-level `const $out`
    // fail the whole cell. `_` remains unclaimed because its strongest JavaScript
    // prior is lodash. `completion-history.spec.ts` owns detailed shadow,
    // assignment and deletion coverage.
    const realm = createRealm()
    const ambient = await realm.run({
      program: `({
        underscore: typeof _,
        out: typeof $out,
        ownUnderscore: Object.hasOwn(globalThis, '_'),
        ownOut: Object.hasOwn(globalThis, '$out'),
        ownLast: Object.hasOwn(globalThis, '$_'),
        enumerated: Object.keys(globalThis).filter(name => name === '$out' || name === '$_'),
      })`,
      bindings: [],
    })
    expect(ambient.error).toBeUndefined()
    expect(ambient.value).toEqual({
      underscore: 'undefined',
      out: 'function',
      ownUnderscore: false,
      ownOut: true,
      ownLast: true,
      // Non-enumerable, so nothing that walks the globals trips over them.
      enumerated: [],
    })

    // A cell may still claim both names lexically; the intrinsic is shadowed
    // rather than rejected, exactly as it was when the name was undeclared.
    const claimed = await realm.run({
      program: 'const _ = "user underscore"\nconst $out = { userOwned: true }\n;({ _, $out })',
      bindings: [],
    })
    expect(claimed.error).toBeUndefined()
    expect(claimed.value).toEqual({ _: 'user underscore', $out: { userOwned: true } })

    // And they persist like any other user binding.
    expect((await realm.run({ program: '[_, $out.userOwned]', bindings: [] })).value).toEqual(['user underscore', true])
    expect(realm.generation).toBe(1)
  })

  it('retains a completion the program did not bind itself', async () => {
    // An unnamed result is addressable through a runtime-owned handle without
    // the program naming it, while the producing cell's canonical result stays
    // unchanged.
    const realm = createRealm()
    const produced = await realm.run({ program: '({ rows: [1, 2, 3] })', bindings: [] })
    expect(produced.error).toBeUndefined()
    expect(produced.value).toEqual({ rows: [1, 2, 3] })
    expect(Object.keys(produced)).toEqual(['logs', 'value'])

    const recalled = await realm.run({
      program: 'const [entry] = $out.list()\n;({ underscore: typeof _, handled: $out(entry.id), last: $_ })',
      bindings: [],
    })
    expect(recalled.value).toEqual({
      underscore: 'undefined',
      handled: { rows: [1, 2, 3] },
      last: { rows: [1, 2, 3] },
    })
  })
})

describe('completion contract: host-level notices and the notice reserve', () => {
  it('pins the exact namespace notice wording on a fresh and on a restarted realm', async () => {
    // There is one restart mechanism and one notice line. The neighbouring suite
    // checks only for 'namespace'/'lost'; this test pins the literal wording.
    await makeRoot('dsh-prime-contract-notice-')
    const ctx = await startHost({ maxWallMs: 400 })

    const fresh = await ctx.primeRealmRuntime.run(realmId('session-notice'), { program: 'const kept = "v1"\nkept', bindings: [] })
    expect(notices(fresh)).toEqual(['[prime-realm] live namespace started empty'])

    const killed = await ctx.primeRealmRuntime.run(realmId('session-notice'), { program: 'for (;;) {}', bindings: [] })
    expect(killed.error?.kind).toBe('timeout')
    expect(notices(killed)).toEqual([])

    const restarted = await ctx.primeRealmRuntime.run(realmId('session-notice'), {
      program: 'typeof kept === "undefined" ? null : kept',
      bindings: [],
    })
    expect(restarted.value).toBeNull()
    // A hard kill takes retained results with bindings, so the single restart
    // notice reports both losses.
    expect(notices(restarted)).toEqual(['[prime-realm] live namespace restarted; previous bindings and retained results were lost'])

    const settled = await ctx.primeRealmRuntime.run(realmId('session-notice'), { program: '1', bindings: [] })
    expect(notices(settled)).toEqual([])
  })

  it('gives the realm the deployment cap minus the fixed notice reserve', async () => {
    // The realm never sees the last 512 bytes of deployment `maxOutputBytes`.
    // A value past the reduced cap is referenced, and this test checks the
    // reserve against that envelope.
    await makeRoot('dsh-prime-contract-reserve-')
    const maxOutputBytes = 2_048
    const realmBytes = maxOutputBytes - NOTICE_RESERVE_BYTES
    const ctx = await startHost({ maxOutputBytes })

    const overflowed = await ctx.primeRealmRuntime.run(realmId('session-reserve'), {
      program: `"Z".repeat(${realmBytes})`,
      bindings: [],
    })
    const envelope = envelopeOf(overflowed)
    expect(envelope.type).toBe('string')
    expect(envelope.serializedBytesAtCapture).toBe(realmBytes + 2)
    expect(notices(overflowed)).toEqual(['[prime-realm] live namespace started empty'])

    // Even with the notice appended, the whole wire payload stays under the
    // deployment's cap — the property the reserve exists to guarantee.
    expect(wireBytes(overflowed)).toBeLessThanOrEqual(maxOutputBytes)

    // One byte under the reduced cap still crosses, so the reserve is a clean
    // subtraction rather than an approximate margin.
    const fits = await ctx.primeRealmRuntime.run(realmId('session-reserve'), {
      program: `"Z".repeat(${realmBytes - 4})`,
      bindings: [],
    })
    expect(fits.error).toBeUndefined()
    expect(jsonStringBytes(fits.value as string)).toBe(realmBytes - 2)
  })

  it('fits a minimal reference beside the notice reserve at the smallest legal cap', async () => {
    // The reference-envelope constant is sized against the smallest legal
    // deployment, where the realm receives 256 bytes and the completion has
    // about 254. This keeps the last rung reachable even at the floor.
    await makeRoot('dsh-prime-contract-minimal-')
    const maxOutputBytes = MIN_OUTPUT_BYTES + NOTICE_RESERVE_BYTES
    const ctx = await startHost({ maxOutputBytes })

    const referenced = await ctx.primeRealmRuntime.run(realmId('session-minimal'), {
      program: `"Z".repeat(4000)`,
      bindings: [],
    })
    const envelope = envelopeOf(referenced)
    expect(envelope.use).toBe(`$out(${envelope.$out ?? 0})`)
    expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(128)

    // The notice is appended after the realm finalized its ledger, and the whole
    // payload still clears the deployment's cap.
    expect(notices(referenced)).toEqual(['[prime-realm] live namespace started empty'])
    expect(wireBytes(referenced)).toBeLessThanOrEqual(maxOutputBytes)

    // And the reference works: the value it names survived the cap that could
    // not carry it.
    const recovered = await ctx.primeRealmRuntime.run(realmId('session-minimal'), {
      program: `$out(${envelope.$out ?? 0}).length`,
      bindings: [],
    })
    expect(recovered.value).toBe(4000)
  })

  it('refuses a deployment cap that cannot pay for both the reserve and the floor', async () => {
    // The configured floor is `MIN_OUTPUT_BYTES + 512`, checked at plugin load.
    await makeRoot('dsh-prime-contract-floor-')
    const floor = MIN_OUTPUT_BYTES + NOTICE_RESERVE_BYTES

    await expect(startHost({ maxOutputBytes: floor - 1 }))
      .rejects.toThrow(`maxOutputBytes must be a safe integer of at least ${floor}`)

    const ctx = await startHost({ maxOutputBytes: floor })
    const result = await ctx.primeRealmRuntime.run(realmId('session-floor'), { program: '21 * 2', bindings: [] })
    expect(result.value).toBe(42)
    expect(notices(result)).toEqual(['[prime-realm] live namespace started empty'])
  })
})
