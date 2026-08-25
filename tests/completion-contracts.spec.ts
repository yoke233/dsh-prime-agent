/**
 * Phase 0 contract pinning for the completion-history plan
 * (`docs/plan/completion-history-output-projection.zh.md` §9 Phase 0, §10).
 *
 * Assertions marked `CURRENT CONTRACT` describe behaviour no phase has changed
 * yet. The later phases rewrite them explicitly, one plan section at a time,
 * rather than routing around them: a test here that starts failing is the signal
 * that a phase changed a model-visible contract, and the change has to be argued
 * for in the plan before the expectation moves. An assertion a phase HAS moved
 * is marked `REWRITTEN BY PHASE n` and names the plan section that justified it,
 * so the diff from the Phase 0 baseline stays readable in one file.
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
 * number `maxOutputBytes` bounds, and Phase 2's degradation chain has to keep it
 * bounded whichever rung it ends on.
 */
function wireBytes(result: CodeRunResult): number {
  const logs = Buffer.byteLength(JSON.stringify(result.logs), 'utf8')
  if (result.error) return logs + jsonStringBytes(result.error.message)
  return logs + (Object.hasOwn(result, 'value') ? Buffer.byteLength(JSON.stringify(result.value), 'utf8') : 0)
}

/** One projected completion, as the worker's envelope reaches the model. */
interface Envelope {
  $out?: number
  use?: string
  retained?: boolean
  type?: string
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
    // CURRENT CONTRACT (plan §4.2, §8 "small legal completion"): a small value is
    // returned verbatim, with no envelope, no handle and no metadata. Phase 1
    // must keep this shape byte for byte; only Phase 2 may wrap LARGE values.
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
    // CURRENT CONTRACT (plan §10 "falsy completion 0/false/null/'' also enters the slot"):
    // falsy is a value, not a missing result. The `undefined` case is the ONLY
    // one that omits `value` from the result object.
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
    expect(realm.generation).toBe(1)
  })

  it('accepts a null-prototype object and retains every other exotic prototype as opaque', async () => {
    // REWRITTEN BY WP-C (plan §5 "non-JSON live objects"): the boundary still
    // judges the PROTOTYPE, not the JSON round trip. `Object.create(null)` is
    // admitted and crosses whole; `Date` is still refused the wire — but the
    // refusal no longer fails the cell. The value is retained under the opaque
    // budgets and answered with the fixed envelope, and `toJSON` is never
    // consulted on the way.
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

describe('completion contract: opaque retention (WP-C)', () => {
  it('retains every non-lossless completion with one fixed opaque envelope', async () => {
    // REWRITTEN BY WP-C (plan §5 "non-JSON live objects", acceptance "a
    // successful cell must not fake-fail because wire projection failed"): these
    // values no longer fail the cell with a diagnostic. Each is retained under
    // the opaque budgets and answered with the SAME fixed envelope — a handle,
    // the safe typeof-grade type and the opaque marker — and the original value
    // stays reachable through $out(id) in a later cell.
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
    // REWRITTEN BY WP-C: the boundary walk runs AFTER the program completed, so a
    // getter that throws during classification is charged to the completion, not
    // to the cell — and its own message never reaches the model. The value is
    // retained as opaque and the cell SUCCEEDS, which is what separates this
    // contract from the old invalid-output diagnostic.
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
    // REWRITTEN BY WP-C: the completion is judged after the program body ran, so
    // declarations that completed are retained — and the cell is no longer a
    // failure at all, so the old "partial commit" half of this contract is now
    // just ordinary persistence next to a successful opaque retention.
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
    // REWRITTEN BY PHASE 2 (plan §4.3, §6.1, §9 Phase 2). The ledger still opens
    // at 2 bytes for the empty logs array, so a bare completion may still use
    // `maxOutputBytes - 2` VERBATIM — that half of the Phase 0 contract is
    // unchanged and pinned as tightly as before. What moved is the byte after
    // it: a completion the wire cannot carry whole is no longer a failure, it is
    // a successful bounded reference, and the cap is what the reference is
    // measured against rather than what the value is refused by.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    const fits = MIN_OUTPUT_BYTES - 2 - 2 // minus the empty-array bytes, minus the JSON quotes

    const atCap = await realm.run({ program: `"y".repeat(${fits})`, bindings: [] })
    expect(atCap.error).toBeUndefined()
    expect(jsonStringBytes(atCap.value as string)).toBe(MIN_OUTPUT_BYTES - 2)

    const overCap = await realm.run({ program: `"y".repeat(${fits + 1})`, bindings: [] })
    const envelope = envelopeOf(overCap)
    // At this cap the rich envelope cannot fit either — it would carry a 253
    // character string that is under the projector's own truncation threshold —
    // so the chain lands on the minimal reference, which is the rung the plan
    // sizes against exactly this configuration.
    expect(envelope.projection).toBeUndefined()
    expect(envelope.use).toBe(`$out(${envelope.$out ?? 0})`)
    expect(wireBytes(overCap)).toBeLessThanOrEqual(MIN_OUTPUT_BYTES)
    // Still not a heap failure: the namespace survives, as it did when this was
    // reported as an overflow.
    expect(realm.generation).toBe(1)
  })

  it('charges the cap in UTF-8 bytes rather than in characters', async () => {
    // CURRENT CONTRACT: a 3-byte code point costs three times an ASCII one. The
    // Phase 2 projector counts the same way — the last assertion here is what
    // catches a projector that switched to characters, because a character-
    // counting boundary would have let this value cross whole.
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
    // CURRENT CONTRACT (plan §6.1 "model projection budget"): logs are admitted
    // first and shrink what the completion may use. One merged wire cap is the
    // settled shape, so this arithmetic holds regardless of how logs are ever
    // collected. Phase 2 rewrote only what happens once the completion no longer
    // fits what the logs left: it is referenced rather than refused, and the logs
    // it was competing with are all still there.
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
    // REWRITTEN BY PHASE 2 (plan §6.1, §7.2, acceptance #12). The last rung of
    // the chain is a real one: when the logs have eaten the budget down past what
    // a bare `$out(N)` reference costs, the run reports `output-limit` rather
    // than sending a truncated envelope. This is the case the plan requires the
    // log accounting to be re-reconciled for — the diagnostic wins, and the logs
    // are cut to whole entries to pay for it.
    const realm = createRealm({ maxOutputBytes: MIN_OUTPUT_BYTES })
    const logged = 'x'.repeat(222) // leaves 28 bytes, under the ~43-byte minimal reference

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
    // CURRENT CONTRACT: the asymmetry is load-bearing and easy to lose. A
    // completion too big for the wire is handled by a worker that already
    // finished the program, so the namespace is intact; a log that overflows is
    // reported mid-run and costs the generation, dropping every line. Both halves
    // are SETTLED CONTRACT, not provisional behaviour awaiting a later phase:
    // changing either one means rewriting this case first and arguing for the new
    // asymmetry on its own merits. Phase 2 changed only how the completion half
    // REPORTS — a reference instead of a refusal — and the survival contract this
    // case exists to pin is unchanged.
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
    expect(realm.generation).toBe(2)
    expect((await realm.run({ program: 'typeof lostToLogOverflow', bindings: [] })).value).toBe('undefined')
  })

  it('refuses a realm budget below the fixed diagnostic floor', async () => {
    // CURRENT CONTRACT (`MIN_OUTPUT_BYTES`): the cap can never be small enough to
    // force the overflow diagnostic itself to be truncated. Phase 2's minimum
    // reference envelope constant has to be defined against this same floor.
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
    // CURRENT CONTRACT (plan §6.2 "truncation must not split a surrogate pair"):
    // today nothing truncates a completion, so the baseline is exact round trip
    // — including a lone surrogate, which well-formed `JSON.stringify` escapes
    // and `JSON.parse` restores. Phase 2's projector inherits this obligation.
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
    // CURRENT CONTRACT: the boundary has no key-length, node-count or depth
    // limit today. Phase 1's admission budget and Phase 2's projector both add
    // limits here, so this test records what "no limit" looked like.
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
    // CURRENT CONTRACT: the snapshot walk is recursive and unbounded. Phase 2
    // introduces a hard maximum depth, which will make this exact program
    // produce a bounded projection instead of the whole chain.
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
    // REWRITTEN BY PHASE 1 (plan §4.1, §9 Phase 1, §10 "naming conflict").
    // Previously all three names were undeclared. Phase 1 installs `$out` and
    // `$_` as non-enumerable, CONFIGURABLE accessors — configurable because a
    // non-configurable own global makes a top-level `const $out` fail the whole
    // cell — and deliberately leaves `_` alone, whose strongest prior in JS is
    // lodash. The `_` half of this contract is therefore UNCHANGED; only the
    // `$out`/`$_` half moved, and `completion-history.spec.ts` owns the detailed
    // shadow, assignment and deletion cases.
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
    // REWRITTEN BY PHASE 1 (plan §1, §4.1, §9 Phase 1). The old contract pinned
    // the GAP: an unnamed result was unreachable once the cell settled, which is
    // exactly what this phase closes. The value is now addressable through a
    // runtime-owned handle without the program having named anything, while the
    // model-visible result of the producing cell is unchanged.
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
    // CURRENT CONTRACT (plan §5.3, §10 "affected existing assertions"): there is
    // exactly ONE restart mechanism, and Phase 1 must extend these two lines
    // rather than add a second notice. The neighbouring suite only asserts that
    // the lines CONTAIN 'namespace'/'lost'; the literal text is pinned here.
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
    // REWRITTEN BY PHASE 1 (plan §5.3, §10): a hard kill takes the completion
    // history with the bindings, and the plan keeps ONE restart mechanism, so
    // the fact is added to this line rather than to a second notice.
    expect(notices(restarted)).toEqual(['[prime-realm] live namespace restarted; previous bindings and retained results were lost'])

    const settled = await ctx.primeRealmRuntime.run(realmId('session-notice'), { program: '1', bindings: [] })
    expect(notices(settled)).toEqual([])
  })

  it('gives the realm the deployment cap minus the fixed notice reserve', async () => {
    // CURRENT CONTRACT: the realm never sees the last 512 bytes of the
    // deployment's `maxOutputBytes`. Phase 2 rewrote only what the realm DOES at
    // that reduced cap — a value past it is referenced rather than refused — and
    // the reserve's own guarantee is asserted here against the envelope instead
    // of against the diagnostic that used to take its place.
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
    // REWRITTEN BY PHASE 2 (plan §6.1, §10 "the minimal envelope constant is
    // verified together with the notice reserve"). The 128-byte constant is
    // sized against the WORST legal deployment, not the default one: at the
    // configured floor the realm sees 256 bytes and the completion has about 254
    // of them. If the constant were budgeted against a comfortable cap, this is
    // the configuration where the last rung of the chain would quietly stop
    // being reachable and every large completion would fail instead.
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
    // CURRENT CONTRACT: the configured floor is `MIN_OUTPUT_BYTES + 512`, checked
    // at plugin load rather than on first run.
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
