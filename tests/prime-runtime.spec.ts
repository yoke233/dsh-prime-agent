import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CodeBindingErrorClass, CodeBindingFunction, CodeBindingNamespace, CodeJsonValue, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import * as primeRuntime from '../src/runtime.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- test bindings receive already-validated JSON */
type Binding = (args: any) => Promise<CodeJsonValue>

const RETENTION_CONFIG_FIELDS = [
  'maxCompletionRetainedBytes',
  'maxCompletionRetainedNodes',
  'maxCompletionOpaqueBytes',
  'maxCompletionOpaqueNodes',
] as const

const CONFIG_FIELDS = [
  'stateDirectory',
  'computeMs',
  'maxWallMs',
  'maxOutputBytes',
  'maxOldGenerationSizeMb',
  'maxActiveRealms',
  'maxIdleMs',
  'maxHostCallsPerRun',
  'maxParallelHostCallsPerRun',
  ...RETENTION_CONFIG_FIELDS,
  'maxCompletionFullBytes',
  'maxCompletionProjectionBytes',
] as const

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  // Reverse creation order so cross-host ownership tests unwind deterministically.
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function stateDirectory(): string {
  if (root === undefined) throw new Error('test root was not created')
  return join(root, 'state')
}

/** Boot a real host row: trusted realm service, cross-process leases, real workers. */
async function startHost(config: Record<string, unknown> = {}): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(primeRuntime, { stateDirectory: stateDirectory(), ...config })
  return context
}

/**
 * Deterministic 43-char unpadded base64url Realm identity for one test seed,
 * the exact shape the identity store issues and the lease accepts.
 */
function realmId(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url')
}

/** One `tools` namespace, optionally with a frozen error-class descriptor. */
function toolsBindings(functions: Record<string, Binding>, errorClass?: CodeBindingErrorClass): CodeBindingNamespace[] {
  return [errorClass === undefined
    ? { global: 'tools', functions: functions as Record<string, CodeBindingFunction> }
    : { global: 'tools', functions: functions as Record<string, CodeBindingFunction>, errorClass }]
}

function bindingNamespace(global: string, functions: Record<string, Binding>): CodeBindingNamespace {
  return { global, functions: functions as Record<string, CodeBindingFunction> }
}

/** The runtime's own namespace notices, separate from program output. */
function notices(result: CodeRunResult): string[] {
  return result.logs.filter(line => line.startsWith('[prime-realm] '))
}

/** The single namespace notice, or `undefined` when this run needs no notice. */
function notice(result: CodeRunResult): string | undefined {
  const lines = notices(result)
  return lines.length === 1 ? lines[0] : undefined
}

function expectFreshNamespaceNotice(result: CodeRunResult): void {
  expect(notices(result)).toHaveLength(1)
  expect(notice(result)).toContain('namespace')
  expect(notice(result)).toContain('empty')
  expect(notice(result)).not.toContain('lost')
}

function expectLostNamespaceNotice(result: CodeRunResult): void {
  expect(notices(result)).toHaveLength(1)
  expect(notice(result)).toContain('namespace')
  expect(notice(result)).toContain('lost')
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function makeRoot(prefix: string): Promise<void> {
  root = await mkdtemp(join(tmpdir(), prefix))
}

describe('prime realm runtime routing', () => {
  it('publishes only the latest-slot retention config fields', () => {
    const retentionConfig = {
      maxCompletionRetainedBytes: 101,
      maxCompletionRetainedNodes: 102,
      maxCompletionOpaqueBytes: 103,
      maxCompletionOpaqueNodes: 104,
    } satisfies Pick<primeRuntime.Config, (typeof RETENTION_CONFIG_FIELDS)[number]>
    type ExpectedConfigField = (typeof CONFIG_FIELDS)[number]
    const interfaceMatchesExpectedFields:
      [Exclude<keyof primeRuntime.Config, ExpectedConfigField>] extends [never]
        ? [Exclude<ExpectedConfigField, keyof primeRuntime.Config>] extends [never] ? true : false
        : false = true

    expect(interfaceMatchesExpectedFields).toBe(true)
    expect(Object.keys(retentionConfig)).toEqual(RETENTION_CONFIG_FIELDS)
    expect(Object.keys(primeRuntime.Config.dict ?? {})).toEqual(CONFIG_FIELDS)
  })

  it('passes all four latest-slot retention ceilings from host config to realms', async () => {
    await makeRoot('dsh-prime-retention-config-')
    const cases = [
      { field: 'maxCompletionRetainedBytes', program: '"xx"', opaque: false },
      { field: 'maxCompletionRetainedNodes', program: '[1]', opaque: false },
      { field: 'maxCompletionOpaqueBytes', program: '({ fn: () => 1 })', opaque: true },
      { field: 'maxCompletionOpaqueNodes', program: '({ fn: () => 1 })', opaque: true },
    ] as const

    for (const configCase of cases) {
      const ctx = await startHost({ [configCase.field]: 1, maxCompletionFullBytes: 1 })
      const result = await ctx.primeRealmRuntime.run(realmId(`retention-${configCase.field}`), {
        program: configCase.program,
        bindings: [],
      })

      expect(result.error, configCase.field).toBeUndefined()
      expect(result.value, configCase.field).toMatchObject({
        retained: false,
        type: configCase.opaque ? 'object' : configCase.field.endsWith('Nodes') ? 'array' : 'string',
        truncated: true,
        ...(configCase.opaque ? { opaque: true } : {}),
      })
      expect(result.presentation, configCase.field).toMatchObject({
        kind: 'unretained-preview',
        valueType: configCase.opaque ? 'object' : configCase.field.endsWith('Nodes') ? 'array' : 'string',
      })
    }
  })

  it('keeps ordinary bindings across cells without emitting retained-run notices', async () => {
    await makeRoot('dsh-prime-continuity-')
    const ctx = await startHost()

    const first = await ctx.primeRealmRuntime.run(realmId('session-alpha'), {
      program: `
        const lookup = new Map([['a', { id: 'a' }]])
        const review = async (id: string) => await tools.review_item({ item: lookup.get(id) })
        ;({ size: lookup.size, stateGlobal: typeof globalThis.state })
      `,
      bindings: toolsBindings({ review_item: async args => ({ seen: args.item }) }),
    })
    expect(first.error).toBeUndefined()
    expect(first.value).toEqual({ size: 1, stateGlobal: 'undefined' })
    expectFreshNamespaceNotice(first)

    const second = await ctx.primeRealmRuntime.run(realmId('session-alpha'), {
      program: 'await review("a")',
      bindings: toolsBindings({ review_item: async args => ({ rebound: args.item }) }),
    })
    expect(second.error).toBeUndefined()
    // The persisted closure resolved THIS run's binding, not run one's.
    expect(second.value).toEqual({ rebound: { id: 'a' } })
    expect(notices(second)).toEqual([])
  })

  it('preserves trusted presentation metadata when appending a namespace notice', async () => {
    await makeRoot('dsh-prime-presentation-notice-')
    const ctx = await startHost({ maxCompletionFullBytes: 64 })

    const result = await ctx.primeRealmRuntime.run(realmId('presentation-notice'), {
      program: '"x".repeat(500)',
      bindings: [],
    })

    expectFreshNamespaceNotice(result)
    expect(result.presentation).toMatchObject({
      kind: 'retained-preview',
      valueType: 'string',
      serializedBytes: 502,
    })
    if (result.presentation?.kind !== 'retained-preview') throw new Error('expected retained preview metadata')
    expect(result.presentation).not.toHaveProperty('handle')
  })

  it('routes one realm id to one live namespace and keeps separate realm ids isolated', async () => {
    await makeRoot('dsh-prime-sessions-')
    const ctx = await startHost()

    await ctx.primeRealmRuntime.run(realmId('session-alpha'), { program: 'const owner = "alpha"', bindings: [] })
    await ctx.primeRealmRuntime.run(realmId('session-beta'), { program: 'const owner = "beta"', bindings: [] })

    const alpha = await ctx.primeRealmRuntime.run(realmId('session-alpha'), { program: 'owner', bindings: [] })
    const beta = await ctx.primeRealmRuntime.run(realmId('session-beta'), { program: 'owner', bindings: [] })
    expect(alpha.value).toBe('alpha')
    expect(beta.value).toBe('beta')

    // A resumed session reaches the same realm; a fork (a new realm id) does not.
    const forked = await ctx.primeRealmRuntime.run(realmId('session-alpha-fork'), {
      program: 'typeof owner === "undefined" ? null : owner',
      bindings: [],
    })
    expect(forked.value).toBeNull()
  })

  it('serializes cells for one realm in run call order', async () => {
    await makeRoot('dsh-prime-admission-order-')
    const ctx = await startHost()
    const parked = deferred<CodeJsonValue>()

    const first = ctx.primeRealmRuntime.run(realmId('session-ordered'), {
      program: 'globalThis.order = ["first"]\nawait tools.park({})',
      bindings: toolsBindings({ park: () => parked.promise }),
    })
    await sleep(150)
    const second = ctx.primeRealmRuntime.run(realmId('session-ordered'), {
      program: 'globalThis.order.push("second")\nglobalThis.order',
      bindings: [],
    })
    parked.resolve('first done')

    expect((await first).value).toBe('first done')
    expect((await second).value).toEqual(['first', 'second'])
  })

  it('does not serialize execution across different realms', async () => {
    await makeRoot('dsh-prime-cross-realm-order-')
    const ctx = await startHost()
    const parked = deferred<CodeJsonValue>()
    const alphaStarted = deferred<void>()

    const alpha = ctx.primeRealmRuntime.run(realmId('session-order-alpha'), {
      program: 'await tools.park({})',
      bindings: toolsBindings({
        park: () => {
          alphaStarted.resolve(undefined)
          return parked.promise
        },
      }),
    })
    await alphaStarted.promise

    const beta = ctx.primeRealmRuntime.run(realmId('session-order-beta'), {
      program: '"beta completed"',
      bindings: [],
    })
    const betaBeforeRelease = await Promise.race([
      beta,
      sleep(1_500).then(() => undefined),
    ])
    parked.resolve('alpha completed')

    expect(betaBeforeRelease?.value).toBe('beta completed')
    expect((await alpha).value).toBe('alpha completed')
  })

  it('rejects an unusable realm id as caller misuse', async () => {
    await makeRoot('dsh-prime-realm-id-')
    const ctx = await startHost()

    await expect(ctx.primeRealmRuntime.run('', { program: '1', bindings: [] }))
      .rejects.toThrow('realm id must not be empty')
    await expect(ctx.primeRealmRuntime.run('not-a-verified-realm-identity', { program: '1', bindings: [] }))
      .rejects.toThrow('realm id is not a verified Realm identity')
  })

  it('freezes each namespace error-class descriptor after the first legal run', async () => {
    await makeRoot('dsh-prime-schema-error-class-')
    const ctx = await startHost()
    const descriptor = { name: 'ToolError', memberNameProperty: 'tool' }

    await expect(ctx.primeRealmRuntime.run(realmId('session-schema-error'), {
      program: '"must not run"',
      bindings: [
        ...toolsBindings({}, descriptor),
        bindingNamespace('tools', {}),
      ],
    })).rejects.toThrow('duplicate binding global')

    const first = await ctx.primeRealmRuntime.run(realmId('session-schema-error'), {
      program: 'const schemaKept = "stable"\nschemaKept',
      bindings: toolsBindings({}, descriptor),
    })
    expect(first.value).toBe('stable')
    expectFreshNamespaceNotice(first)

    const drifted = [
      toolsBindings({}),
      toolsBindings({}, { name: 'OtherError', memberNameProperty: 'tool' }),
      toolsBindings({}, { name: 'ToolError', memberNameProperty: 'operation' }),
    ]
    for (const candidate of drifted) {
      await expect(ctx.primeRealmRuntime.run(realmId('session-schema-error'), {
        program: 'globalThis.schemaDriftRan = true\n"must not run"',
        bindings: candidate,
      })).rejects.toThrow('changed its frozen error class descriptor')
    }

    const after = await ctx.primeRealmRuntime.run(realmId('session-schema-error'), {
      program: '({ kept: schemaKept, driftRan: Object.hasOwn(globalThis, "schemaDriftRan") })',
      bindings: toolsBindings({}, descriptor),
    })
    expect(after.value).toEqual({ kept: 'stable', driftRan: false })
    expect(notices(after)).toEqual([])

    // The first run declares `tools` WITHOUT an error class, so adding one
    // later is a frozen-descriptor change rather than a late declaration.
    await ctx.primeRealmRuntime.run(realmId('session-schema-add'), {
      program: 'const noErrorClassKept = "stable"\nnoErrorClassKept',
      bindings: toolsBindings({}),
    })
    await expect(ctx.primeRealmRuntime.run(realmId('session-schema-add'), {
      program: 'globalThis.addedErrorClassRan = true\n"must not run"',
      bindings: toolsBindings({}, descriptor),
    })).rejects.toThrow('changed its frozen error class descriptor')
    const afterAdded = await ctx.primeRealmRuntime.run(realmId('session-schema-add'), {
      program: '({ kept: noErrorClassKept, driftRan: Object.hasOwn(globalThis, "addedErrorClassRan") })',
      bindings: [],
    })
    expect(afterAdded.value).toEqual({ kept: 'stable', driftRan: false })
    expect(notices(afterAdded)).toEqual([])
  })

  it('rejects a namespace first introduced after the user claimed its lexical name', async () => {
    await makeRoot('dsh-prime-schema-late-global-')
    const ctx = await startHost()

    await ctx.primeRealmRuntime.run(realmId('session-schema-late'), {
      program: 'const lateTools = 7\nlateTools',
      bindings: [],
    })
    await expect(ctx.primeRealmRuntime.run(realmId('session-schema-late'), {
      program: 'await globalThis.lateTools.echo({ value: 9 })',
      bindings: [
        ...toolsBindings({}),
        bindingNamespace('lateTools', { echo: async args => args }),
      ],
    })).rejects.toThrow("was not declared by this Realm's first Prime run")

    const after = await ctx.primeRealmRuntime.run(realmId('session-schema-late'), {
      program: '({ lexical: lateTools, installed: Object.hasOwn(globalThis, "lateTools") })',
      bindings: [],
    })
    expect(after.value).toEqual({ lexical: 7, installed: false })
    expect(notices(after)).toEqual([])
  })

  it('allows a frozen namespace to be omitted, restored and given new functions', async () => {
    await makeRoot('dsh-prime-schema-members-')
    const ctx = await startHost()

    const first = await ctx.primeRealmRuntime.run(realmId('session-schema-members'), {
      program: 'const rememberedExtras = globalThis.extras\nawait globalThis.extras.echo({ turn: 1 })',
      bindings: [
        ...toolsBindings({}),
        bindingNamespace('extras', { echo: async args => ({ source: 'first', args }) }),
      ],
    })
    expect(first.value).toEqual({ source: 'first', args: { turn: 1 } })

    const omitted = await ctx.primeRealmRuntime.run(realmId('session-schema-members'), {
      program: '({ same: rememberedExtras === globalThis.extras, member: typeof globalThis.extras.echo })',
      bindings: [],
    })
    expect(omitted.value).toEqual({ same: true, member: 'undefined' })

    const restored = await ctx.primeRealmRuntime.run(realmId('session-schema-members'), {
      program: '({ same: rememberedExtras === globalThis.extras, result: await globalThis.extras.echo({ turn: 3 }) })',
      bindings: [
        ...toolsBindings({}),
        bindingNamespace('extras', { echo: async args => ({ source: 'restored', args }) }),
      ],
    })
    expect(restored.value).toEqual({
      same: true,
      result: { source: 'restored', args: { turn: 3 } },
    })
    expect(notices(restored)).toEqual([])
  })
})

describe('prime realm abort semantics', () => {
  it('reports an abort before dispatch when the signal already fired', async () => {
    await makeRoot('dsh-prime-abort-')
    const ctx = await startHost()

    const preAborted = new AbortController()
    preAborted.abort('user stopped the turn')
    const before = await ctx.primeRealmRuntime.run(realmId('session-abort'), {
      program: '1',
      signal: preAborted.signal,
      bindings: [],
    })
    expect(before.error).toEqual({ kind: 'abort', message: 'user stopped the turn' })
    expect(notices(before)).toEqual([])
  })

  it('cancels only the queued cell whose signal fires', async () => {
    await makeRoot('dsh-prime-abort-queued-')
    const ctx = await startHost()
    const parked = deferred<CodeJsonValue>()
    const controller = new AbortController()

    const held = ctx.primeRealmRuntime.run(realmId('session-abort-queued'), {
      program: 'await tools.park({})',
      bindings: toolsBindings({ park: () => parked.promise }),
    })
    await sleep(150)
    const queued = ctx.primeRealmRuntime.run(realmId('session-abort-queued'), {
      program: 'globalThis.queuedRan = true\n"queued ran"',
      signal: controller.signal,
      bindings: [],
    })
    controller.abort('user stopped the turn')
    parked.resolve('released')

    const heldResult = await held
    expect(heldResult.value).toBe('released')
    const queuedResult = await queued
    expect(queuedResult.error).toEqual({ kind: 'abort', message: 'user stopped the turn' })
    // The cancelled cell never ran; the realm survived and keeps its namespace.
    const after = await ctx.primeRealmRuntime.run(realmId('session-abort-queued'), {
      program: 'Object.hasOwn(globalThis, "queuedRan")',
      bindings: [],
    })
    expect(after.value).toBe(false)
  })
})

describe('realm namespace reporting', () => {
  it('reports namespace loss once on the cell after a timeout hard kill', async () => {
    await makeRoot('dsh-prime-generation-')
    const ctx = await startHost({ maxWallMs: 400 })

    const seeded = await ctx.primeRealmRuntime.run(realmId('session-gen'), { program: 'const kept = "v1"', bindings: [] })
    expectFreshNamespaceNotice(seeded)

    const killed = await ctx.primeRealmRuntime.run(realmId('session-gen'), {
      program: 'for (;;) {}',
      bindings: [],
    })
    expect(killed.error?.kind).toBe('timeout')
    expect(notices(killed)).toEqual([])

    const after = await ctx.primeRealmRuntime.run(realmId('session-gen'), {
      program: 'typeof kept === "undefined" ? null : kept',
      bindings: [],
    })
    expect(after.value).toBeNull()
    expectLostNamespaceNotice(after)

    const settled = await ctx.primeRealmRuntime.run(realmId('session-gen'), { program: '1', bindings: [] })
    expect(notices(settled)).toEqual([])
  })

  it('attributes namespace loss to the queued cell that actually inherits the replacement worker', async () => {
    await makeRoot('dsh-prime-queued-')
    const ctx = await startHost({ maxWallMs: 500 })

    await ctx.primeRealmRuntime.run(realmId('session-queue'), { program: 'const kept = "v1"', bindings: [] })

    // Both cells are admitted against the same worker. The first is hard-killed,
    // so the second starts against an empty namespace even though it was queued
    // before the kill.
    const killed = ctx.primeRealmRuntime.run(realmId('session-queue'), { program: 'for (;;) {}', bindings: [] })
    await sleep(100)
    const queued = ctx.primeRealmRuntime.run(realmId('session-queue'), {
      program: 'typeof kept === "undefined" ? null : kept',
      bindings: [],
    })

    const first = await killed
    expect(first.error?.kind).toBe('timeout')
    expect(notices(first)).toEqual([])

    const second = await queued
    expect(second.value).toBeNull()
    expectLostNamespaceNotice(second)
  })

  it('keeps a pending loss notice when a cell never reaches a worker', async () => {
    await makeRoot('dsh-prime-undispatched-')
    const ctx = await startHost({ maxWallMs: 400 })

    await ctx.primeRealmRuntime.run(realmId('session-undispatched'), { program: 'const kept = "v1"', bindings: [] })
    const killed = await ctx.primeRealmRuntime.run(realmId('session-undispatched'), { program: 'for (;;) {}', bindings: [] })
    expect(killed.error?.kind).toBe('timeout')

    // A program that does not survive the type strip never spawns a worker and
    // therefore neither reports nor consumes the pending loss notice.
    const stripFailed = await ctx.primeRealmRuntime.run(realmId('session-undispatched'), {
      program: 'enum Nope { A }\n1',
      bindings: [],
    })
    expect(stripFailed.error?.kind).toBe('exception')
    expect(notices(stripFailed)).toEqual([])

    const after = await ctx.primeRealmRuntime.run(realmId('session-undispatched'), {
      program: 'typeof kept === "undefined" ? null : kept',
      bindings: [],
    })
    expect(after.value).toBeNull()
    expectLostNamespaceNotice(after)
  })

  it('keeps the whole result within maxOutputBytes once the notice is appended', async () => {
    await makeRoot('dsh-prime-output-cap-')
    const maxOutputBytes = 2_048
    const ctx = await startHost({ maxOutputBytes })

    const result = await ctx.primeRealmRuntime.run(realmId('session-output-cap'), {
      program: 'for (let index = 0; index < 200; index++) console.log("line " + index + " " + "y".repeat(60))\n"done"',
      bindings: [],
    })
    expect(result.error?.kind).toBe('output-limit')
    expectFreshNamespaceNotice(result)

    const serialized = Buffer.byteLength(JSON.stringify(result.logs), 'utf8')
      + Buffer.byteLength(JSON.stringify(result.error?.message ?? ''), 'utf8')
    expect(serialized).toBeLessThanOrEqual(maxOutputBytes)
  })

  it('keeps the pending loss report when a run rejects as caller misuse', async () => {
    await makeRoot('dsh-prime-misuse-')
    const ctx = await startHost({ maxWallMs: 400 })

    await ctx.primeRealmRuntime.run(realmId('session-misuse'), { program: 'const kept = "v1"', bindings: [] })
    const killed = await ctx.primeRealmRuntime.run(realmId('session-misuse'), { program: 'for (;;) {}', bindings: [] })
    expect(killed.error?.kind).toBe('timeout')

    // Caller misuse rejects, so this run never dispatches and must not consume
    // the report the next run needs.
    const misuse = [...toolsBindings({}), bindingNamespace('tools', {})]
    await expect(ctx.primeRealmRuntime.run(realmId('session-misuse'), { program: '1', bindings: misuse }))
      .rejects.toThrow('duplicate binding global')

    const after = await ctx.primeRealmRuntime.run(realmId('session-misuse'), {
      program: 'typeof kept === "undefined" ? null : kept',
      bindings: [],
    })
    expect(after.value).toBeNull()
    expectLostNamespaceNotice(after)
  })
})

describe('realm pool governance', () => {
  it('reclaims the idle LRU realm at the ceiling and restarts that session with a fresh namespace', async () => {
    await makeRoot('dsh-prime-lru-')
    const ctx = await startHost({ maxActiveRealms: 1 })

    await ctx.primeRealmRuntime.run(realmId('session-alpha'), { program: 'const owner = "alpha"', bindings: [] })
    // Admitting beta has to reclaim alpha, which is idle.
    const beta = await ctx.primeRealmRuntime.run(realmId('session-beta'), { program: 'const owner = "beta"', bindings: [] })
    expect(beta.error).toBeUndefined()
    expectFreshNamespaceNotice(beta)

    const alpha = await ctx.primeRealmRuntime.run(realmId('session-alpha'), {
      program: 'typeof owner === "undefined" ? null : owner',
      bindings: [],
    })
    expect(alpha.value).toBeNull()
    expectFreshNamespaceNotice(alpha)
  })

  it('does not evict an idle local Realm when another host owns the requested Session', async () => {
    await makeRoot('dsh-prime-foreign-owner-')
    const first = await startHost({ maxActiveRealms: 1 })
    const second = await startHost({ maxActiveRealms: 1 })

    await first.primeRealmRuntime.run(realmId('session-local-alpha'), {
      program: 'const retainedAfterConflict = "alpha"\nretainedAfterConflict',
      bindings: [],
    })
    await second.primeRealmRuntime.run(realmId('session-foreign-beta'), { program: '"foreign owner"', bindings: [] })

    const conflict = await first.primeRealmRuntime.run(realmId('session-foreign-beta'), { program: '"must not run"', bindings: [] })
    expect(conflict.error?.message).toContain('already active in another host process')

    const retained = await first.primeRealmRuntime.run(realmId('session-local-alpha'), {
      program: 'retainedAfterConflict',
      bindings: [],
    })
    expect(retained.value).toBe('alpha')
    expect(notices(retained)).toEqual([])
  })

  it('refuses admission rather than reclaiming a realm with a run in flight', async () => {
    await makeRoot('dsh-prime-admission-')
    const ctx = await startHost({ maxActiveRealms: 1 })
    const parked = deferred<CodeJsonValue>()

    const held = ctx.primeRealmRuntime.run(realmId('session-held'), {
      program: 'await tools.park({})',
      bindings: toolsBindings({ park: () => parked.promise }),
    })
    // Let the run reach the parked binding call before the second admission.
    await sleep(200)

    const refused = await ctx.primeRealmRuntime.run(realmId('session-refused'), { program: '1', bindings: [] })
    expect(refused.error).toEqual({
      kind: 'exception',
      message: 'realm admission rejected: active realm limit reached',
    })

    parked.resolve('released')
    const result = await held
    expect(result.value).toBe('released')
  })

  it('releases an idle Realm for fresh takeover by another host', async () => {
    await makeRoot('dsh-prime-idle-')
    const first = await startHost({ maxIdleMs: 150 })
    const second = await startHost({ maxIdleMs: 150 })

    await first.primeRealmRuntime.run(realmId('session-idle'), { program: 'const owner = "idle"', bindings: [] })
    await sleep(700)

    const after = await second.primeRealmRuntime.run(realmId('session-idle'), {
      program: 'typeof owner === "undefined" ? null : owner',
      bindings: [],
    })
    expect(after.value).toBeNull()
    expectFreshNamespaceNotice(after)
  })

  it('refuses binding calls past the per-run host call budget without killing the realm', async () => {
    await makeRoot('dsh-prime-hostcalls-')
    const ctx = await startHost({ maxHostCallsPerRun: 2 })

    const result = await ctx.primeRealmRuntime.run(realmId('session-budget'), {
      program: `
        const seen: string[] = []
        for (let index = 0; index < 4; index++) {
          try {
            seen.push(String(await tools.ping({})))
          } catch (error) {
            seen.push(String(error?.message ?? error))
          }
        }
        const survived = true
        seen
      `,
      bindings: toolsBindings({ ping: async () => 'pong' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([
      'pong',
      'pong',
      'host call budget exhausted (2 binding calls per run)',
      'host call budget exhausted (2 binding calls per run)',
    ])

    // A refused call is the program's problem, not the realm's: its namespace survives.
    const after = await ctx.primeRealmRuntime.run(realmId('session-budget'), {
      program: 'survived === true',
      bindings: [],
    })
    expect(after.value).toBe(true)
    expect(notices(after)).toEqual([])
  })

  it('refuses binding calls past the in-flight ceiling', async () => {
    await makeRoot('dsh-prime-parallel-')
    const ctx = await startHost({ maxParallelHostCallsPerRun: 1 })
    const parked = deferred<CodeJsonValue>()

    const running = ctx.primeRealmRuntime.run(realmId('session-parallel'), {
      program: `
        const first = tools.park({})
        let second = 'not reached'
        try {
          await tools.park({})
        } catch (error) {
          second = String(error?.message ?? error)
        }
        [String(await first), second]
      `,
      bindings: toolsBindings({ park: () => parked.promise }),
    })
    // The refusal has to happen while the first call is still in flight, so the
    // parked host function is only released once both calls have been issued.
    await sleep(300)
    parked.resolve('released')

    const result = await running
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual(['released', 'parallel host call budget exhausted (1 binding calls in flight)'])
  })
})

describe('cross-process Realm ownership', () => {
  it('allows hosts to share durable state while running different Sessions', async () => {
    await makeRoot('dsh-prime-multi-host-')
    const first = await startHost()
    const second = await startHost()

    const firstRun = await first.primeRealmRuntime.run(realmId('session-first-host'), {
      program: 'const firstHostValue = "first"\nfirstHostValue',
      bindings: [],
    })
    const secondRun = await second.primeRealmRuntime.run(realmId('session-second-host'), {
      program: 'const secondHostValue = "second"\nsecondHostValue',
      bindings: [],
    })

    expect(firstRun.value).toBe('first')
    expect(secondRun.value).toBe('second')
    expectFreshNamespaceNotice(firstRun)
    expectFreshNamespaceNotice(secondRun)
  })

  it('keeps one live owner per Session and permits a fresh takeover after disposal', async () => {
    await makeRoot('dsh-prime-realm-owner-')
    const first = await startHost()
    const second = await startHost()

    const owned = await first.primeRealmRuntime.run(realmId('session-shared-host'), {
      program: 'const ownerSentinel = "first host"\nownerSentinel',
      bindings: [],
    })
    expect(owned.value).toBe('first host')

    const conflict = await second.primeRealmRuntime.run(realmId('session-shared-host'), {
      program: '"must not execute"',
      bindings: [],
    })
    expect(conflict.error).toMatchObject({
      kind: 'exception',
      message: 'dsh-prime-agent: this Prime session is already active in another host process',
    })

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const takeover = await second.primeRealmRuntime.run(realmId('session-shared-host'), {
      program: 'typeof ownerSentinel',
      bindings: [],
    })
    expect(takeover.value).toBe('undefined')
    expectFreshNamespaceNotice(takeover)
  })
})

describe('host composition', () => {
  it('mounts beside the official code runtime without touching it', async () => {
    await makeRoot('dsh-prime-coexists-')
    const { default: WorkerThreadCodeRuntime } = await import('@deepseek-ai/dsh-code-runtime-worker-thread')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WorkerThreadCodeRuntime, {})
    await ctx.plugin(primeRuntime, { stateDirectory: stateDirectory() })

    // The official one-shot runtime keeps its shipped semantics untouched.
    const first = await ctx.codeRuntime.run({ program: 'globalThis.carried = "one-shot"\nreturn 1', bindings: [] })
    expect(first.error).toBeUndefined()
    expect(first.value).toBe(1)
    const second = await ctx.codeRuntime.run({ program: 'return typeof globalThis.carried', bindings: [] })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe('undefined')

    // The Prime seam is the separate, uniquely named service.
    expect(ctx.primeRealmRuntime).toBeDefined()
    const seeded = await ctx.primeRealmRuntime.run(realmId('session-coexist'), {
      program: 'const kept = "realm"\nkept',
      bindings: [],
    })
    expect(seeded.error).toBeUndefined()
    expect(seeded.value).toBe('realm')
    expectFreshNamespaceNotice(seeded)
    const resumed = await ctx.primeRealmRuntime.run(realmId('session-coexist'), { program: 'kept', bindings: [] })
    expect(resumed.value).toBe('realm')
    expect(notices(resumed)).toEqual([])
  })

  it('starts the host even when the packaged preset cannot be placed', async () => {
    await makeRoot('dsh-prime-preset-degrade-')
    // A harness home that is a FILE: every placement attempt under it fails.
    const blocked = join(root as string, 'blocked-home')
    await writeFile(blocked, 'not a directory')
    const warnings: string[] = []

    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('dshHomePath', (...segments: string[]) => join(blocked, ...segments))
    ctx.provide('logger', { warn: (message: string) => { warnings.push(message) } })
    await ctx.plugin(primeRuntime, { stateDirectory: stateDirectory() })

    // The preset is missing from the picker; the realm service is not.
    expect(ctx.primeRealmRuntime).toBeDefined()
    expect(warnings.some(message => message.includes('could not place the packaged Prime preset'))).toBe(true)

    const result = await ctx.primeRealmRuntime.run(realmId('session-preset'), { program: '"still running"', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('still running')
  })

  it('skips preset placement when dshHomePath is not a function', async () => {
    await makeRoot('dsh-prime-preset-shape-')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('dshHomePath', { notCallable: true })
    await ctx.plugin(primeRuntime, { stateDirectory: stateDirectory() })

    expect(ctx.primeRealmRuntime).toBeDefined()
  })
})

describe('runtime disposal', () => {
  it('stops admission and terminates every realm', async () => {
    await makeRoot('dsh-prime-dispose-')
    const ctx = await startHost()
    const runtime = ctx.primeRealmRuntime

    await runtime.run(realmId('session-alpha'), { program: 'const owner = "alpha"', bindings: [] })
    await runtime.run(realmId('session-beta'), { program: 'const owner = "beta"', bindings: [] })

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    await expect(runtime.run(realmId('session-alpha'), { program: '1', bindings: [] }))
      .rejects.toThrow('prime realm runtime run() after disposal')
  })

  it('settles a run admitted around teardown with an abort, leaving no orphan worker', async () => {
    await makeRoot('dsh-prime-dispose-race-')
    const ctx = await startHost()
    const gate = deferred<CodeJsonValue>()

    // The program cannot finish before teardown: either the admission loses the
    // race and resolves 'runtime disposed', or the realm was built and its
    // teardown settles the in-flight run with 'realm disposed'. Both are aborts,
    // and neither path leaves a worker that nothing is left to dispose.
    const racing = ctx.primeRealmRuntime.run(realmId('session-racing'), {
      program: 'await tools.park({})',
      bindings: toolsBindings({ park: () => gate.promise }),
    })
    await sleep(100)

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    gate.resolve('never delivered')

    const result = await racing
    expect(result.error?.kind).toBe('abort')
  })

  it('settles a run that was in flight when the runtime was disposed', async () => {
    await makeRoot('dsh-prime-dispose-inflight-')
    const ctx = await startHost()
    const parked = deferred<CodeJsonValue>()

    const held = ctx.primeRealmRuntime.run(realmId('session-inflight'), {
      program: 'await tools.park({})',
      bindings: toolsBindings({ park: () => parked.promise }),
    })
    await sleep(200)

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    parked.resolve('never delivered')

    const result = await held
    expect(result.error?.kind).toBe('abort')
  })
})
