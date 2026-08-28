/** Single-slot completion retention and lifecycle coverage. */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets, RealmCompletionRetentionLimits } from '../src/realm/realm.js'
import * as primeRuntime from '../src/runtime.js'

const BUDGETS: RealmBudgets = {
  computeMs: 5_000,
  maxWallMs: 10_000,
  maxOutputBytes: 65_536,
  maxOldGenerationSizeMb: 128,
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

async function probe(realm: PersistentRealm, expression: string): Promise<unknown> {
  const result = await realm.run({ program: `console.log(JSON.stringify(${expression}))`, bindings: [] })
  expect(result.error).toBeUndefined()
  return JSON.parse(result.logs[0] as string) as unknown
}

function realmId(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url')
}

async function startHost(config: Record<string, unknown> = {}): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prime-retention-'))
  const context = new Context()
  contexts.push(context)
  await context.plugin(primeRuntime, { stateDirectory: join(root, 'state'), ...config })
  return context
}

describe('latest completion slot', () => {
  it('starts empty and leaves the slot empty after an undefined completion', async () => {
    const realm = createRealm()
    const initial = await realm.run({ program: 'console.log(typeof $_)', bindings: [] })
    expect(initial.logs).toEqual(['undefined'])
    expect(initial.value).toBeUndefined()

    const statement = await realm.run({ program: 'const sideEffect = 1', bindings: [] })
    expect(statement.value).toBeUndefined()
    const after = await realm.run({ program: 'console.log(typeof $_)', bindings: [] })
    expect(after.logs).toEqual(['undefined'])
    expect(after.value).toBeUndefined()
  })

  it('returns the latest retained completion through `$_`', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ first: true })', bindings: [] })
    expect((await realm.run({ program: '$_', bindings: [] })).value).toEqual({ first: true })
  })

  it('does not overwrite the slot when a model saves `$_` in a named variable', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const original = { token: "kept" }\noriginal', bindings: [] })

    const saved = await realm.run({ program: 'let saved = $_', bindings: [] })
    expect(saved.value).toBeUndefined()
    expect(await probe(realm, 'saved === $_')).toBe(true)

    await realm.run({ program: '({ replacement: true })', bindings: [] })
    expect(await probe(realm, 'saved === $_')).toBe(false)
    expect(await probe(realm, 'saved.token')).toBe('kept')
  })

  it('lets other undefined-producing cells inspect without replacing the slot', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ answer: 42 })', bindings: [] })

    const logged = await realm.run({ program: 'console.log($_.answer)', bindings: [] })
    expect(logged.value).toBeUndefined()
    expect(logged.logs).toEqual(['42'])
    expect((await realm.run({ program: '$_.answer', bindings: [] })).value).toBe(42)
  })

  it('replaces the slot for every later retained value', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ sequence: 1 })', bindings: [] })
    await realm.run({ program: '({ sequence: 2 })', bindings: [] })
    expect((await realm.run({ program: '$_.sequence', bindings: [] })).value).toBe(2)
  })

  it('preserves exact identity when the same JSON object is completed again', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const held = { nested: { value: 1 } }\nheld', bindings: [] })
    expect(await probe(realm, '$_ === held')).toBe(true)

    await realm.run({ program: 'held', bindings: [] })
    expect(await probe(realm, '$_ === held')).toBe(true)
  })

  it('leaves the retained value intact after a failed cell', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ beforeFailure: true })', bindings: [] })
    expect((await realm.run({ program: 'throw new Error("boom")', bindings: [] })).error?.kind).toBe('exception')
    expect((await realm.run({ program: '$_.beforeFailure', bindings: [] })).value).toBe(true)
  })

  it('clears the former slot when a non-undefined completion exceeds retention', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionRetainedBytes: 32 },
    })
    await realm.run({ program: '({ small: true })', bindings: [] })

    const refused = await realm.run({ program: '"x".repeat(256)', bindings: [] })
    expect(refused.value).toBe('x'.repeat(256))
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })

  it('marks an oversized projected value unretained without a recovery handle', async () => {
    const realm = createRealm({
      completionRetention: { maxCompletionRetainedBytes: 64 },
      budgets: { maxOutputBytes: 2_048 },
    })
    const result = await realm.run({ program: '"x".repeat(4_096)', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: false, type: 'string', truncated: true })
    expect(result.value).not.toHaveProperty('use')
    expect(result.presentation).toMatchObject({ kind: 'unretained-preview', valueType: 'string' })
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })

  it('keeps independent realms from sharing their latest completion', async () => {
    const first = createRealm()
    const second = createRealm()
    await first.run({ program: '({ realm: "first" })', bindings: [] })
    await second.run({ program: '({ realm: "second" })', bindings: [] })
    expect((await first.run({ program: '$_.realm', bindings: [] })).value).toBe('first')
    expect((await second.run({ program: '$_.realm', bindings: [] })).value).toBe('second')
  })
})

describe('latest completion lifecycle', () => {
  it('loses the slot when a timeout replaces the worker', async () => {
    const realm = createRealm({ budgets: { maxWallMs: 400 } })
    await realm.run({ program: '({ beforeKill: true })', bindings: [] })
    expect((await realm.run({ program: 'for (;;) {}', bindings: [] })).error?.kind).toBe('timeout')
    expect(realm.generation).toBe(2)
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })

  it('loses the slot when the worker exits', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ beforeExit: true })', bindings: [] })
    expect((await realm.run({ program: 'process.exit(3)', bindings: [] })).error?.kind).toBe('worker-exit')
    expect(realm.generation).toBe(2)
    expect((await realm.run({ program: 'typeof $_', bindings: [] })).value).toBe('undefined')
  })

  it('reinstalls `$_` after a program deletes the accessor', async () => {
    const realm = createRealm()
    await realm.run({ program: '({ retained: true })', bindings: [] })
    const deleted = await realm.run({ program: 'delete globalThis.$_\nconsole.log("deleted")', bindings: [] })
    expect(deleted.logs).toEqual(['deleted'])
    expect(deleted.value).toBeUndefined()
    expect((await realm.run({ program: '$_.retained', bindings: [] })).value).toBe(true)
  })

  it('reports namespace and retained-result loss after a hard kill', async () => {
    const context = await startHost({ maxWallMs: 400 })
    const id = realmId('single-slot-loss-notice')
    await context.primeRealmRuntime.run(id, { program: '({ beforeKill: true })', bindings: [] })
    expect((await context.primeRealmRuntime.run(id, { program: 'for (;;) {}', bindings: [] })).error?.kind).toBe('timeout')

    const restarted = await context.primeRealmRuntime.run(id, { program: 'typeof $_', bindings: [] })
    expect(restarted.value).toBe('undefined')
    expect(restarted.logs.filter(line => line.startsWith('[prime-realm] ')))
      .toEqual(['[prime-realm] live namespace restarted; previous bindings and retained results were lost'])
  })
})
