/** Bounded completion previews for the single retained `$_` slot. */

import { afterEach, describe, expect, it } from 'vitest'
import type { CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { PersistentRealm } from '../src/realm/realm.js'
import type {
  RealmBudgets,
  RealmCompletionProjectionLimits,
  RealmCompletionRetentionLimits,
} from '../src/realm/realm.js'
import { MINIMAL_ENVELOPE_BYTES } from '../src/realm/protocol.js'

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
  completionProjection?: Partial<RealmCompletionProjectionLimits>
} = {}): PersistentRealm {
  const realm = new PersistentRealm({
    realmId: `realm-${realms.length}`,
    budgets: { ...BUDGETS, ...options.budgets },
    ...options.completionRetention ? { completionRetention: options.completionRetention } : {},
    ...options.completionProjection ? { completionProjection: options.completionProjection } : {},
  })
  realms.push(realm)
  return realm
}

interface Envelope {
  retained: boolean
  type: string
  serializedBytesAtCapture?: number
  projection?: unknown
  opaque?: true
  reason?: string
  truncated: true
}

function envelopeOf(result: CodeRunResult): Envelope {
  expect(result.error).toBeUndefined()
  const envelope = result.value as Envelope
  expect(envelope?.truncated).toBe(true)
  return envelope
}

function valueBytes(result: CodeRunResult): number {
  return Buffer.byteLength(JSON.stringify(result.value), 'utf8')
}

function wideRows(count: number): string {
  return `Array.from({ length: ${String(count)} }, (_, index) => ({ index, label: "row-" + index }))`
}

it('sizes the minimal envelope constant at the exact worst-case boundary', () => {
  const envelope = { retained: false, type: 'function', opaque: true, truncated: true }
  expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBe(MINIMAL_ENVELOPE_BYTES)
})

describe('completion projection admission', () => {
  it('returns a rich retained preview without a numeric recovery handle', async () => {
    const realm = createRealm({
      completionProjection: { maxCompletionFullBytes: 128 },
    })
    const result = await realm.run({ program: wideRows(200), bindings: [] })
    const envelope = envelopeOf(result)

    expect(envelope).toMatchObject({ retained: true, type: 'array', truncated: true })
    expect(envelope.serializedBytesAtCapture).toBeGreaterThan(128)
    expect(envelope.projection).toBeDefined()
    expect(result.value).not.toHaveProperty('use')
    expect(result.presentation).toEqual({
      kind: 'retained-preview',
      valueType: 'array',
      serializedBytes: envelope.serializedBytesAtCapture,
    })
  })

  it('keeps the complete retained value reachable as `$_`', async () => {
    const realm = createRealm({
      completionProjection: { maxCompletionFullBytes: 128 },
    })
    await realm.run({ program: `globalThis.rows = ${wideRows(400)}\nrows`, bindings: [] })

    const recovered = await realm.run({
      program: 'console.log(JSON.stringify({ same: $_ === rows, length: $_.length, last: $_[399] }))',
      bindings: [],
    })
    expect(JSON.parse(recovered.logs[0] as string)).toEqual({
      same: true,
      length: 400,
      last: { index: 399, label: 'row-399' },
    })
    expect(recovered.value).toBeUndefined()
  })

  it('returns an honest unretained preview when the bounded walk aborts', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionRetainedNodes: 50 },
      completionProjection: { maxCompletionFullBytes: 256 },
    })
    const result = await realm.run({ program: wideRows(200), bindings: [] })
    const envelope = envelopeOf(result)

    expect(envelope).toMatchObject({
      retained: false,
      type: 'array',
      reason: 'too large to capture',
      truncated: true,
    })
    expect(envelope.serializedBytesAtCapture).toBeUndefined()
    expect(result.value).not.toHaveProperty('use')
    expect(result.presentation).toEqual({
      kind: 'unretained-preview',
      valueType: 'array',
      reason: 'too large to capture',
    })
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })

  it('reports an exact measured refusal when serialization exceeds its conservative walk charge', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionRetainedBytes: 100 },
      completionProjection: { maxCompletionFullBytes: 128 },
    })
    const result = await realm.run({
      program: 'Array.from({ length: 20 }, () => 1234567890)',
      bindings: [],
    })
    const envelope = envelopeOf(result)

    expect(envelope).toMatchObject({
      retained: false,
      type: 'array',
      reason: 'too large to retain',
    })
    expect(envelope.serializedBytesAtCapture).toBeGreaterThan(100)
    expect(result.presentation).toEqual({
      kind: 'unretained-preview',
      valueType: 'array',
      serializedBytes: envelope.serializedBytesAtCapture,
      reason: 'too large to retain',
    })
  })

  it('does not let a retention ceiling force a small completion through projection', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionRetainedBytes: 64 },
    })
    const result = await realm.run({ program: '"y".repeat(4_000)', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('y'.repeat(4_000))
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })
})

describe('completion projection degradation', () => {
  it('falls back to a typed retained minimal preview', async () => {
    const realm = createRealm({
      completionProjection: { maxCompletionFullBytes: 8, maxCompletionProjectionBytes: 8 },
    })
    const result = await realm.run({ program: '({ a: 1, b: 2 })', bindings: [] })
    const envelope = envelopeOf(result)

    expect(envelope).toEqual({ retained: true, type: 'object', truncated: true })
    expect(valueBytes(result)).toBeLessThanOrEqual(MINIMAL_ENVELOPE_BYTES)
    expect(result.presentation).toEqual({ kind: 'retained-preview', valueType: 'object' })
    const recovered = await realm.run({ program: 'console.log(JSON.stringify($_))', bindings: [] })
    expect(JSON.parse(recovered.logs[0] as string)).toEqual({ a: 1, b: 2 })
  })

  it('falls back to a typed unretained minimal preview', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionRetainedNodes: 1 },
      completionProjection: { maxCompletionFullBytes: 8, maxCompletionProjectionBytes: 8 },
    })
    const result = await realm.run({ program: '({ a: 1, b: 2, c: 3 })', bindings: [] })
    const envelope = envelopeOf(result)

    expect(envelope).toEqual({ retained: false, type: 'object', truncated: true })
    expect(valueBytes(result)).toBeLessThanOrEqual(MINIMAL_ENVELOPE_BYTES)
    expect(result.presentation).toEqual({ kind: 'unretained-preview', valueType: 'object' })
  })

  it('uses output-limit only when even the minimal preview does not fit', async () => {
    const maxOutputBytes = 256
    const realm = createRealm({
      budgets: { maxOutputBytes },
      completionProjection: { maxCompletionFullBytes: 8, maxCompletionProjectionBytes: 8 },
    })
    const minimal = { retained: true, type: 'object', truncated: true }
    const logLength = maxOutputBytes - 2 - 2 - Buffer.byteLength(JSON.stringify(minimal), 'utf8') + 1
    const result = await realm.run({
      program: `console.log("x".repeat(${String(logLength)}))\n;({ a: 1, b: 2 })`,
      bindings: [],
    })

    expect(result.error).toEqual({ kind: 'output-limit', message: 'outer output exceeded 256 bytes' })
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: '$_.a + $_.b', bindings: [] })).value).toBe(3)
  })
})

describe('completion projection content', () => {
  it('bounds wide arrays while preserving their size and representative leading entries', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const envelope = envelopeOf(await realm.run({ program: wideRows(500), bindings: [] }))
    expect(envelope.type).toBe('array')
    expect(envelope.projection).toMatchObject({ type: 'array', length: 500 })
    expect(JSON.stringify(envelope.projection).length).toBeLessThan(4_096)
    expect(JSON.stringify(envelope.projection)).toContain('row-0')
  })

  it('bounds long strings and records their original length', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const envelope = envelopeOf(await realm.run({ program: '"s".repeat(20_000)', bindings: [] }))
    expect(envelope.type).toBe('string')
    expect(envelope.projection).toMatchObject({ type: 'string', length: 20_000 })
    expect(JSON.stringify(envelope.projection).length).toBeLessThan(1_000)
  })

  it('bounds depth and truncates very long object keys', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const envelope = envelopeOf(await realm.run({
      program: `(() => {
        const root: Record<string, unknown> = {}
        root['k'.repeat(20_000)] = 1
        let cursor = root
        for (let depth = 0; depth < 100; depth++) {
          const next = { depth }
          cursor.next = next
          cursor = next
        }
        return root
      })()`,
      bindings: [],
    }))
    const rendered = JSON.stringify(envelope.projection)
    expect(rendered.length).toBeLessThan(4_096)
    expect(rendered).toContain('"keyLength":20000')
    expect(rendered).toContain('depth')
  })

  it('produces byte-identical previews for the same JSON shape', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 64 } })
    const program = wideRows(200)
    const first = envelopeOf(await realm.run({ program, bindings: [] }))
    const second = envelopeOf(await realm.run({ program, bindings: [] }))
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })
})

describe('projection authenticity', () => {
  it('treats a program-authored envelope-shaped object as ordinary JSON', async () => {
    const realm = createRealm()
    const forged = { retained: true, type: 'object', truncated: true }
    const result = await realm.run({ program: `(${JSON.stringify(forged)})`, bindings: [] })

    expect(result.value).toEqual(forged)
    expect(result.presentation).toBeUndefined()
    const observed = await realm.run({ program: 'console.log(JSON.stringify($_))', bindings: [] })
    expect(JSON.parse(observed.logs[0] as string)).toEqual(forged)
  })

  it('preserves official tool presentation text without mistaking it for program data', async () => {
    const realm = createRealm({ completionProjection: { maxCompletionFullBytes: 32 } })
    const result = await realm.run({
      program: '({ value: "x".repeat(2_000), presentation: "official tool presentation" })',
      bindings: [],
    })
    expect(envelopeOf(result).retained).toBe(true)
    expect(result.presentation).toMatchObject({ kind: 'retained-preview', valueType: 'object' })
  })
})
