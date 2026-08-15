import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import { decodeChallenge, RealmIdentityStore } from '../src/realm/identity.js'
import * as primeRuntime from '../src/runtime.js'

/* eslint-disable @typescript-eslint/no-explicit-any -- test bindings receive already-validated JSON */
type Binding = (args: any) => Promise<CodeJsonValue>

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  // Reverse order: the second host of a lease test must release before the first.
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function stateDirectory(): string {
  if (root === undefined) throw new Error('test root was not created')
  return join(root, 'state')
}

/** Boot a real host row: real lease, real official fallback, real workers. */
async function startHost(config: Record<string, unknown> = {}): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(primeRuntime, { stateDirectory: stateDirectory(), ...config })
  return context
}

/** The identity store the agent-scoped bootstrap tool would use, over the same directory. */
function identityStore(): RealmIdentityStore {
  return new RealmIdentityStore({ directory: join(stateDirectory(), 'realm-identity') })
}

/**
 * A faithful stand-in for the `prime_realm_identity` tool: it decodes the
 * runtime's challenge and issues over the SAME on-disk key the runtime verifies
 * against. `mangle` lets a test corrupt the response after it was legitimately
 * issued.
 */
function issuer(sessionOwner: string, mangle?: (issued: { protocol: number; token: string; proof: string }) => unknown): Binding {
  return async (args: any) => {
    const challenge = decodeChallenge(args?.challenge)
    if (challenge === undefined) throw new Error('handshake challenge was not 32 bytes')
    const { token, proof } = await identityStore().issue(sessionOwner, challenge)
    const issued = { protocol: 1, token, proof }
    return (mangle ? mangle(issued) : issued) as CodeJsonValue
  }
}

function bindings(functions: Record<string, Binding>): CodeBindingNamespace[] {
  return [{ global: 'tools', functions: functions as Record<string, CodeBindingFunction> }]
}

/** Bindings that make the request a Prime request for `sessionOwner`. */
function primeFor(sessionOwner: string, extra: Record<string, Binding> = {}): CodeBindingNamespace[] {
  return bindings({ prime_realm_identity: issuer(sessionOwner), ...extra })
}

function primeForWithErrorClass(
  sessionOwner: string,
  errorClass: { name: string, memberNameProperty: string } | undefined,
  extra: Record<string, Binding> = {},
): CodeBindingNamespace[] {
  const [namespace] = primeFor(sessionOwner, extra)
  if (namespace === undefined) throw new Error('Prime fixture did not create its tools namespace')
  return errorClass === undefined ? [{ ...namespace }] : [{ ...namespace, errorClass }]
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

describe('prime code runtime routing', () => {
  it('delegates a request without the handshake binding to the official one-shot runtime', async () => {
    await makeRoot('dsh-prime-oneshot-')
    const ctx = await startHost()

    const first = await ctx.codeRuntime.run({
      program: 'globalThis.carried = "from run one"\nreturn 1',
      bindings: [],
    })
    expect(first.error).toBeUndefined()
    expect(first.value).toBe(1)
    // The one-shot path is the official implementation verbatim: no realm
    // bookkeeping is appended to it.
    expect(notices(first)).toEqual([])

    const second = await ctx.codeRuntime.run({
      program: 'return [typeof globalThis.carried, typeof globalThis.state]',
      bindings: [],
    })
    expect(second.error).toBeUndefined()
    expect(second.value).toEqual(['undefined', 'undefined'])
    expect(notices(second)).toEqual([])
  })

  it('keeps ordinary bindings across cells without emitting retained-run notices', async () => {
    await makeRoot('dsh-prime-continuity-')
    const ctx = await startHost()

    const first = await ctx.codeRuntime.run({
      program: `
        const lookup = new Map([['a', { id: 'a' }]])
        const review = async (id: string) => await tools.review_item({ item: lookup.get(id) })
        ;({ size: lookup.size, stateGlobal: typeof globalThis.state })
      `,
      bindings: primeFor('session-alpha', { review_item: async args => ({ seen: args.item }) }),
    })
    expect(first.error).toBeUndefined()
    expect(first.value).toEqual({ size: 1, stateGlobal: 'undefined' })
    expectFreshNamespaceNotice(first)

    const second = await ctx.codeRuntime.run({
      program: 'await review("a")',
      bindings: primeFor('session-alpha', { review_item: async args => ({ rebound: args.item }) }),
    })
    expect(second.error).toBeUndefined()
    // The persisted closure resolved THIS run's binding, not run one's.
    expect(second.value).toEqual({ rebound: { id: 'a' } })
    expect(notices(second)).toEqual([])
  })

  it('routes one session to one realm and keeps separate sessions isolated', async () => {
    await makeRoot('dsh-prime-sessions-')
    const ctx = await startHost()

    await ctx.codeRuntime.run({ program: 'const owner = "alpha"', bindings: primeFor('session-alpha') })
    await ctx.codeRuntime.run({ program: 'const owner = "beta"', bindings: primeFor('session-beta') })

    const alpha = await ctx.codeRuntime.run({ program: 'owner', bindings: primeFor('session-alpha') })
    const beta = await ctx.codeRuntime.run({ program: 'owner', bindings: primeFor('session-beta') })
    expect(alpha.value).toBe('alpha')
    expect(beta.value).toBe('beta')

    // A resumed session reaches the same realm; a fork (a new session id) does not.
    const forked = await ctx.codeRuntime.run({ program: 'typeof owner === "undefined" ? null : owner', bindings: primeFor('session-alpha-fork') })
    expect(forked.value).toBeNull()
  })

  it('admits cells for one realm in run call order even when handshakes finish out of order', async () => {
    await makeRoot('dsh-prime-admission-order-')
    const ctx = await startHost()
    const issueFirst = issuer('session-ordered')

    const first = ctx.codeRuntime.run({
      program: 'const dispatchOrder = ["first"]\ndispatchOrder',
      bindings: bindings({
        prime_realm_identity: async args => {
          await sleep(400)
          return issueFirst(args)
        },
      }),
    })
    const second = ctx.codeRuntime.run({
      program: 'dispatchOrder.push("second")\ndispatchOrder',
      bindings: primeFor('session-ordered'),
    })

    expect((await first).value).toEqual(['first'])
    expect((await second).value).toEqual(['first', 'second'])
  })

  it('freezes each namespace error-class descriptor after the first legal Prime run', async () => {
    await makeRoot('dsh-prime-schema-error-class-')
    const ctx = await startHost()
    const descriptor = { name: 'ToolError', memberNameProperty: 'tool' }

    await expect(ctx.codeRuntime.run({
      program: '"must not run"',
      bindings: [
        ...primeForWithErrorClass('session-schema-error', descriptor),
        bindingNamespace('tools', {}),
      ],
    })).rejects.toThrow('duplicate binding global')

    const first = await ctx.codeRuntime.run({
      program: 'const schemaKept = "stable"\nschemaKept',
      bindings: primeForWithErrorClass('session-schema-error', descriptor),
    })
    expect(first.value).toBe('stable')
    expectFreshNamespaceNotice(first)

    const drifted = [
      primeFor('session-schema-error'),
      primeForWithErrorClass('session-schema-error', { name: 'OtherError', memberNameProperty: 'tool' }),
      primeForWithErrorClass('session-schema-error', { name: 'ToolError', memberNameProperty: 'operation' }),
    ]
    for (const candidate of drifted) {
      await expect(ctx.codeRuntime.run({
        program: 'globalThis.schemaDriftRan = true\n"must not run"',
        bindings: candidate,
      })).rejects.toThrow('changed its frozen error class descriptor')
    }

    const after = await ctx.codeRuntime.run({
      program: '({ kept: schemaKept, driftRan: Object.hasOwn(globalThis, "schemaDriftRan") })',
      bindings: primeForWithErrorClass('session-schema-error', descriptor),
    })
    expect(after.value).toEqual({ kept: 'stable', driftRan: false })
    expect(notices(after)).toEqual([])

    await ctx.codeRuntime.run({
      program: 'const noErrorClassKept = "stable"\nnoErrorClassKept',
      bindings: primeFor('session-schema-add'),
    })
    await expect(ctx.codeRuntime.run({
      program: 'globalThis.addedErrorClassRan = true\n"must not run"',
      bindings: primeForWithErrorClass('session-schema-add', descriptor),
    })).rejects.toThrow('changed its frozen error class descriptor')
    const afterAdded = await ctx.codeRuntime.run({
      program: '({ kept: noErrorClassKept, driftRan: Object.hasOwn(globalThis, "addedErrorClassRan") })',
      bindings: primeFor('session-schema-add'),
    })
    expect(afterAdded.value).toEqual({ kept: 'stable', driftRan: false })
    expect(notices(afterAdded)).toEqual([])
  })

  it('rejects a namespace first introduced after the user claimed its lexical name', async () => {
    await makeRoot('dsh-prime-schema-late-global-')
    const ctx = await startHost()

    await ctx.codeRuntime.run({
      program: 'const lateTools = 7\nlateTools',
      bindings: primeFor('session-schema-late'),
    })
    await expect(ctx.codeRuntime.run({
      program: 'await globalThis.lateTools.echo({ value: 9 })',
      bindings: [
        ...primeFor('session-schema-late'),
        bindingNamespace('lateTools', { echo: async args => args }),
      ],
    })).rejects.toThrow('was not declared by this Realm\'s first Prime run')

    const after = await ctx.codeRuntime.run({
      program: '({ lexical: lateTools, installed: Object.hasOwn(globalThis, "lateTools") })',
      bindings: primeFor('session-schema-late'),
    })
    expect(after.value).toEqual({ lexical: 7, installed: false })
    expect(notices(after)).toEqual([])
  })

  it('allows a frozen namespace to be omitted, restored and given new functions', async () => {
    await makeRoot('dsh-prime-schema-members-')
    const ctx = await startHost()

    const first = await ctx.codeRuntime.run({
      program: 'const rememberedExtras = globalThis.extras\nawait globalThis.extras.echo({ turn: 1 })',
      bindings: [
        ...primeFor('session-schema-members'),
        bindingNamespace('extras', { echo: async args => ({ source: 'first', args }) }),
      ],
    })
    expect(first.value).toEqual({ source: 'first', args: { turn: 1 } })

    const omitted = await ctx.codeRuntime.run({
      program: '({ same: rememberedExtras === globalThis.extras, member: typeof globalThis.extras.echo })',
      bindings: primeFor('session-schema-members'),
    })
    expect(omitted.value).toEqual({ same: true, member: 'undefined' })

    const restored = await ctx.codeRuntime.run({
      program: '({ same: rememberedExtras === globalThis.extras, result: await globalThis.extras.echo({ turn: 3 }) })',
      bindings: [
        ...primeFor('session-schema-members'),
        bindingNamespace('extras', { echo: async args => ({ source: 'restored', args }) }),
      ],
    })
    expect(restored.value).toEqual({
      same: true,
      result: { source: 'restored', args: { turn: 3 } },
    })
    expect(notices(restored)).toEqual([])
  })

  it('does not serialize execution across different realms', async () => {
    await makeRoot('dsh-prime-cross-realm-order-')
    const ctx = await startHost()
    const parked = deferred<CodeJsonValue>()
    const alphaStarted = deferred<void>()

    const alpha = ctx.codeRuntime.run({
      program: 'await tools.park({})',
      bindings: primeFor('session-order-alpha', {
        park: () => {
          alphaStarted.resolve(undefined)
          return parked.promise
        },
      }),
    })
    await alphaStarted.promise

    const beta = ctx.codeRuntime.run({
      program: '"beta completed"',
      bindings: primeFor('session-order-beta'),
    })
    const betaBeforeRelease = await Promise.race([
      beta,
      sleep(1_500).then(() => undefined),
    ])
    parked.resolve('alpha completed')

    expect(betaBeforeRelease?.value).toBe('beta completed')
    expect((await alpha).value).toBe('alpha completed')
  })

  it('hides the handshake bootstrap from the program lease', async () => {
    await makeRoot('dsh-prime-hidden-')
    const ctx = await startHost()

    const result = await ctx.codeRuntime.run({
      program: `
        let called = 'not reached'
        try {
          await tools.prime_realm_identity({ protocol: 1, challenge: 'x' })
        } catch (error) {
          called = String(error?.message ?? error)
        }
        ;({
          member: typeof tools.prime_realm_identity,
          present: 'prime_realm_identity' in tools,
          keys: Object.keys(tools),
          called,
        })
      `,
      bindings: primeFor('session-hidden', { echo: async args => args as CodeJsonValue }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({
      member: 'undefined',
      present: false,
      keys: ['echo'],
    })
    expect(String((result.value as Record<string, unknown>).called)).toContain('prime_realm_identity')
  })
})

describe('prime handshake failure is fail-closed', () => {
  it('refuses a forged token without degrading to one-shot semantics', async () => {
    await makeRoot('dsh-prime-forged-')
    const ctx = await startHost()

    const forged = await ctx.codeRuntime.run({
      program: '1',
      bindings: bindings({
        prime_realm_identity: async () => ({ protocol: 1, token: 'A'.repeat(130), proof: 'B'.repeat(43) }),
      }),
    })
    expect(forged.error?.kind).toBe('exception')
    expect(forged.error?.message).toContain('realm handshake rejected')
    expect(forged.value).toBeUndefined()
    expect(forged.logs).toEqual([])

    // Fail-closed means fail-closed: the run did NOT quietly execute one-shot.
    const oneShot = await ctx.codeRuntime.run({ program: 'return 1', bindings: [] })
    expect(oneShot.value).toBe(1)
    expect(notices(oneShot)).toEqual([])
  })

  it('refuses a genuine token whose challenge proof was tampered with', async () => {
    await makeRoot('dsh-prime-tampered-')
    const ctx = await startHost()

    const result = await ctx.codeRuntime.run({
      program: '1',
      bindings: bindings({
        prime_realm_identity: issuer('session-tampered', issued => ({
          ...issued,
          proof: `${issued.proof.startsWith('A') ? 'B' : 'A'}${issued.proof.slice(1)}`,
        })),
      }),
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('challenge proof does not match this token')
  })

  it('refuses a replayed proof issued for a different challenge', async () => {
    await makeRoot('dsh-prime-replay-')
    const ctx = await startHost()
    const store = identityStore()
    const stale = await store.issue('session-replay', Buffer.alloc(32, 7))

    const result = await ctx.codeRuntime.run({
      program: '1',
      bindings: bindings({ prime_realm_identity: async () => ({ protocol: 1, ...stale }) }),
    })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('challenge proof does not match this token')
  })

  it('refuses a malformed handshake response and a bootstrap that rejects', async () => {
    await makeRoot('dsh-prime-malformed-')
    const ctx = await startHost()

    const shapes: unknown[] = [null, 'token', { protocol: 2, token: 'a', proof: 'b' }, { protocol: 1, token: 5, proof: 'b' }, { protocol: 1, proof: 'b' }]
    for (const shape of shapes) {
      const result = await ctx.codeRuntime.run({
        program: '1',
        bindings: bindings({ prime_realm_identity: async () => shape as CodeJsonValue }),
      })
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toBe('realm handshake returned a malformed response')
    }

    const rejected = await ctx.codeRuntime.run({
      program: '1',
      bindings: bindings({ prime_realm_identity: async () => { throw new Error('tool denied by policy') } }),
    })
    expect(rejected.error?.kind).toBe('exception')
    expect(rejected.error?.message).toBe('realm handshake binding failed: tool denied by policy')
  })

  it('resolves rather than rejects when the handshake response fights inspection', async () => {
    await makeRoot('dsh-prime-hostile-shape-')
    const ctx = await startHost()

    const hostile: unknown[] = [
      { protocol: 1, get token(): string { throw new Error('no token for you') }, proof: 'p' },
      { protocol: 1, token: 'a', get proof(): string { throw new Error('no proof for you') } },
      { get protocol(): number { throw new Error('no protocol for you') } },
    ]
    for (const response of hostile) {
      const result = await ctx.codeRuntime.run({
        program: '1',
        bindings: bindings({ prime_realm_identity: async () => response as CodeJsonValue }),
      })
      expect(result.error).toEqual({ kind: 'exception', message: 'realm handshake returned a malformed response' })
    }

    // A namespace whose `functions` throws on access declares no handshake, so
    // probing it must not fail the call on its own. The request is then an
    // ordinary one-shot, and the official runtime is left to judge the
    // namespace — which it does, as the caller misuse it is.
    const hostileNamespace = [{ global: 'tools', get functions(): never { throw new Error('no functions') } }] as unknown as CodeBindingNamespace[]
    await expect(ctx.codeRuntime.run({ program: 'return 7', bindings: hostileNamespace }))
      .rejects.toThrow('no functions')
  })

  it('never leaks the token, proof, or challenge into a failure message', async () => {
    await makeRoot('dsh-prime-secrets-')
    const ctx = await startHost()
    let seen: { challenge: string; token: string; proof: string } | undefined

    const result = await ctx.codeRuntime.run({
      program: '1',
      bindings: bindings({
        prime_realm_identity: async (args: any) => {
          const challenge = decodeChallenge(args.challenge)
          if (challenge === undefined) throw new Error('bad challenge')
          const issued = await identityStore().issue('session-secret', challenge)
          seen = { challenge: String(args.challenge), ...issued }
          return { protocol: 1, token: issued.token, proof: `${issued.proof.slice(0, -1)}Z` }
        },
      }),
    })
    expect(result.error?.kind).toBe('exception')
    const message = result.error?.message ?? ''
    expect(seen).toBeDefined()
    expect(message).not.toContain(seen?.token)
    expect(message).not.toContain(seen?.proof)
    expect(message).not.toContain(seen?.challenge)
    expect(message).not.toContain(stateDirectory())
  })

  it('reports an abort rather than a handshake failure', async () => {
    await makeRoot('dsh-prime-abort-')
    const ctx = await startHost()

    const preAborted = new AbortController()
    preAborted.abort('user stopped the turn')
    let bootstrapCalls = 0
    const before = await ctx.codeRuntime.run({
      program: '1',
      signal: preAborted.signal,
      bindings: bindings({
        prime_realm_identity: async () => { bootstrapCalls += 1; return null },
      }),
    })
    expect(before.error).toEqual({ kind: 'abort', message: 'user stopped the turn' })
    expect(bootstrapCalls).toBe(0)

    const during = new AbortController()
    const mid = await ctx.codeRuntime.run({
      program: '1',
      signal: during.signal,
      bindings: bindings({
        prime_realm_identity: async () => {
          during.abort('aborted mid-handshake')
          throw new Error('dispatch cancelled')
        },
      }),
    })
    expect(mid.error).toEqual({ kind: 'abort', message: 'aborted mid-handshake' })
  })
})

describe('realm namespace reporting', () => {
  it('reports namespace loss once on the cell after a timeout hard kill', async () => {
    await makeRoot('dsh-prime-generation-')
    const ctx = await startHost({ maxWallMs: 400 })

    const seeded = await ctx.codeRuntime.run({ program: 'const kept = "v1"', bindings: primeFor('session-gen') })
    expectFreshNamespaceNotice(seeded)

    const killed = await ctx.codeRuntime.run({
      program: 'for (;;) {}',
      bindings: primeFor('session-gen'),
    })
    expect(killed.error?.kind).toBe('timeout')
    expect(notices(killed)).toEqual([])

    const after = await ctx.codeRuntime.run({ program: 'typeof kept === "undefined" ? null : kept', bindings: primeFor('session-gen') })
    expect(after.value).toBeNull()
    expectLostNamespaceNotice(after)

    const settled = await ctx.codeRuntime.run({ program: '1', bindings: primeFor('session-gen') })
    expect(notices(settled)).toEqual([])
  })

  it('attributes namespace loss to the queued cell that actually inherits the replacement worker', async () => {
    await makeRoot('dsh-prime-queued-')
    const ctx = await startHost({ maxWallMs: 500 })

    await ctx.codeRuntime.run({ program: 'const kept = "v1"', bindings: primeFor('session-queue') })

    // Both cells are admitted against the same worker. The first is hard-killed,
    // so the second starts against an empty namespace even though it was queued
    // before the kill.
    const killed = ctx.codeRuntime.run({ program: 'for (;;) {}', bindings: primeFor('session-queue') })
    await sleep(100)
    const queued = ctx.codeRuntime.run({ program: 'typeof kept === "undefined" ? null : kept', bindings: primeFor('session-queue') })

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

    await ctx.codeRuntime.run({ program: 'const kept = "v1"', bindings: primeFor('session-undispatched') })
    const killed = await ctx.codeRuntime.run({ program: 'for (;;) {}', bindings: primeFor('session-undispatched') })
    expect(killed.error?.kind).toBe('timeout')

    // A program that does not survive the type strip never spawns a worker and
    // therefore neither reports nor consumes the pending loss notice.
    const stripFailed = await ctx.codeRuntime.run({
      program: 'enum Nope { A }\n1',
      bindings: primeFor('session-undispatched'),
    })
    expect(stripFailed.error?.kind).toBe('exception')
    expect(notices(stripFailed)).toEqual([])

    const after = await ctx.codeRuntime.run({ program: 'typeof kept === "undefined" ? null : kept', bindings: primeFor('session-undispatched') })
    expect(after.value).toBeNull()
    expectLostNamespaceNotice(after)
  })

  it('keeps the whole result within maxOutputBytes once the notice is appended', async () => {
    await makeRoot('dsh-prime-output-cap-')
    const maxOutputBytes = 2_048
    const ctx = await startHost({ maxOutputBytes })

    const result = await ctx.codeRuntime.run({
      program: 'for (let index = 0; index < 200; index++) console.log("line " + index + " " + "y".repeat(60))\n"done"',
      bindings: primeFor('session-output-cap'),
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

    await ctx.codeRuntime.run({ program: 'const kept = "v1"', bindings: primeFor('session-misuse') })
    const killed = await ctx.codeRuntime.run({ program: 'for (;;) {}', bindings: primeFor('session-misuse') })
    expect(killed.error?.kind).toBe('timeout')

    // Caller misuse rejects, so this run never dispatches and must not consume
    // the report the next run needs.
    const misuse = [...primeFor('session-misuse'), { global: 'tools', functions: {} }]
    await expect(ctx.codeRuntime.run({ program: '1', bindings: misuse }))
      .rejects.toThrow('duplicate binding global')

    const after = await ctx.codeRuntime.run({ program: 'typeof kept === "undefined" ? null : kept', bindings: primeFor('session-misuse') })
    expect(after.value).toBeNull()
    expectLostNamespaceNotice(after)
  })
})

describe('realm pool governance', () => {
  it('reclaims the idle LRU realm at the ceiling and restarts that session with a fresh namespace', async () => {
    await makeRoot('dsh-prime-lru-')
    const ctx = await startHost({ maxActiveRealms: 1 })

    await ctx.codeRuntime.run({ program: 'const owner = "alpha"', bindings: primeFor('session-alpha') })
    // Admitting beta has to reclaim alpha, which is idle.
    const beta = await ctx.codeRuntime.run({ program: 'const owner = "beta"', bindings: primeFor('session-beta') })
    expect(beta.error).toBeUndefined()
    expectFreshNamespaceNotice(beta)

    const alpha = await ctx.codeRuntime.run({ program: 'typeof owner === "undefined" ? null : owner', bindings: primeFor('session-alpha') })
    expect(alpha.value).toBeNull()
    expectFreshNamespaceNotice(alpha)
  })

  it('refuses admission rather than reclaiming a realm with a run in flight', async () => {
    await makeRoot('dsh-prime-admission-')
    const ctx = await startHost({ maxActiveRealms: 1 })
    const parked = deferred<CodeJsonValue>()

    const held = ctx.codeRuntime.run({
      program: 'await tools.park({})',
      bindings: primeFor('session-held', { park: () => parked.promise }),
    })
    // Let the run reach the parked binding call before the second admission.
    await sleep(200)

    const refused = await ctx.codeRuntime.run({ program: '1', bindings: primeFor('session-refused') })
    expect(refused.error).toEqual({
      kind: 'exception',
      message: 'realm admission rejected: active realm limit reached',
    })

    parked.resolve('released')
    const result = await held
    expect(result.value).toBe('released')
  })

  it('reclaims a realm that has been idle past the ceiling', async () => {
    await makeRoot('dsh-prime-idle-')
    const ctx = await startHost({ maxIdleMs: 150 })

    await ctx.codeRuntime.run({ program: 'const owner = "idle"', bindings: primeFor('session-idle') })
    await sleep(700)

    const after = await ctx.codeRuntime.run({ program: 'typeof owner === "undefined" ? null : owner', bindings: primeFor('session-idle') })
    expect(after.value).toBeNull()
    expectFreshNamespaceNotice(after)
  })

  it('refuses binding calls past the per-run host call budget without killing the realm', async () => {
    await makeRoot('dsh-prime-hostcalls-')
    const ctx = await startHost({ maxHostCallsPerRun: 2 })

    const result = await ctx.codeRuntime.run({
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
      bindings: primeFor('session-budget', { ping: async () => 'pong' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([
      'pong',
      'pong',
      'host call budget exhausted (2 binding calls per run)',
      'host call budget exhausted (2 binding calls per run)',
    ])

    // A refused call is the program's problem, not the realm's: its namespace survives.
    const after = await ctx.codeRuntime.run({ program: 'survived === true', bindings: primeFor('session-budget') })
    expect(after.value).toBe(true)
    expect(notices(after)).toEqual([])
  })

  it('refuses binding calls past the in-flight ceiling', async () => {
    await makeRoot('dsh-prime-parallel-')
    const ctx = await startHost({ maxParallelHostCallsPerRun: 1 })
    const parked = deferred<CodeJsonValue>()

    const running = ctx.codeRuntime.run({
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
      bindings: primeFor('session-parallel', { park: () => parked.promise }),
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

describe('host owner lease', () => {
  it('refuses a second host over the same state directory and releases on disposal', async () => {
    await makeRoot('dsh-prime-lease-')
    const first = await startHost()
    expect(first.codeRuntime).toBeDefined()

    const second = new Context()
    contexts.push(second)
    await expect(second.plugin(primeRuntime, { stateDirectory: stateDirectory() }))
      .rejects.toThrow('another live host process already owns this Prime realm state directory')

    const leasePath = join(stateDirectory(), 'realm-identity', 'host.lease')
    const lease = JSON.parse(await readFile(leasePath, 'utf8')) as { pid: number }
    expect(lease.pid).toBe(process.pid)

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    await expect(readFile(leasePath, 'utf8')).rejects.toThrow()
  })

  it('reclaims a lease whose owner process is gone, and refuses an unreadable one', async () => {
    await makeRoot('dsh-prime-lease-stale-')
    const identityDirectory = join(stateDirectory(), 'realm-identity')
    const leasePath = join(identityDirectory, 'host.lease')
    await mkdir(identityDirectory, { recursive: true })

    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(exited.pid).toBeGreaterThan(0)
    await writeFile(leasePath, JSON.stringify({ pid: exited.pid, startedAt: Date.now(), nonce: 'A'.repeat(22) }))

    const ctx = await startHost()
    expect(ctx.codeRuntime).toBeDefined()
    const reclaimed = JSON.parse(await readFile(leasePath, 'utf8')) as { pid: number }
    expect(reclaimed.pid).toBe(process.pid)

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    await writeFile(leasePath, 'not a lease record')
    const corrupted = new Context()
    contexts.push(corrupted)
    await expect(corrupted.plugin(primeRuntime, { stateDirectory: stateDirectory() }))
      .rejects.toThrow('refusing to start without proving the previous owner is gone')
  })
})

describe('host composition', () => {
  it('refuses to mount beside another code runtime instead of colliding on the service', async () => {
    await makeRoot('dsh-prime-double-provider-')
    const { default: WorkerThreadCodeRuntime } = await import('@deepseek-ai/dsh-code-runtime-worker-thread')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(WorkerThreadCodeRuntime, {})

    await expect(ctx.plugin(primeRuntime, { stateDirectory: stateDirectory() }))
      .rejects.toThrow('ctx.codeRuntime is already provided')
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

    // The preset is missing from the picker; the runtime is not.
    expect(ctx.codeRuntime).toBeDefined()
    expect(warnings.some(message => message.includes('could not place the packaged Prime preset'))).toBe(true)

    const result = await ctx.codeRuntime.run({ program: 'return "still running"', bindings: [] })
    expect(result.value).toBe('still running')
  })

  it('skips preset placement when dshHomePath is not a function', async () => {
    await makeRoot('dsh-prime-preset-shape-')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('dshHomePath', { notCallable: true })
    await ctx.plugin(primeRuntime, { stateDirectory: stateDirectory() })

    expect(ctx.codeRuntime).toBeDefined()
  })
})

describe('runtime disposal', () => {
  it('stops admission and terminates every realm', async () => {
    await makeRoot('dsh-prime-dispose-')
    const ctx = await startHost()
    const runtime = ctx.codeRuntime

    await ctx.codeRuntime.run({ program: 'const owner = "alpha"', bindings: primeFor('session-alpha') })
    await ctx.codeRuntime.run({ program: 'const owner = "beta"', bindings: primeFor('session-beta') })

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)

    await expect(runtime.run({ program: '1', bindings: primeFor('session-alpha') }))
      .rejects.toThrow('prime code runtime run() after disposal')
    // The one-shot path is refused by the same admission gate.
    await expect(runtime.run({ program: 'return 1', bindings: [] }))
      .rejects.toThrow('prime code runtime run() after disposal')
  })

  it('refuses to build a realm for a handshake that only completes after teardown', async () => {
    await makeRoot('dsh-prime-dispose-handshake-')
    const ctx = await startHost()
    const gate = deferred<void>()

    const racing = ctx.codeRuntime.run({
      program: '1',
      bindings: bindings({
        prime_realm_identity: async (args: any) => {
          await gate.promise
          const challenge = decodeChallenge(args.challenge)
          if (challenge === undefined) throw new Error('bad challenge')
          const issued = await identityStore().issue('session-racing', challenge)
          return { protocol: 1, ...issued }
        },
      }),
    })
    await sleep(100)

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    gate.resolve()

    // A realm admitted here would own a worker that nothing is left to dispose.
    const result = await racing
    expect(result.error).toEqual({ kind: 'abort', message: 'runtime disposed' })
    expect(notices(result)).toEqual([])
  })

  it('settles a run that was in flight when the runtime was disposed', async () => {
    await makeRoot('dsh-prime-dispose-inflight-')
    const ctx = await startHost()
    const parked = deferred<CodeJsonValue>()

    const held = ctx.codeRuntime.run({
      program: 'await tools.park({})',
      bindings: primeFor('session-inflight', { park: () => parked.promise }),
    })
    await sleep(200)

    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    parked.resolve('never delivered')

    const result = await held
    expect(result.error?.kind).toBe('abort')
  })
})
