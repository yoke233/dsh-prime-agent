/** Single-slot retention for NON-JSON live completions. */

import { afterEach, describe, expect, it } from 'vitest'
import type { CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets, RealmCompletionRetentionLimits } from '../src/realm/realm.js'

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
  completionRetention?: Partial<RealmCompletionRetentionLimits>
} = {}): PersistentRealm {
  const realm = new PersistentRealm({
    realmId: `realm-${realms.length}`,
    budgets: { ...BUDGETS, ...options.budgets },
    ...options.completionRetention ? { completionRetention: options.completionRetention } : {},
  })
  realms.push(realm)
  return realm
}

interface OpaqueEnvelope {
  retained: boolean
  type: string
  opaque: true
  reason?: string
  truncated: true
}

function envelopeOf(result: CodeRunResult): OpaqueEnvelope {
  expect(result.error).toBeUndefined()
  const value = result.value as OpaqueEnvelope
  expect(value?.truncated).toBe(true)
  return value
}

describe('opaque latest completion', () => {
  it('retains common non-JSON values behind one fixed envelope', async () => {
    const realm = createRealm()

    const map = await realm.run({ program: 'new Map([["answer", 42]])', bindings: [] })
    expect(envelopeOf(map)).toEqual({ retained: true, type: 'object', opaque: true, truncated: true })
    expect(map.presentation).toEqual({ kind: 'opaque-reference', valueType: 'object' })
    expect((await realm.run({ program: '$_.get("answer")', bindings: [] })).value).toBe(42)

    const set = await realm.run({ program: 'new Set([1, 2, 3])', bindings: [] })
    expect(envelopeOf(set)).toMatchObject({ retained: true, type: 'object', opaque: true })
    expect((await realm.run({ program: '$_.has(2)', bindings: [] })).value).toBe(true)

    const fn = await realm.run({ program: 'const add = (a: number, b: number) => a + b\nadd', bindings: [] })
    expect(envelopeOf(fn)).toMatchObject({ retained: true, type: 'function', opaque: true })
    expect((await realm.run({ program: '$_(2, 3)', bindings: [] })).value).toBe(5)

    const bigint = await realm.run({ program: '10n', bindings: [] })
    expect(envelopeOf(bigint)).toMatchObject({ retained: true, type: 'bigint', opaque: true })
    expect((await realm.run({ program: '$_ + 1n === 11n', bindings: [] })).value).toBe(true)

    const instance = await realm.run({
      program: 'class Row { id = 1 }\nnew Row()',
      bindings: [],
    })
    expect(envelopeOf(instance)).toMatchObject({ retained: true, type: 'object', opaque: true })
    expect((await realm.run({ program: '$_ instanceof Row', bindings: [] })).value).toBe(true)

    const date = await realm.run({ program: 'new Date(0)', bindings: [] })
    expect(envelopeOf(date)).toMatchObject({ retained: true, type: 'object', opaque: true })
    expect((await realm.run({ program: '$_.getTime()', bindings: [] })).value).toBe(0)
    expect(realm.generation).toBe(1)
  })

  it('returns the exact opaque identity and keeps live mutation visible', async () => {
    const realm = createRealm()
    const produced = await realm.run({
      program: 'const live = new Map([["k", "v"]])\nlive',
      bindings: [],
    })
    expect(envelopeOf(produced)).toMatchObject({ retained: true, opaque: true })

    const observed = await realm.run({
      program: 'console.log(JSON.stringify({ same: $_ === live, isMap: $_ instanceof Map }))\n$_.set("more", 1)\nconsole.log(live.size)',
      bindings: [],
    })
    expect(observed.value).toBeUndefined()
    expect(observed.logs).toEqual(['{"same":true,"isMap":true}', '2'])

    const recirculated = await realm.run({ program: 'live', bindings: [] })
    expect(envelopeOf(recirculated)).toMatchObject({ retained: true, opaque: true })
    const sameAgain = await realm.run({ program: 'console.log($_ === live)', bindings: [] })
    expect(sameAgain.logs).toEqual(['true'])
  })

  it('keeps an opaque completion across an undefined-producing save cell', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const liveSet = new Set([1])\nliveSet', bindings: [] })
    expect((await realm.run({ program: 'let saved = $_', bindings: [] })).value).toBeUndefined()
    const observed = await realm.run({ program: 'console.log(saved === $_, $_ instanceof Set)', bindings: [] })
    expect(observed.logs).toEqual(['true true'])
  })

  it('replaces an opaque value with the next retained JSON value', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const oldMap = new Map([["old", true]])\noldMap', bindings: [] })
    await realm.run({ program: '({ replacement: true })', bindings: [] })
    const observed = await realm.run({ program: 'console.log($_ === oldMap, $_.replacement)', bindings: [] })
    expect(observed.logs).toEqual(['false true'])
  })

  it('clears the previous slot when the opaque admission budget rejects the latest value', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionOpaqueBytes: 4 },
    })
    await realm.run({ program: '({ before: true })', bindings: [] })

    const refused = await realm.run({ program: '({ fn: () => 1 })', bindings: [] })
    expect(envelopeOf(refused)).toEqual({
      retained: false,
      type: 'object',
      opaque: true,
      reason: 'opaque retention budget exceeded',
      truncated: true,
    })
    expect(refused.presentation).toEqual({
      kind: 'unretained-preview',
      valueType: 'object',
      reason: 'opaque retention budget exceeded',
    })
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })

  it('applies the opaque node budget independently', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionOpaqueNodes: 1 },
    })
    const refused = await realm.run({ program: '({ fn: () => 1 })', bindings: [] })
    expect(envelopeOf(refused)).toMatchObject({ retained: false, opaque: true })
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })
})

describe('opaque classification safety', () => {
  it('does not consult toJSON or toString hooks to render an opaque completion', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        globalThis.hookTouches = { toJSON: 0, toString: 0 }
        const guarded = {}
        Object.defineProperty(guarded, 'toJSON', { enumerable: false, get() { hookTouches.toJSON += 1; return 1 } })
        Object.defineProperty(guarded, 'toString', { enumerable: false, get() { hookTouches.toString += 1; return 'x' } })
        guarded
      `,
      bindings: [],
    })
    expect(envelopeOf(result)).toMatchObject({ retained: true, opaque: true })
    expect(JSON.stringify(result.value)).not.toContain('toJSON')
    expect((await realm.run({ program: 'hookTouches', bindings: [] })).value).toEqual({ toJSON: 0, toString: 0 })
  })

  it('keeps throwing getters and hostile proxies out of the canonical result', async () => {
    const getterRealm = createRealm()
    const getter = await getterRealm.run({
      program: `
        const trap = {}
        Object.defineProperty(trap, 'boom', { enumerable: true, get() { throw new Error('getter exploded') } })
        trap
      `,
      bindings: [],
    })
    expect(envelopeOf(getter)).toMatchObject({ retained: true, opaque: true })
    expect(JSON.stringify(getter.value)).not.toContain('getter exploded')

    const proxyRealm = createRealm()
    const proxy = await proxyRealm.run({
      program: 'const trapped = new Proxy({}, { getPrototypeOf() { throw new Error("proto trap boom") } })\ntrapped',
      bindings: [],
    })
    expect(envelopeOf(proxy)).toMatchObject({ retained: true, type: 'object', opaque: true })
    expect(JSON.stringify(proxy.value)).not.toContain('proto trap boom')
  })

  it('retains a revoked proxy without probing its contents', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: 'const { proxy, revoke } = Proxy.revocable({}, {})\nrevoke()\nproxy',
      bindings: [],
    })
    expect(envelopeOf(result)).toMatchObject({ retained: true, type: 'object', opaque: true })
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('object')
  })
})

describe('opaque wire and generation boundaries', () => {
  it('fits the typed minimal envelope at its exact wire boundary', async () => {
    const maxOutputBytes = 256
    const realm = createRealm({ budgets: { maxOutputBytes } })
    await realm.run({ program: 'const held = new Map([["a", 1]])\nheld', bindings: [] })
    const expected: OpaqueEnvelope = { retained: true, type: 'object', opaque: true, truncated: true }
    const minimalBytes = Buffer.byteLength(JSON.stringify(expected), 'utf8')
    const logLength = maxOutputBytes - 2 - 2 - minimalBytes

    const atBoundary = await realm.run({
      program: `console.log("x".repeat(${String(logLength)}))\nheld`,
      bindings: [],
    })
    expect(atBoundary.error).toBeUndefined()
    expect(atBoundary.value).toEqual(expected)
    expect(atBoundary.presentation).toEqual({ kind: 'opaque-reference', valueType: 'object' })
  })

  it('reports output-limit below the minimal boundary without killing the realm', async () => {
    const maxOutputBytes = 256
    const realm = createRealm({ budgets: { maxOutputBytes } })
    await realm.run({ program: 'const held = new Map([["a", 1]])\nheld', bindings: [] })
    const minimalBytes = Buffer.byteLength(JSON.stringify({ retained: true, type: 'object', opaque: true, truncated: true }), 'utf8')
    const logLength = maxOutputBytes - 2 - 2 - minimalBytes + 1

    const below = await realm.run({
      program: `console.log("x".repeat(${String(logLength)}))\nheld`,
      bindings: [],
    })
    expect(below.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 256 bytes' })
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: '$_.get("a")', bindings: [] })).value).toBe(1)
  })

  it('loses the opaque slot after a hard kill', async () => {
    const realm = createRealm({ budgets: { maxWallMs: 400 } })
    await realm.run({ program: 'new Map([["before", 1]])', bindings: [] })
    expect((await realm.run({ program: 'for (;;) {}', bindings: [] })).error?.kind).toBe('timeout')
    expect(realm.generation).toBe(2)
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })
})
