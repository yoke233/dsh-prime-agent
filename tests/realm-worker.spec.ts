import { afterEach, describe, expect, it } from 'vitest'
import type { CodeBindingFunction, CodeBindingNamespace, CodeJsonValue } from '@deepseek-ai/dsh-code-runtime'
import { PersistentRealm } from '../src/realm/realm.js'
import type { RealmBudgets } from '../src/realm/realm.js'

const BUDGETS: RealmBudgets = {
  computeMs: 5_000,
  maxWallMs: 10_000,
  maxOutputBytes: 65_536,
  maxOldGenerationSizeMb: 128,
}

const realms: PersistentRealm[] = []

function createRealm(budgets: Partial<RealmBudgets> = {}): PersistentRealm {
  const realm = new PersistentRealm({ realmId: `realm-${realms.length}`, budgets: { ...BUDGETS, ...budgets } })
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

afterEach(async () => {
  await Promise.all(realms.splice(0).map(realm => realm.dispose()))
})

describe('persistent realm continuity', () => {
  it('keeps state, Maps and closures across runs and rebinds tools every run', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: `
        state.lookup = new Map([['a', { id: 'a', size: 1 }]])
        state.review = async (id: string) => await tools.review_item({ item: state.lookup.get(id) })
        return state.lookup.size
      `,
      bindings: [tools({ review_item: async args => ({ seen: 'first', item: args.item }) })],
    })
    expect(first.error).toBeUndefined()
    expect(first.value).toBe(1)

    const second = await realm.run({
      program: 'return await state.review("a")',
      bindings: [tools({ review_item: async args => ({ seen: 'second', item: args.item }) })],
    })
    expect(second.error).toBeUndefined()
    expect(second.value).toEqual({ seen: 'second', item: { id: 'a', size: 1 } })
    expect(realm.generation).toBe(1)
  })

  it('keeps state through a program exception', async () => {
    const realm = createRealm()
    const failed = await realm.run({ program: 'state.keep = "v1"\nthrow new Error("boom")', bindings: [] })
    expect(failed.error?.kind).toBe('exception')
    expect(failed.error?.message).toContain('boom')

    const after = await realm.run({ program: 'return state.keep', bindings: [] })
    expect(after.value).toBe('v1')
    expect(realm.generation).toBe(1)
  })

  it('captures console output per run', async () => {
    const realm = createRealm()
    const first = await realm.run({ program: 'console.log("hello", { a: 1 })\nreturn "ok"', bindings: [] })
    expect(first.logs).toEqual(['hello { a: 1 }'])
    const second = await realm.run({ program: 'return "ok"', bindings: [] })
    expect(second.logs).toEqual([])
  })
})

describe('binding leases', () => {
  it('resolves a persisted tool reference against the current run bindings', async () => {
    const realm = createRealm()
    await realm.run({
      program: 'state.echo = async () => await tools.echo({})\nreturn "stored"',
      bindings: [tools({ echo: async () => 'first' })],
    })
    const second = await realm.run({
      program: 'return await state.echo()',
      bindings: [tools({ echo: async () => 'second' })],
    })
    expect(second.value).toBe('second')
  })

  it('fails a wrapper held in state once its member is revoked', async () => {
    const realm = createRealm()
    await realm.run({
      program: 'state.echo = tools.echo\nreturn "stored"',
      bindings: [tools({ echo: async args => args })],
    })
    const second = await realm.run({
      program: 'try { await state.echo({ n: 1 }) } catch (error) { return error.message }\nreturn "called"',
      bindings: [tools({ other: async args => args })],
    })
    expect(second.value).toContain('unknown binding')
  })

  it('hides the realm handshake bootstrap from the program lease', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: 'return { member: typeof tools.prime_realm_identity, present: "prime_realm_identity" in tools, keys: Object.keys(tools) }',
      bindings: [tools({
        echo: async args => args,
        prime_realm_identity: async () => ({ token: 'must-not-be-reachable' }),
      })],
    })
    expect(result.value).toEqual({ member: 'undefined', present: false, keys: ['echo'] })
  })

  it('routes a binding rejection through the declared error class', async () => {
    const realm = createRealm()
    const namespace: CodeBindingNamespace = {
      global: 'tools',
      functions: { boom: () => Promise.reject(new Error('host refused')) },
      errorClass: { name: 'ToolError', memberNameProperty: 'tool' },
    }
    const result = await realm.run({
      program: 'try { await tools.boom({}) } catch (error) { return { name: error.name, tool: error.tool, message: error.message, typed: error instanceof ToolError } }\nreturn "no throw"',
      bindings: [namespace],
    })
    expect(result.value).toEqual({ name: 'ToolError', tool: 'boom', message: 'host refused', typed: true })
  })

  it('refuses tool calls and discards output from work an earlier run detached', async () => {
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        state.trace = []
        const gate = new Promise(resolve => { state.release = resolve })
        void gate.then(async () => {
          console.log('detached output')
          try {
            await tools.echo({ n: 1 })
            state.trace.push('called')
          } catch (error) {
            state.trace.push(error.message)
          }
        })
        return 'armed'
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(armed.value).toBe('armed')

    const observed = await realm.run({
      program: 'state.release()\nawait new Promise(resolve => setTimeout(resolve, 30))\nreturn state.trace',
      bindings: [tools({ echo: async args => args })],
    })
    expect(observed.value).toEqual([expect.stringContaining('tool lease revoked')])
    expect(observed.logs).toEqual([])
  })

  it('survives a detached rejection instead of losing the realm heap', async () => {
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        state.keep = 'v1'
        const gate = new Promise(resolve => { state.release = resolve })
        void gate.then(() => tools.echo({ n: 1 }))
        return 'armed'
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(armed.value).toBe('armed')

    const observed = await realm.run({
      program: 'state.release()\nawait new Promise(resolve => setTimeout(resolve, 30))\nreturn state.keep',
      bindings: [tools({ echo: async args => args })],
    })
    expect(observed.error).toBeUndefined()
    expect(observed.value).toBe('v1')
    expect(observed.logs).toEqual([])
    expect(realm.generation).toBe(1)
  })

  it('clears timers a run left behind so they cannot fire in a later run', async () => {
    const realm = createRealm()
    await realm.run({
      program: 'state.fired = false\nsetTimeout(() => { state.fired = true }, 20)\nreturn "armed"',
      bindings: [],
    })
    await sleep(80)
    const result = await realm.run({ program: 'return state.fired', bindings: [] })
    expect(result.value).toBe(false)
  })

  it('tracks timers armed through node:timers, not just the global slot', async () => {
    const realm = createRealm()
    await realm.run({
      program: `
        state.fired = false
        const timers = await import('node:timers')
        timers.setTimeout(() => { state.fired = true }, 20)
        return 'armed'
      `,
      bindings: [],
    })
    await sleep(80)
    const result = await realm.run({ program: 'return state.fired', bindings: [] })
    expect(result.value).toBe(false)
  })
})

describe('serialization and abort', () => {
  it('runs strictly in admission order', async () => {
    const realm = createRealm()
    const gate = deferred<CodeJsonValue>()
    const first = realm.run({
      program: 'await tools.wait({})\nstate.order = ["first"]\nreturn "first"',
      bindings: [tools({ wait: () => gate.promise })],
    })
    const second = realm.run({ program: 'state.order.push("second")\nreturn state.order', bindings: [] })

    await sleep(40)
    gate.resolve(null)
    expect((await first).value).toBe('first')
    expect((await second).value).toEqual(['first', 'second'])
  })

  it('cancels a queued run without disturbing the active one', async () => {
    const realm = createRealm()
    const gate = deferred<CodeJsonValue>()
    const controller = new AbortController()
    const first = realm.run({
      program: 'await tools.wait({})\nreturn "first"',
      bindings: [tools({ wait: () => gate.promise })],
    })
    const second = realm.run({ program: 'return "second"', bindings: [], signal: controller.signal })

    await sleep(30)
    controller.abort('queued cancelled')
    expect((await second).error).toEqual({ kind: 'abort', message: 'queued cancelled' })

    gate.resolve(null)
    expect((await first).value).toBe('first')
    expect(realm.generation).toBe(1)
  })

  it('hard-kills the worker when the active run is aborted', async () => {
    const realm = createRealm()
    await realm.run({ program: 'state.keep = "v1"\nreturn "ok"', bindings: [] })

    const controller = new AbortController()
    const pending = realm.run({ program: 'await new Promise(() => {})', bindings: [], signal: controller.signal })
    await sleep(30)
    controller.abort('stop now')

    expect((await pending).error).toEqual({ kind: 'abort', message: 'stop now' })
    expect(realm.generation).toBe(2)
    expect(realm.generationNoticePending).toBe(true)
    realm.acknowledgeGenerationNotice()
    expect(realm.generationNoticePending).toBe(false)

    const after = await realm.run({ program: 'return state.keep ?? "lost"', bindings: [] })
    expect(after.value).toBe('lost')
    expect(realm.generation).toBe(2)
  })
})

describe('budgets', () => {
  it('times out an active run on the wall clock and starts a new generation', async () => {
    const realm = createRealm({ maxWallMs: 150 })
    const result = await realm.run({ program: 'state.keep = "v1"\nawait new Promise(() => {})', bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('wall-clock')
    expect(realm.generation).toBe(2)

    const after = await realm.run({ program: 'return state.keep ?? "lost"', bindings: [] })
    expect(after.value).toBe('lost')
  })

  it('times out a run that exhausts its compute budget', async () => {
    const realm = createRealm({ computeMs: 120 })
    const result = await realm.run({ program: 'while (true) {}', bindings: [] })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('compute budget')
    expect(realm.generation).toBe(2)
  })

  it('meters the compute budget per run rather than cumulatively', async () => {
    const realm = createRealm({ computeMs: 500 })
    const burn = 'const end = Date.now() + 300\nwhile (Date.now() < end) {}\nreturn "burned"'
    expect((await realm.run({ program: burn, bindings: [] })).value).toBe('burned')
    expect((await realm.run({ program: burn, bindings: [] })).value).toBe('burned')
    expect(realm.generation).toBe(1)
  })

  it('fails a run whose logs exceed the output cap and loses the generation', async () => {
    const realm = createRealm({ maxOutputBytes: 512 })
    const result = await realm.run({ program: 'console.log("x".repeat(2000))\nreturn "ok"', bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs).toEqual([])
    expect(realm.generation).toBe(2)
  })

  it('fails an oversized completion without losing the realm heap', async () => {
    const realm = createRealm({ maxOutputBytes: 512 })
    const result = await realm.run({ program: 'state.keep = "v1"\nreturn "y".repeat(2000)', bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: 'return state.keep', bindings: [] })).value).toBe('v1')
  })

  it('rejects a completion value that is not lossless JSON', async () => {
    const realm = createRealm()
    const result = await realm.run({ program: 'return { size: NaN }', bindings: [] })
    expect(result.error).toEqual({ kind: 'invalid-output', message: 'program completion must be lossless JSON' })
    expect(realm.generation).toBe(1)
  })
})

describe('substrate failures and disposal', () => {
  it('reports a worker that exits on its own and starts a new generation', async () => {
    const realm = createRealm()
    await realm.run({ program: 'state.keep = "v1"\nreturn "ok"', bindings: [] })

    const result = await realm.run({ program: 'process.exit(3)\nreturn "unreachable"', bindings: [] })
    expect(result.error?.kind).toBe('worker-exit')
    expect(realm.generation).toBe(2)

    const after = await realm.run({ program: 'return state.keep ?? "lost"', bindings: [] })
    expect(after.value).toBe('lost')
    expect(realm.generation).toBe(2)
  })

  it('reports a program that does not survive the type strip without spawning a worker', async () => {
    const realm = createRealm()
    const result = await realm.run({ program: 'enum Color { Red }\nreturn Color.Red', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(realm.generation).toBe(1)
    expect(realm.idle).toBe(true)
  })

  it('rejects a namespace that names a backend-owned global', async () => {
    const realm = createRealm()
    await expect(realm.run({ program: 'return 1', bindings: [{ global: 'console', functions: {} }] }))
      .rejects.toThrow('reserved binding global')
  })

  it('rejects a namespace with no functions record instead of throwing synchronously', async () => {
    const realm = createRealm()
    const pending = realm.run({ program: 'return 1', bindings: [{ global: 'tools' } as CodeBindingNamespace] })
    await expect(pending).rejects.toThrow('must declare a functions record')
    expect(realm.idle).toBe(true)
  })

  it('answers a binding that rejects with an unrenderable value', async () => {
    const realm = createRealm()
    const hostile = {
      get message(): string { throw new Error('no message') },
      toString(): string { throw new Error('no string') },
    }
    const result = await realm.run({
      program: 'try { await tools.boom({}) } catch (error) { return "rejected: " + typeof error.message }\nreturn "resolved"',
      bindings: [{ global: 'tools', functions: { boom: () => Promise.reject(hostile) } }],
    })
    expect(result.value).toBe('rejected: string')
    expect(realm.generation).toBe(1)
  })

  it('keeps the abort reason when dispose races an in-flight hard kill', async () => {
    const realm = createRealm()
    const controller = new AbortController()
    const pending = realm.run({ program: 'await new Promise(() => {})', bindings: [], signal: controller.signal })
    await sleep(30)
    controller.abort('stop now')
    await realm.dispose()
    expect((await pending).error).toEqual({ kind: 'abort', message: 'stop now' })
  })

  it('aborts an in-flight run on dispose and rejects later runs', async () => {
    const realm = createRealm()
    const gate = deferred<CodeJsonValue>()
    const pending = realm.run({
      program: 'await tools.wait({})\nreturn "never"',
      bindings: [tools({ wait: () => gate.promise })],
    })
    await sleep(30)
    await realm.dispose()

    expect((await pending).error).toEqual({ kind: 'abort', message: 'realm disposed' })
    await expect(realm.run({ program: 'return 1', bindings: [] })).rejects.toThrow('after disposal')
    expect(realm.idle).toBe(true)
  })

  it('renders an abort reason whose toString throws, on both the queued and the active path', async () => {
    const realm = createRealm()
    const hostile = { toString(): string { throw new Error('no string') } }

    const preAborted = new AbortController()
    preAborted.abort(hostile)
    const queued = await realm.run({ program: 'return 1', bindings: [], signal: preAborted.signal })
    expect(queued.error).toEqual({ kind: 'abort', message: 'aborted' })

    // The active path renders inside an `abort` listener, where a throw would
    // reach the host's event loop instead of any caller.
    const live = new AbortController()
    const pending = realm.run({ program: 'await new Promise(() => {})', bindings: [], signal: live.signal })
    await sleep(30)
    live.abort(hostile)
    expect((await pending).error).toEqual({ kind: 'abort', message: 'aborted' })
  })

  it('tracks idleness and last use for pool bookkeeping', async () => {
    const realm = createRealm()
    expect(realm.idle).toBe(true)
    const before = realm.lastUsedAt
    await sleep(5)
    await realm.run({ program: 'return "ok"', bindings: [] })
    expect(realm.idle).toBe(true)
    expect(realm.lastUsedAt).toBeGreaterThan(before)
  })
})

describe('hostile program code', () => {
  it('keeps the control channel out of reach when the program patches MessagePort.prototype', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const { MessageChannel, MessagePort } = await import('node:worker_threads')
        let intercepted = 0
        const original = MessagePort.prototype.postMessage
        MessagePort.prototype.postMessage = function (...args) {
          intercepted += 1
          state.captured = this
          return original.apply(this, args)
        }
        // Proves the patch is live on the very prototype the control port uses:
        // the program's OWN port goes through it.
        const channel = new MessageChannel()
        channel.port1.postMessage('own port')
        channel.port1.close()
        channel.port2.close()
        const echoed = await tools.echo({ ping: true })
        console.log('a log line')
        return { intercepted, echoed, captured: state.captured === channel.port1 }
      `,
      bindings: [tools({ echo: async args => args as CodeJsonValue })],
    })
    expect(result.error).toBeUndefined()
    // One interception: the program's own port. The binding call and the log
    // both crossed the control channel without touching the patched method, so
    // the program never got `this` bound to the private port.
    expect(result.value).toEqual({ intercepted: 1, echoed: { ping: true }, captured: true })
    expect(result.logs).toContain('a log line')
  })

  it('cannot settle its own run early by forging a terminal message', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const { parentPort } = await import('node:worker_threads')
        // The ambient port the program CAN reach is wired to nothing host-side,
        // and the run nonce it would have to quote never enters the isolate.
        parentPort?.postMessage({ type: 'done', runId: 1, nonce: 'guessed', json: '"forged"' })
        await new Promise(resolve => setTimeout(resolve, 100))
        return 'real completion'
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('real completion')
  })

  it('cancels a promise-based timer the run left behind', async () => {
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        const timers = await import('node:timers/promises')
        state.marks = []
        timers.setTimeout(150, 'late').then(() => { state.marks.push('ran') }).catch(() => {})
        return 'armed'
      `,
      bindings: [],
    })
    expect(armed.value).toBe('armed')

    await sleep(500)
    const after = await realm.run({ program: 'return state.marks', bindings: [] })
    // The detached continuation was cancelled with the run that armed it, so it
    // never reached `state` on somebody else's turn.
    expect(after.value).toEqual([])
  })

  it('still honours a promise-based timer awaited inside its own run', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const timers = await import('node:timers/promises')
        const started = Date.now()
        await timers.setTimeout(40)
        return Date.now() - started >= 30
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(true)
  })

  it('charges output that stepped over the patched write to the run that wrote it', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: `
        const { Writable } = await import('node:stream')
        // Steps over the own-property \`write\` the worker installed, which is
        // what would otherwise put these bytes on the host's native pipe with
        // nothing to say which run produced them.
        for (let index = 0; index < 40; index++) {
          Writable.prototype.write.call(process.stdout, 'STRAY-MARKER-' + index)
        }
        return 'wrote'
      `,
      bindings: [],
    })
    expect(first.value).toBe('wrote')
    // Attributed, not merely suppressed: the bypass lands in its own run's logs.
    expect(first.logs.filter(line => line.includes('STRAY-MARKER'))).toHaveLength(40)

    const second = await realm.run({ program: 'console.log("second run output")\nreturn "second"', bindings: [] })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe('second')
    expect(second.logs.some(line => line.includes('STRAY-MARKER'))).toBe(false)
    expect(second.logs).toContain('second run output')
  })

  it('reports a substrate failure without the host path that caused it', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        process.nextTick(() => { throw new Error('/host/secret/path.js exploded') })
        await new Promise(resolve => setTimeout(resolve, 1000))
        return 'never'
      `,
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('realm worker failed outside the program')
    expect(result.error?.message).not.toContain('/host/secret')
  })
})
