/**
 * Phase 1 of the completion-history plan
 * (`docs/plan/completion-history-output-projection.zh.md` §9 Phase 1, §10
 * "Worker/Realm unit tests").
 *
 * What is exercised here is the runtime-owned history itself: which completions
 * enter it, which handle they get, when they leave, and who is allowed to touch
 * them. The MODEL-VISIBLE shape of a completion is deliberately not this file's
 * subject — Phase 1 leaves it untouched, and `completion-contracts.spec.ts`
 * remains the place that pins it.
 *
 * Two mechanics shape almost every test below and are worth stating once:
 *
 * - Handles are allocated by the HOST, one per dispatched run, from a counter
 *   that is monotonic for the whole process. Tests therefore never assert an
 *   absolute id; they assert ordering, absence and reuse.
 * - A top-level `const $out` is a REPL declaration, so it shadows the intrinsic
 *   for the rest of that realm's generation. Every naming-conflict case gets its
 *   own realm.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { decodeChallenge, RealmIdentityStore } from '../src/realm/identity.js'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets, RealmCompletionHistoryLimits } from '../src/realm/realm.js'
import * as primeRuntime from '../src/runtime.js'

const BUDGETS: RealmBudgets = {
  computeMs: 5_000,
  maxWallMs: 10_000,
  maxOutputBytes: 65_536,
  maxOldGenerationSizeMb: 128,
}

/** The single message every non-lossless completion still gets in Phase 1. */
const INVALID_COMPLETION: CodeRunResult['error'] = {
  kind: 'invalid-output',
  message: 'program completion must be lossless JSON',
}

const realms: PersistentRealm[] = []
const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  await Promise.all(realms.splice(0).map(realm => realm.dispose()))
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function createRealm(options: {
  budgets?: Partial<RealmBudgets>
  completionHistory?: Partial<RealmCompletionHistoryLimits>
} = {}): PersistentRealm {
  const realm = new PersistentRealm({
    realmId: `realm-${realms.length}`,
    budgets: { ...BUDGETS, ...options.budgets },
    ...options.completionHistory ? { completionHistory: options.completionHistory } : {},
  })
  realms.push(realm)
  return realm
}

/* eslint-disable @typescript-eslint/no-explicit-any -- test bindings receive already-validated JSON */
function tools(functions: Record<string, (args: any) => Promise<CodeJsonValue>>): CodeBindingNamespace {
  return { global: 'tools', functions: functions as Record<string, CodeBindingFunction> }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function stateDirectory(): string {
  if (root === undefined) throw new Error('test root was not created')
  return join(root, 'state')
}

/** Boot a real host row, so the plugin config actually reaches a realm. */
async function startHost(config: Record<string, unknown> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prime-history-'))
  const context = new Context()
  contexts.push(context)
  await context.plugin(primeRuntime, { stateDirectory: stateDirectory(), ...config })
  return context
}

/** Bindings that make a request a Prime request, over the key the runtime verifies. */
function primeFor(sessionOwner: string): CodeBindingNamespace[] {
  return [{
    global: 'tools',
    functions: {
      prime_realm_identity: async (args: any) => {
        const challenge = decodeChallenge(args?.challenge)
        if (challenge === undefined) throw new Error('handshake challenge was not 32 bytes')
        const { token, proof } = await new RealmIdentityStore({ directory: join(stateDirectory(), 'realm-identity') })
          .issue(sessionOwner, challenge)
        return { protocol: 1, token, proof }
      },
    } as unknown as Record<string, CodeBindingFunction>,
  }]
}

/** One `$out.list()` row, as the intrinsic renders it. */
interface HistoryRow {
  id: number
  type: string
  serializedBytesAtCapture: number
  nodes: number
  /** Own key total of a root object; 0 for every other type. */
  keyCount: number
}

/**
 * Read one value out of a cell through its LOGS.
 *
 * Reading through a completion would not be an observation: the cell's own
 * result enters the history like any other, so `$out.list()` as a final
 * expression would append a row on every look. A logged read completes with
 * `undefined`, which retains nothing and leaves `$_` where it was.
 */
async function probe(realm: PersistentRealm, expression: string): Promise<unknown> {
  const result = await realm.run({ program: `console.log(JSON.stringify(${expression}))`, bindings: [] })
  expect(result.error).toBeUndefined()
  return JSON.parse(result.logs[0] as string) as unknown
}

async function history(realm: PersistentRealm): Promise<HistoryRow[]> {
  return await probe(realm, '$out.list()') as HistoryRow[]
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

describe('completion history: what enters a slot', () => {
  it('retains a completion the program never bound and hands it back through its handle', async () => {
    // Plan §10 "a large unnamed tool result stays reachable through $out(id)":
    // this is the gap Phase 1 exists to close, and it closes it without the
    // program naming anything.
    const realm = createRealm()
    const produced = await realm.run({
      program: 'await globalThis.tools.rows({})',
      bindings: [tools({ rows: async () => ({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }] }) })],
    })
    // The model-visible shape is unchanged: no envelope, no handle, no metadata.
    expect(produced.error).toBeUndefined()
    expect(produced.value).toEqual({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }] })

    const rows = await history(realm)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('object')
    expect(rows[0]?.serializedBytesAtCapture).toBeGreaterThan(0)
    expect(rows[0]?.nodes).toBeGreaterThan(0)

    const recomputed = await realm.run({
      program: `$out(${rows[0]?.id ?? 0}).rows.reduce((total, row) => total + row.n, 0)`,
      bindings: [],
    })
    expect(recomputed.value).toBe(6)
  })

  it('retains every falsy completion rather than treating it as absent', async () => {
    // Plan §10: `0/false/null/''` are values. `undefined` is the only completion
    // that produces no result at all, and therefore no slot.
    const realm = createRealm()
    for (const program of ['0', 'false', 'null', '""']) {
      expect((await realm.run({ program, bindings: [] })).error).toBeUndefined()
    }
    expect(await history(realm)).toHaveLength(4)

    const absent = createRealm()
    expect((await absent.run({ program: 'undefined', bindings: [] })).error).toBeUndefined()
    expect(await history(absent)).toEqual([])
  })

  it('reads the last completion through `$_`', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ first: true })', bindings: [] })
    expect((await realm.run({ program: '$_', bindings: [] })).value).toEqual({ first: true })
    // `$_` follows the last completion, which is now the `$_` read above.
    expect((await realm.run({ program: '$_', bindings: [] })).value).toEqual({ first: true })
  })

  it('answers an empty history with undefined rather than with an error', async () => {
    // Plan §5.3: an empty history is a normal state for `$_` and `list()`, but a
    // handle that names nothing is still an explicit expiry.
    const realm = createRealm()
    const empty = await realm.run({
      program: '({ entries: $out.list().length, last: typeof $_ })',
      bindings: [],
    })
    expect(empty.value).toEqual({ entries: 0, last: 'undefined' })

    const missing = await realm.run({ program: caught('$out(1)'), bindings: [] })
    expect(missing.value).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
    expect((missing.value as unknown as CaughtRejection).message).toContain('recompute it')
  })

  it('opens no slot for an exception or an invalid completion', async () => {
    // Plan §7.1: only the SUCCESS arm of the boundary retains. `startRun`'s
    // `finally` releases the object group on every path, so a slot opened there
    // would also capture values from runs that failed.
    const realm = createRealm()
    expect((await realm.run({ program: 'throw new Error("boom")', bindings: [] })).error?.kind).toBe('exception')
    expect((await realm.run({ program: '({ fn: () => 1 })', bindings: [] })).error).toEqual(INVALID_COMPLETION)
    expect(await history(realm)).toEqual([])
    // REWRITTEN BY PHASE 2 (plan §9 Phase 2): the oversized completion used to
    // belong on this list, as the third way a run could fail. It is now a
    // success that retains — which is the whole point of the phase, and which
    // this suite covers where the projection lives rather than here.
    const projected = await realm.run({ program: '"y".repeat(70000)', bindings: [] })
    expect(projected.error).toBeUndefined()
    expect(await history(realm)).toHaveLength(1)
    // None of the three cost the realm its heap.
    expect(realm.generation).toBe(1)
  })

  it('burns no handle on a run that never reaches a worker', async () => {
    // A queued run cancelled by its own signal never dispatches, so it never
    // reserves a handle; the ids on either side of it stay adjacent.
    const realm = createRealm()
    const gate = deferred<CodeJsonValue>()
    const blocking = realm.run({
      program: 'await globalThis.tools.park({})\n;({ blocking: true })',
      bindings: [tools({ park: async () => await gate.promise })],
    })
    const controller = new AbortController()
    const queued = realm.run({ program: '({ queued: true })', bindings: [], signal: controller.signal })
    controller.abort(new Error('cancelled while queued'))
    expect((await queued).error?.kind).toBe('abort')
    gate.resolve({ ok: true })
    expect((await blocking).value).toEqual({ blocking: true })

    await realm.run({ program: '({ after: true })', bindings: [] })
    const rows = await history(realm)
    expect(rows.map(row => row.type)).toEqual(['object', 'object'])
    expect((rows[1]?.id ?? 0) - (rows[0]?.id ?? 0)).toBe(1)
  })
})

describe('completion history: identity', () => {
  it('retains the program\'s own object, so a later in-place change is visible through the handle', async () => {
    // Plan §5.1/§5.2: the history holds the ORIGINAL reference, not a copy. That
    // is what keeps a user binding and the history from doubling the heap, and
    // it is why `serializedBytesAtCapture` is named for the moment it was taken.
    const realm = createRealm()
    await realm.run({ program: 'const shared = { rows: [1, 2] }\nshared', bindings: [] })
    const [row] = await history(realm)
    const id = row?.id ?? 0

    const same = await realm.run({ program: `$out(${id}) === shared`, bindings: [] })
    expect(same.value).toBe(true)

    const mutated = await realm.run({ program: `shared.rows.push(3)\n$out(${id})`, bindings: [] })
    expect(mutated.value).toEqual({ rows: [1, 2, 3] })
    // The capture-time byte count deliberately does NOT follow the mutation.
    const [after] = await history(realm)
    expect(after?.serializedBytesAtCapture).toBe(row?.serializedBytesAtCapture)
  })

  it('reuses the slot, the handle and the FIFO position when the same object completes again', async () => {
    // Plan §5.2 / benchmark §3.6, §4.3: per-slot billing flushed the history in
    // two of three recirculation traces, and did it in the worst possible shape
    // — the object still in the store under a new id while the handle the model
    // held had expired. Two entries of budget make that failure observable.
    const realm = createRealm({ completionHistory: { maxCompletionHistoryEntries: 2 } })
    await realm.run({ program: 'const alpha = { tag: "alpha" }\nalpha', bindings: [] })
    await realm.run({ program: 'const beta = { tag: "beta" }\nbeta', bindings: [] })
    const before = await history(realm)
    expect(before.map(entry => entry.type)).toEqual(['object', 'object'])

    const recirculated = await realm.run({ program: `$out(${before[0]?.id ?? 0})`, bindings: [] })
    expect(recirculated.value).toEqual({ tag: 'alpha' })

    const after = await history(realm)
    // No new slot, no new handle, and alpha keeps its original FIFO position:
    // under per-slot billing beta would have been evicted here.
    expect(after.map(entry => entry.id)).toEqual(before.map(entry => entry.id))
    expect(await probe(realm, `$out(${before[1]?.id ?? 0})`)).toEqual({ tag: 'beta' })
    // `$_` follows the LAST COMPLETION, which is the reused slot rather than the
    // newest one: an identity hit keeps its FIFO position, so reading the tail
    // of the history would answer with beta here.
    expect(await probe(realm, '$_')).toEqual({ tag: 'alpha' })
  })

  it('reuses a slot for a repeated object but never for a repeated primitive', async () => {
    // Identity reuse is scoped to objects on purpose. `Object.is` on strings
    // compares CONTENT, so two independently computed equal strings are not the
    // same result in any sense the model would recognize — folding them together
    // would park the newer one at the older one's FIFO position — and the
    // comparison is O(length) against every slot on every capture.
    const realm = createRealm()
    await realm.run({ program: 'const twice = { n: 1 }\ntwice', bindings: [] })
    await realm.run({ program: 'twice', bindings: [] })
    expect(await history(realm)).toHaveLength(1)

    const strings = createRealm()
    await strings.run({ program: '"same"', bindings: [] })
    await strings.run({ program: '"same"', bindings: [] })
    const rows = await history(strings)
    expect(rows.map(row => row.type)).toEqual(['string', 'string'])
    expect(rows[0]?.id).not.toBe(rows[1]?.id)
  })

  it('keeps a user binding and the history from owning each other', async () => {
    // Plan §3 principle 6 and §5.1: dropping the history's claim must not reach
    // the program's own declaration, in either direction.
    const realm = createRealm()
    await realm.run({ program: 'const owned = { n: 1 }\nowned', bindings: [] })
    const [row] = await history(realm)
    const id = row?.id ?? 0

    const dropped = await realm.run({ program: `({ dropped: $out.drop(${id}), binding: owned })`, bindings: [] })
    expect(dropped.value).toEqual({ dropped: true, binding: { n: 1 } })

    const gone = await realm.run({ program: caught(`$out(${id})`), bindings: [] })
    expect(gone.value).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
    // The program's binding is untouched by the eviction of the runtime's claim.
    expect((await realm.run({ program: 'owned', bindings: [] })).value).toEqual({ n: 1 })
  })

  it('keeps the retained object addressable after the program makes it non-serializable', async () => {
    // Plan §10: mutating a retained value into something non-JSON must not
    // corrupt the history, and returning it again is an ordinary invalid-output
    // whose cell still keeps the bindings it committed.
    const realm = createRealm()
    await realm.run({ program: 'const spoiled = { n: 1 }\nspoiled', bindings: [] })
    const [row] = await history(realm)
    const id = row?.id ?? 0

    const failed = await realm.run({
      program: 'const keptBesideSpoiling = "kept"\nspoiled.fn = () => 1\nspoiled',
      bindings: [],
    })
    expect(failed.error).toEqual(INVALID_COMPLETION)
    // Partial commit is unchanged: the declaration that completed survives.
    expect(await probe(realm, 'keptBesideSpoiling')).toBe('kept')
    // The slot still holds the same object; only its serializability changed.
    expect(await probe(realm, `typeof $out(${id}).fn`)).toBe('function')
    // The failed cell opened no slot of its own.
    expect(await history(realm)).toHaveLength(1)
  })
})

describe('completion history: budgets and eviction', () => {
  it('evicts oldest first when the entry budget is full', async () => {
    const realm = createRealm({ completionHistory: { maxCompletionHistoryEntries: 3 } })
    for (const tag of ['a', 'b', 'c', 'd']) {
      await realm.run({ program: `({ tag: ${JSON.stringify(tag)} })`, bindings: [] })
    }
    const rows = await history(realm)
    expect(rows).toHaveLength(3)
    const ids = rows.map(row => row.id)
    expect(ids[0]).toBeLessThan(ids[1] as number)
    expect(ids[1]).toBeLessThan(ids[2] as number)

    const survivors = await realm.run({
      program: `[${ids.map(id => `$out(${id}).tag`).join(', ')}]`,
      bindings: [],
    })
    expect(survivors.value).toEqual(['b', 'c', 'd'])
  })

  it('refuses an oversized completion instead of clearing the history for it', async () => {
    // Plan §5.3: a single completion over the per-slot ceiling is simply not
    // retained. Phase 1 has no projection, so the cell's model-visible result is
    // unchanged; what must not happen is the model losing every earlier handle
    // to make room for one value that cannot fit anyway.
    const realm = createRealm({ completionHistory: { maxCompletionHistoryEntryBytes: 128 } })
    await realm.run({ program: '({ small: true })', bindings: [] })
    const before = await history(realm)
    expect(before).toHaveLength(1)

    const oversized = await realm.run({ program: '"y".repeat(400)', bindings: [] })
    expect(oversized.error).toBeUndefined()
    expect((oversized.value as string).length).toBe(400)
    expect(await history(realm)).toEqual(before)
    // The last-result handle is unchanged too: nothing was retained to move it.
    expect((await realm.run({ program: '$_', bindings: [] })).value).toEqual({ small: true })
  })

  it('refuses a shared subgraph whose expansion the walk counted, without abandoning the walk', async () => {
    // Benchmark §3.8: `seen` is a PATH set, so a DAG whose live graph is a few
    // KiB expands into millions of nodes at the boundary. The node budget is
    // judged while the walk runs — but Phase 1 does NOT stop walking when it
    // trips, because the full serialization is still this phase's wire contract.
    //
    // This case guards two invariants stated on `CaptureStats.overNodeLimit`.
    // The completion still crossing intact is what would break if the walk ever
    // gained an early exit: this value's JSON fits the output cap easily, so
    // bailing out would turn a successful cell into `invalid-output`. The
    // history refusing it while the EARLIER entry survives is what would break
    // if the budget were judged after the walk, or if refusal were reached by
    // evicting first — both would spend the model's existing handles on a value
    // that was never going to be retained.
    const realm = createRealm({ completionHistory: { maxCompletionHistoryNodes: 200 } })
    await realm.run({ program: '({ modest: true })', bindings: [] })
    const before = await history(realm)

    const dag = await realm.run({
      program: `
        let shared: unknown = { v: 1 }
        for (let level = 0; level < 8; level++) shared = { a: shared, b: shared }
        shared
      `,
      bindings: [],
    })
    // Nine live objects, 767 nodes once expanded: the completion still crosses,
    // but the history refuses it.
    expect(dag.error).toBeUndefined()
    expect(await history(realm)).toEqual(before)
  })

  it('refuses a value too large for the whole history without evicting for it', async () => {
    // The eviction loop must never run for a value that cannot fit an EMPTY
    // store: emptying the history would trade every handle the model still holds
    // for a value that still would not be retained. The per-slot ceiling alone
    // does not catch this — here the value clears it and fails the total.
    const realm = createRealm({
      completionHistory: { maxCompletionHistoryEntryBytes: 4_096, maxCompletionHistoryEstimatedBytes: 256 },
    })
    await realm.run({ program: '({ small: true })', bindings: [] })
    const before = await history(realm)
    expect(before).toHaveLength(1)

    const tooBig = await realm.run({ program: '"y".repeat(1000)', bindings: [] })
    expect(tooBig.error).toBeUndefined()
    expect(await history(realm)).toEqual(before)

    // Same shape for the node budget: over the total, under the per-slot rule.
    const nodeBound = createRealm({ completionHistory: { maxCompletionHistoryNodes: 4 } })
    await nodeBound.run({ program: '[1, 2]', bindings: [] })
    const nodeBefore = await history(nodeBound)
    expect(nodeBefore).toHaveLength(1)
    expect((await nodeBound.run({ program: '[1, 2, 3, 4, 5]', bindings: [] })).error).toBeUndefined()
    expect(await history(nodeBound)).toEqual(nodeBefore)
  })

  it('publishes the key COUNT but never the keys themselves', async () => {
    // REWRITTEN BY PHASE 4 (plan §9 Phase 2, §7.4): the count is one small
    // integer whatever the value's shape, and it answers the question a model
    // actually asks of a handle — how big is this. The NAMES stay out, and that
    // is the part this test exists to hold: the boundary admits a
    // 20,000-character key, so sixteen of them in a row would be a
    // quarter-megabyte answer to a metadata query.
    const realm = createRealm()
    await realm.run({
      program: 'const wide = {}\nfor (let i = 0; i < 40; i++) wide["k".repeat(500) + i] = i\nwide',
      bindings: [],
    })
    const rows = await history(realm)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'keyCount', 'nodes', 'serializedBytesAtCapture', 'type'])
    expect(rows[0]?.keyCount).toBe(40)
    // Bounded regardless of how wide the value was, and of how long its keys are.
    expect(JSON.stringify(rows[0]).length).toBeLessThan(120)
  })

  it('validates every history limit as a positive safe integer', async () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => new PersistentRealm({
        realmId: 'invalid-history',
        budgets: BUDGETS,
        completionHistory: { maxCompletionHistoryEntries: invalid },
      })).toThrow('maxCompletionHistoryEntries must be a positive safe integer')
    }
    // Blank fields take the plan's decided defaults rather than disabling the history.
    const realm = createRealm({ completionHistory: { maxCompletionHistoryNodes: 4_096 } })
    await realm.run({ program: '({ defaulted: true })', bindings: [] })
    expect(await history(realm)).toHaveLength(1)
  })
})

describe('completion history: explicit release', () => {
  it('makes drop and clear idempotent', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ one: 1 })', bindings: [] })
    await realm.run({ program: '({ two: 2 })', bindings: [] })
    const rows = await history(realm)
    const id = rows[0]?.id ?? 0

    expect(await probe(realm, `[$out.drop(${id}), $out.drop(${id}), $out.drop(-1)]`)).toEqual([true, false, false])
    expect(await probe(realm, '[$out.clear(), $out.clear()]')).toEqual([1, 0])

    const afterClear = await realm.run({
      program: `({ entries: $out.list().length, last: typeof $_, gone: ${caught(`$out(${rows[1]?.id ?? 0})`)}.name })`,
      bindings: [],
    })
    expect(afterClear.value).toEqual({ entries: 0, last: 'undefined', gone: 'CompletionExpiredError' })
  })

  it('charges `$out.list()` a slot of its own when it is the final expression', async () => {
    // Reading the history through a completion is not an observation: the list
    // is itself a value, so it enters like any other and moves `$_`. The rule is
    // self-consistent, but it means `$out.list()` as a bare final expression
    // costs a slot — which is why the tests here read through logs, and why the
    // model-facing wording must not present it as a free glance.
    const realm = createRealm()
    await realm.run({ program: '({ produced: true })', bindings: [] })
    const listed = await realm.run({ program: '$out.list()', bindings: [] })
    expect((listed.value as unknown as HistoryRow[])).toHaveLength(1)

    const rows = await history(realm)
    expect(rows.map(row => row.type)).toEqual(['object', 'array'])
    expect(await probe(realm, '$_')).toEqual([{
      id: rows[0]?.id,
      type: 'object',
      serializedBytesAtCapture: rows[0]?.serializedBytesAtCapture,
      nodes: rows[0]?.nodes,
      keyCount: rows[0]?.keyCount,
    }])
  })

  it('refuses a handle that is not an integer', async () => {
    const realm = createRealm()
    const refused = await realm.run({ program: caught('$out("1")'), bindings: [] })
    expect(refused.value).toMatchObject({ threw: true, name: 'Error' })
    expect((refused.value as unknown as CaughtRejection).message).toContain('integer completion handle')
  })
})

describe('completion history: generation fencing', () => {
  it('expires every handle a hard kill destroyed and never reissues its id', async () => {
    // Plan §4.1 and acceptance #11: after a restart an old handle must be
    // ABSENT, never a hit on some other value. Host-side allocation is what
    // guarantees it — the counter outlives the worker.
    const realm = createRealm({ budgets: { maxWallMs: 400 } })
    await realm.run({ program: '({ beforeKill: true })', bindings: [] })
    const before = await history(realm)
    const oldId = before[0]?.id ?? 0

    expect((await realm.run({ program: 'for (;;) {}', bindings: [] })).error?.kind).toBe('timeout')
    expect(realm.generation).toBe(2)

    const survivors = await realm.run({
      program: `({ entries: $out.list().length, stale: ${caught(`$out(${oldId})`)}.name })`,
      bindings: [],
    })
    expect(survivors.value).toEqual({ entries: 0, stale: 'CompletionExpiredError' })

    await realm.run({ program: '({ afterKill: true })', bindings: [] })
    const after = await history(realm)
    // The new generation does not restart the sequence, so the handle the model
    // was holding cannot name the value that took its place.
    expect(after[0]?.id).toBeGreaterThan(oldId)
  })

  it('spends a candidate handle only when the completion opens a new slot', async () => {
    // The host reserves one handle per DISPATCHED run and the worker consumes it
    // only to open a slot, so an identity hit leaves its run's handle unspent.
    // The sequence therefore has gaps while staying strictly increasing — which
    // is the property that matters, since a reissued number is what would let an
    // old handle name somebody else's value.
    const realm = createRealm()
    await realm.run({ program: 'const held = { tag: "held" }\nheld', bindings: [] })
    await realm.run({ program: 'held', bindings: [] })
    await realm.run({ program: '({ fresh: true })', bindings: [] })

    const rows = await history(realm)
    // Two slots, not three: the middle run reused the first one.
    expect(rows).toHaveLength(2)
    // Exactly one run sat between the two retained completions, and the handle
    // it reserved was never spent.
    expect((rows[1]?.id ?? 0) - (rows[0]?.id ?? 0)).toBe(2)
    expect(await probe(realm, `$out(${rows[0]?.id ?? 0})`)).toEqual({ tag: 'held' })
  })

  it('never reissues a handle the model saw in a run that was then hard-killed', async () => {
    // The scenario that rules out reporting the worker's counter back on `done`:
    // logs reach the host as they are written, so the model can see a handle in
    // a run that never settles normally. Allocating at dispatch means the
    // counter has already moved on by the time the worker dies.
    const realm = createRealm({ budgets: { maxWallMs: 400 } })
    await realm.run({ program: '({ beforeKill: true })', bindings: [] })
    const [row] = await history(realm)
    const seen = row?.id ?? 0

    const killed = await realm.run({
      program: 'console.log("handle=" + $out.list()[0].id)\nfor (;;) {}',
      bindings: [],
    })
    expect(killed.error?.kind).toBe('timeout')
    // The model was told the handle even though the run producing it was killed.
    expect(killed.logs).toEqual([`handle=${seen}`])
    expect(realm.generation).toBe(2)

    await realm.run({ program: '({ afterKill: true })', bindings: [] })
    const rows = await history(realm)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBeGreaterThan(seen)
    const stale = await realm.run({ program: caught(`$out(${seen})`), bindings: [] })
    expect(stale.value).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
  })

  it('opens no slot when the walk runs out of stack', async () => {
    // Phase 0 §3.8 put the recursion ceiling around 7,800 frames and found it
    // moves with stack state, so only the BEHAVIOUR is asserted: the RangeError
    // becomes the ordinary invalid-output diagnostic, the realm keeps its heap,
    // and nothing reaches the history.
    const realm = createRealm()
    await realm.run({ program: '({ retained: true })', bindings: [] })
    const before = await history(realm)

    const tooDeep = await realm.run({
      program: 'let deep: unknown = { leaf: true }\nfor (let i = 0; i < 60000; i++) deep = { next: deep }\ndeep',
      bindings: [],
    })
    expect(tooDeep.error).toEqual(INVALID_COMPLETION)
    expect(realm.generation).toBe(1)
    expect(await history(realm)).toEqual(before)
  })

  it('opens no slot when the worker dies mid-run', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ beforeExit: true })', bindings: [] })
    const [row] = await history(realm)

    const exited = await realm.run({ program: 'process.exit(3)\n"unreachable"', bindings: [] })
    expect(exited.error?.kind).toBe('worker-exit')
    expect(realm.generation).toBe(2)

    const survivors = await realm.run({
      program: `({ entries: $out.list().length, stale: ${caught(`$out(${row?.id ?? 0})`)}.name })`,
      bindings: [],
    })
    expect(survivors.value).toEqual({ entries: 0, stale: 'CompletionExpiredError' })
  })

  it('opens no slot when an active run is aborted', async () => {
    const realm = createRealm()
    const gate = deferred<CodeJsonValue>()
    // The realm freezes its injected globals on the first admission, so the
    // namespace the aborted run parks on has to be declared from the start.
    const parking = [tools({ park: async () => await gate.promise })]
    await realm.run({ program: '({ beforeAbort: true })', bindings: parking })
    const [row] = await history(realm)

    const controller = new AbortController()
    const aborted = realm.run({
      program: 'await globalThis.tools.park({})\n;({ neverRetained: true })',
      bindings: parking,
      signal: controller.signal,
    })
    // Let the run reach the parked call, so the abort lands on an ACTIVE run and
    // hard-kills the worker rather than cancelling a queued one.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    controller.abort(new Error('caller cancelled'))
    expect((await aborted).error?.kind).toBe('abort')
    gate.resolve({ ok: true })
    expect(realm.generation).toBe(2)

    const survivors = await realm.run({
      program: `({ entries: $out.list().length, stale: ${caught(`$out(${row?.id ?? 0})`)}.name })`,
      bindings: [],
    })
    expect(survivors.value).toEqual({ entries: 0, stale: 'CompletionExpiredError' })
  })

  it('keeps two realms from sharing a handle', async () => {
    const first = createRealm()
    const second = createRealm()
    await first.run({ program: '({ realm: "first" })', bindings: [] })
    await second.run({ program: '({ realm: "second" })', bindings: [] })
    const firstRows = await history(first)
    const secondRows = await history(second)
    expect(firstRows[0]?.id).not.toBe(secondRows[0]?.id)

    const crossed = await second.run({ program: caught(`$out(${firstRows[0]?.id ?? 0})`), bindings: [] })
    expect(crossed.value).toMatchObject({ threw: true, name: 'CompletionExpiredError' })
  })

  it('refuses the history to a continuation that outlived its own run', async () => {
    // Plan §8 and acceptance #13: the history takes the same run fencing a
    // leased binding does, and the binding's own revocation order is unchanged.
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        const detachedTrace = []
        let releaseDetached
        const detachedGate = new Promise(resolve => { releaseDetached = resolve })
        void detachedGate.then(async () => {
          try { detachedTrace.push('read ' + JSON.stringify($out.list())) } catch (error) { detachedTrace.push('list: ' + error.message) }
          try { $out.clear(); detachedTrace.push('cleared') } catch (error) { detachedTrace.push('clear: ' + error.message) }
          try { detachedTrace.push('last ' + String($_)) } catch (error) { detachedTrace.push('last: ' + error.message) }
          try { $_ = 'stolen'; detachedTrace.push('assigned $_') } catch (error) { detachedTrace.push('set $_: ' + error.message) }
          try { $out = 'stolen'; detachedTrace.push('assigned $out') } catch (error) { detachedTrace.push('set $out: ' + error.message) }
          try { await globalThis.tools.echo({ n: 1 }); detachedTrace.push('called') } catch (error) { detachedTrace.push('call: ' + error.message) }
        })
        ;({ armed: true })
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(armed.error).toBeUndefined()
    const [row] = await history(realm)

    const observed = await realm.run({
      program: 'releaseDetached()\nawait new Promise(resolve => setTimeout(resolve, 30))\ndetachedTrace',
      bindings: [tools({ echo: async args => args })],
    })
    // Writes are fenced as tightly as reads: a continuation that could retire
    // `$_` would take the intrinsic away from the run that is actually live, and
    // an assignment nobody is running to observe has no legitimate reader.
    expect(observed.value).toEqual([
      expect.stringContaining('list: $out is only reachable'),
      expect.stringContaining('clear: $out is only reachable'),
      expect.stringContaining('last: $_ is only reachable'),
      expect.stringContaining('set $_: $_ is only reachable'),
      expect.stringContaining('set $out: $out is only reachable'),
      expect.stringContaining('call: tool lease revoked'),
    ])
    // The detached `clear()` was refused, so the history the live run owns is intact.
    expect((await realm.run({ program: `$out(${row?.id ?? 0})`, bindings: [] })).value).toEqual({ armed: true })
    // And the refused assignments left both names as accessors rather than as
    // the data properties an accepted assignment would have made of them.
    expect(await probe(
      realm,
      '["$out", "$_"].map(name => typeof Object.getOwnPropertyDescriptor(globalThis, name).get)',
    )).toEqual(['function', 'function'])
  })

  it('reinstalls an intrinsic a detached continuation deleted', async () => {
    // `delete` is the one act no accessor can refuse, so it is answered at the
    // start of the next run instead. Absence is the test, which is what keeps a
    // name the program deliberately ASSIGNED from being taken back off it.
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        let releaseDeleter
        const deleterGate = new Promise(resolve => { releaseDeleter = resolve })
        void deleterGate.then(() => { delete globalThis.$out; delete globalThis.$_ })
        ;({ armed: true })
      `,
      bindings: [],
    })
    expect(armed.error).toBeUndefined()
    const [row] = await history(realm)

    // The deletion lands mid-run, after this run's own reinstall already ran.
    const during = await realm.run({
      program: 'releaseDeleter()\nawait new Promise(resolve => setTimeout(resolve, 30))\n;[typeof $out, typeof $_]',
      bindings: [],
    })
    expect(during.value).toEqual(['undefined', 'undefined'])

    // The next run gets them back, still pointing at the history that was never lost.
    const after = await realm.run({ program: `[typeof $out, $out(${row?.id ?? 0})]`, bindings: [] })
    expect(after.value).toEqual(['function', { armed: true }])
  })
})

describe('completion history: the intrinsic names', () => {
  it('installs `$out` and `$_` as non-enumerable globals', async () => {
    const realm = createRealm()
    const ambient = await realm.run({
      program: `({
        out: typeof $out,
        last: typeof $_,
        ownOut: Object.hasOwn(globalThis, '$out'),
        ownLast: Object.hasOwn(globalThis, '$_'),
        enumerated: Object.keys(globalThis).filter(name => name === '$out' || name === '$_'),
        methods: [typeof $out.list, typeof $out.drop, typeof $out.clear],
        frozen: Object.isFrozen($out),
      })`,
      bindings: [],
    })
    expect(ambient.value).toEqual({
      out: 'function',
      last: 'undefined',
      ownOut: true,
      ownLast: true,
      enumerated: [],
      methods: ['function', 'function', 'function'],
      frozen: true,
    })
  })

  it('lets a cell declare `const $out`, which shadows the intrinsic from then on', async () => {
    // The property is configurable precisely so this declaration stays legal —
    // a non-configurable global would reject the whole cell with
    // `Identifier has already been declared`.
    const realm = createRealm()
    const declared = await realm.run({ program: 'const $out = { userOwned: true }\n$out', bindings: [] })
    expect(declared.error).toBeUndefined()
    expect(declared.value).toEqual({ userOwned: true })
    // A REPL declaration persists, so the program has taken the name for good.
    expect((await realm.run({ program: '$out.userOwned', bindings: [] })).value).toBe(true)
  })

  it('lets a cell declare `let $out` and shadow it again inside a function', async () => {
    const realm = createRealm()
    const nested = await realm.run({
      program: `
        let $out = 'outer'
        const inner = () => { const $out = 'inner'; return $out }
        ;({ outer: $out, inner: inner() })
      `,
      bindings: [],
    })
    expect(nested.value).toEqual({ outer: 'outer', inner: 'inner' })
  })

  it('hands the name over on assignment and does not take it back', async () => {
    const realm = createRealm()
    const assigned = await realm.run({
      program: '$out = { claimed: true }\n;({ value: $out, own: Object.hasOwn(globalThis, "$out") })',
      bindings: [],
    })
    expect(assigned.error).toBeUndefined()
    expect(assigned.value).toEqual({ value: { claimed: true }, own: true })

    // The name is the program's now. Reviving the accessor over it at the next
    // run would take a live variable away mid-namespace, so the reinstall tests
    // for ABSENCE and finds the data property present.
    const later = await realm.run({ program: '$out', bindings: [] })
    expect(later.value).toEqual({ claimed: true })
  })

  it('reinstalls a deleted intrinsic on the next run rather than only after a restart', async () => {
    const realm = createRealm({ budgets: { maxWallMs: 400 } })
    const deleted = await realm.run({
      program: '({ deleted: delete globalThis.$out, out: typeof $out })',
      bindings: [],
    })
    // Within the run that deleted it, the name stays gone: the reinstall for
    // that run already happened before the cell started.
    expect(deleted.value).toEqual({ deleted: true, out: 'undefined' })

    // No hard kill needed — a stray `delete` costs one cell, not the generation.
    expect((await realm.run({ program: 'typeof $out', bindings: [] })).value).toBe('function')

    // And a restart reinstalls it too, from a worker that never saw the delete.
    expect((await realm.run({ program: 'for (;;) {}', bindings: [] })).error?.kind).toBe('timeout')
    expect((await realm.run({ program: 'typeof $out', bindings: [] })).value).toBe('function')
  })

  it('disables `$_` once the program assigns it, and says so exactly once', async () => {
    // Node's REPL rule for `_`, applied to `$_`: an explicit assignment turns the
    // name into an ordinary variable and the runtime stops tracking it there.
    const realm = createRealm()
    await realm.run({ program: '({ tracked: true })', bindings: [] })
    const [row] = await history(realm)

    const claimed = await realm.run({ program: '$_ = "mine"\n$_', bindings: [] })
    expect(claimed.value).toBe('mine')
    expect(claimed.logs).toEqual([expect.stringContaining('$_ is now a program variable')])

    const again = await realm.run({ program: '$_ = "mine again"\n$_', bindings: [] })
    expect(again.value).toBe('mine again')
    // The accessor is gone, so there is no second notice to emit.
    expect(again.logs).toEqual([])

    // Only `$_` is affected; handles keep working.
    expect((await realm.run({ program: `$out(${row?.id ?? 0})`, bindings: [] })).value).toEqual({ tracked: true })
  })

  it('leaves `_` to the program, lodash style and all', async () => {
    // Plan §4.1: `_` is deliberately NOT claimed — its strongest prior in JS is
    // lodash, and it is the most common throwaway name there is.
    const realm = createRealm()
    const lodashish = await realm.run({
      program: `
        const _ = { chunk: (items, size) => items.reduce((out, item, index) => {
          if (index % size === 0) out.push([])
          out[out.length - 1].push(item)
          return out
        }, []) }
        _.chunk([1, 2, 3, 4, 5], 2)
      `,
      bindings: [],
    })
    expect(lodashish.error).toBeUndefined()
    expect(lodashish.value).toEqual([[1, 2], [3, 4], [5]])
    expect((await realm.run({ program: 'Object.hasOwn(globalThis, "_")', bindings: [] })).value).toBe(false)
  })
})

describe('completion history: the expiry class', () => {
  it('exposes CompletionExpiredError as an immutable global carrying a recovery instruction', async () => {
    const realm = createRealm()
    const shape = await realm.run({
      program: `
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompletionExpiredError')
        let caughtError: unknown
        try { $out(123456789) } catch (error) { caughtError = error }
        ;({
          writable: descriptor.writable,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          isInstance: caughtError instanceof CompletionExpiredError,
          isError: caughtError instanceof Error,
          name: caughtError.name,
          message: caughtError.message,
        })
      `,
      bindings: [],
    })
    expect(shape.value).toEqual({
      writable: false,
      configurable: false,
      enumerable: false,
      isInstance: true,
      isError: true,
      name: 'CompletionExpiredError',
      message: 'result 123456789 was evicted; recompute it',
    })
  })

  it('refuses the reserved class name on both injection paths', async () => {
    // The worker installs the class immutably before any cell runs, so either
    // route to a program global — a namespace global or an injected error class
    // — would leave the worker unable to install its own intrinsic and cost the
    // realm its generation. Both are refused as caller misuse instead.
    const realm = createRealm()
    await expect(realm.run({
      program: '1',
      bindings: [{ global: 'CompletionExpiredError', functions: {} }],
    })).rejects.toThrow('reserved binding global "CompletionExpiredError"')

    await expect(realm.run({
      program: '1',
      bindings: [{
        global: 'tools',
        functions: {},
        errorClass: { name: 'CompletionExpiredError', memberNameProperty: 'toolName' },
      }],
    })).rejects.toThrow('reserved binding global "CompletionExpiredError"')

    // `$out` and `$_` are reserved by NAME, ahead of the identifier test. Neither
    // could pass that test anyway, but the guarantee must not rest on a regex
    // that exists for an unrelated reason and could be relaxed later.
    for (const intrinsic of ['$out', '$_']) {
      await expect(realm.run({ program: '1', bindings: [{ global: intrinsic, functions: {} }] }))
        .rejects.toThrow(`reserved binding global ${JSON.stringify(intrinsic)}`)
      await expect(realm.run({
        program: '1',
        bindings: [{ global: 'tools', functions: {}, errorClass: { name: intrinsic, memberNameProperty: 'toolName' } }],
      })).rejects.toThrow(`reserved binding global ${JSON.stringify(intrinsic)}`)
    }

    // Neither refusal reached a worker, and an ordinary error class on the same
    // path is unaffected — the reservation is one name, not a new class of them.
    const accepted = await realm.run({
      program: '({ ok: true })',
      bindings: [{
        global: 'tools',
        functions: {},
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      }],
    })
    expect(accepted.error).toBeUndefined()
    expect(accepted.value).toEqual({ ok: true })
    expect(realm.generation).toBe(1)
  })
})

describe('completion history: the deployment path', () => {
  it('carries the plugin config through to the realm that enforces it', async () => {
    // The limits travel plugin config -> PrimeCodeRuntime -> PersistentRealm ->
    // the run message. Constructing a realm directly, as every test above does,
    // would not prove any of that wiring.
    const ctx = await startHost({ maxCompletionHistoryEntries: 1 })
    const bindings = primeFor('session-history-config')

    const first = await ctx.codeRuntime.run({ program: '({ first: true })', bindings })
    expect(first.error).toBeUndefined()
    await ctx.codeRuntime.run({ program: '({ second: true })', bindings })

    const observed = await ctx.codeRuntime.run({
      program: 'console.log(JSON.stringify($out.list().map(entry => entry.type)))',
      bindings,
    })
    expect(observed.error).toBeUndefined()
    // One entry of budget, so the second completion evicted the first.
    expect(observed.logs[0]).toBe('["object"]')
    expect((await ctx.codeRuntime.run({ program: '$_', bindings })).value).toEqual({ second: true })
  })

  it('releases the history when an idle realm is reclaimed, and says nothing extra about it', async () => {
    // Reclamation destroys the worker, so the history goes with it — but unlike
    // a hard kill this is not a namespace LOSS the model should be warned about:
    // the session simply starts a fresh namespace, and the run that inherits it
    // gets the ordinary "started empty" line. The decision (plan §5.3) is that
    // the fresh path says nothing about retained results; a model still holding
    // a handle learns it from `CompletionExpiredError`, whose message carries the
    // recovery instruction. Warning on every fresh namespace would spend tokens
    // on every session start to pre-empt a case the error already handles.
    const ctx = await startHost({ maxIdleMs: 150 })
    const bindings = primeFor('session-reclaimed')

    await ctx.codeRuntime.run({ program: '({ beforeReclaim: true })', bindings })
    const listed = await ctx.codeRuntime.run({
      program: 'console.log(JSON.stringify($out.list()[0].id))',
      bindings,
    })
    const handle = JSON.parse(listed.logs[0] as string) as number

    await new Promise((resolve) => { setTimeout(resolve, 700) })

    const after = await ctx.codeRuntime.run({
      program: `({ entries: $out.list().length, stale: ${caught(`$out(${handle})`)}.name })`,
      bindings,
    })
    expect(after.value).toEqual({ entries: 0, stale: 'CompletionExpiredError' })
    expect(after.logs.filter(line => line.startsWith('[prime-realm] ')))
      .toEqual(['[prime-realm] live namespace started empty'])
  })

  it('leaves the ordinary one-shot runtime without a completion history', async () => {
    // Plan §7.3 and §12: the history exists only on the authenticated Prime
    // path. A request with no handshake binding is delegated to the official
    // runtime verbatim, which knows nothing about any of this.
    const ctx = await startHost()
    const oneShot = await ctx.codeRuntime.run({
      program: 'return [typeof $out, typeof $_, typeof CompletionExpiredError]',
      bindings: [],
    })
    expect(oneShot.error).toBeUndefined()
    expect(oneShot.value).toEqual(['undefined', 'undefined', 'undefined'])

    // The same deployment still installs them for a Prime session.
    const prime = await ctx.codeRuntime.run({
      program: '[typeof $out, typeof $_, typeof CompletionExpiredError]',
      bindings: primeFor('session-oneshot-control'),
    })
    expect(prime.value).toEqual(['function', 'undefined', 'function'])
  })
})
