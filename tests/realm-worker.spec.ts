import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
const execFileAsync = promisify(execFile)

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

async function runHeadlessProbe(source: string, timeout = 4_000): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  return stdout
}

afterEach(async () => {
  await Promise.all(realms.splice(0).map(realm => realm.dispose()))
})

describe('persistent REPL cells', () => {
  it('keeps ordinary bindings, Maps and closures across cells and rebinds tools every run', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: `
        const lookup = new Map([['a', { id: 'a', size: 1 }]])
        const review = async (id: string) => await globalThis.tools.review_item({ item: lookup.get(id) })
        lookup.size
      `,
      bindings: [tools({ review_item: async args => ({ seen: 'first', item: args.item }) })],
    })
    expect(first.error).toBeUndefined()
    expect(first.value).toBe(1)

    const second = await realm.run({
      program: 'await review("a")',
      bindings: [tools({ review_item: async args => ({ seen: 'second', item: args.item }) })],
    })
    expect(second.error).toBeUndefined()
    expect(second.value).toEqual({ seen: 'second', item: { id: 'a', size: 1 } })
    expect(realm.generation).toBe(1)
  })

  it('passes RegExp.source to grep without quoted-string double escaping', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: String.raw`await globalThis.tools.grep({ pattern: /constructor\(/.source })`,
      bindings: [tools({ grep: async args => args.pattern })],
    })

    expect(result.error).toBeUndefined()
    expect(result.value).toBe(String.raw`constructor\(`)
  })

  it('keeps declarations and assignments completed before a program exception', async () => {
    const realm = createRealm()
    const failed = await realm.run({
      program: 'const keptAfterFailure = { version: "v1" }\nkeptAfterFailure.touched = true\nthrow new Error("boom")',
      bindings: [],
    })
    expect(failed.error?.kind).toBe('exception')
    expect(failed.error?.message).toContain('boom')

    const after = await realm.run({ program: 'keptAfterFailure', bindings: [] })
    expect(after.value).toEqual({ version: 'v1', touched: true })
    expect(realm.generation).toBe(1)
  })

  it('captures console output per cell', async () => {
    const realm = createRealm()
    const first = await realm.run({ program: 'console.log("hello", { a: 1 })\n"ok"', bindings: [] })
    expect(first.logs).toEqual(['hello { a: 1 }'])
    const second = await realm.run({ program: '"ok"', bindings: [] })
    expect(second.logs).toEqual([])
  })

  it('allows const, let, var, function and class to be redeclared in later cells', async () => {
    const realm = createRealm()
    const pairs = [
      ['const redeclaredConst = 1\nredeclaredConst', 'const redeclaredConst = 2\nredeclaredConst'],
      ['let redeclaredLet = 1\nredeclaredLet', 'let redeclaredLet = 2\nredeclaredLet'],
      ['var redeclaredVar = 1\nredeclaredVar', 'var redeclaredVar = 2\nredeclaredVar'],
      ['function redeclaredFunction() { return 1 }\nredeclaredFunction()', 'function redeclaredFunction() { return 2 }\nredeclaredFunction()'],
      ['class RedeclaredClass { static value = 1 }\nRedeclaredClass.value', 'class RedeclaredClass { static value = 2 }\nRedeclaredClass.value'],
    ] as const

    for (const [first, second] of pairs) {
      expect((await realm.run({ program: first, bindings: [] })).value).toBe(1)
      expect((await realm.run({ program: second, bindings: [] })).value).toBe(2)
    }
    expect(realm.generation).toBe(1)
  })

  it('supports top-level await and retains its result binding', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: 'const awaitedValue = await Promise.resolve({ ready: true })\nawaitedValue.ready',
      bindings: [],
    })
    expect(first.value).toBe(true)
    expect((await realm.run({ program: 'awaitedValue', bindings: [] })).value).toEqual({ ready: true })
  })

  it('keeps destructured bindings across cells', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: `
        const { answer: destructuredAnswer, detail: { label: destructuredLabel } } = {
          answer: 42,
          detail: { label: 'kept' },
        }
        ;({ destructuredAnswer, destructuredLabel })
      `,
      bindings: [],
    })
    expect(first.value).toEqual({ destructuredAnswer: 42, destructuredLabel: 'kept' })

    const second = await realm.run({
      program: '({ destructuredAnswer, destructuredLabel })',
      bindings: [],
    })
    expect(second.value).toEqual({ destructuredAnswer: 42, destructuredLabel: 'kept' })
    expect(realm.generation).toBe(1)
  })

  it('keeps strict-mode behavior in every cell', async () => {
    const realm = createRealm()

    const undeclared = await realm.run({ program: 'primeUndeclared = 1', bindings: [] })
    expect(undeclared.error?.kind).toBe('exception')
    expect(undeclared.error?.message).toContain('primeUndeclared is not defined')
    expect((await realm.run({ program: 'Object.hasOwn(globalThis, "primeUndeclared")', bindings: [] })).value).toBe(false)

    const withStatement = await realm.run({ program: 'with ({ value: 1 }) { value }', bindings: [] })
    expect(withStatement.error?.kind).toBe('exception')
    expect(withStatement.error?.message).toMatch(/with/i)

    const callee = await realm.run({
      program: 'function strictCallee() { return arguments.callee }\nstrictCallee()',
      bindings: [],
    })
    expect(callee.error?.kind).toBe('exception')
    expect(callee.error?.message).toContain('callee')
    expect(realm.generation).toBe(1)
  })

  it('does not expose a state global and lets state be an ordinary user binding', async () => {
    const realm = createRealm()
    const ambient = await realm.run({
      program: '({ own: Object.hasOwn(globalThis, "state"), type: typeof globalThis.state })',
      bindings: [],
    })
    expect(ambient.value).toEqual({ own: false, type: 'undefined' })

    expect((await realm.run({ program: 'const state = { userOwned: true }\nstate.userOwned', bindings: [] })).value).toBe(true)
    expect((await realm.run({ program: '({ lexical: state.userOwned, global: typeof globalThis.state })', bindings: [] })).value)
      .toEqual({ lexical: true, global: 'undefined' })
  })

  it('reserves the tools name while keeping globalThis.tools usable after the rejected cell', async () => {
    const realm = createRealm()
    const shadowed = await realm.run({
      program: `
        const tools = { local: true };
        ({ local: tools.local, globalCall: await globalThis.tools.echo({ turn: 1 }) })
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(shadowed.error?.kind).toBe('exception')
    expect(shadowed.error?.message).toMatch(/tools.*already been declared/i)
    expect(realm.generation).toBe(1)

    const next = await realm.run({
      program: 'await globalThis.tools.echo({ turn: 2 })',
      bindings: [tools({ echo: async args => args })],
    })
    expect(next.value).toEqual({ turn: 2 })
  })

  it('uses the final expression as completion and rejects a top-level return', async () => {
    const realm = createRealm()
    expect((await realm.run({ program: 'const completionValue = 20 + 22\ncompletionValue', bindings: [] })).value).toBe(42)

    const returned = await realm.run({ program: 'return 42', bindings: [] })
    expect(returned.error?.kind).toBe('exception')
    expect(returned.error?.message).toContain('return')
    expect(realm.generation).toBe(1)
  })

  it('does not pollute the namespace when a cell has a syntax error', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const beforeSyntaxFailure = "kept"\nbeforeSyntaxFailure', bindings: [] })
    const failed = await realm.run({ program: 'const neverDeclared =', bindings: [] })
    expect(failed.error?.kind).toBe('exception')

    const after = await realm.run({
      program: '({ before: beforeSyntaxFailure, missing: typeof neverDeclared })',
      bindings: [],
    })
    expect(after.value).toEqual({ before: 'kept', missing: 'undefined' })
  })
})

describe('binding leases', () => {
  it('resolves a persisted tool reference against the current run bindings', async () => {
    const realm = createRealm()
    await realm.run({
      program: 'const echoCurrent = async () => await globalThis.tools.echo({})\n"stored"',
      bindings: [tools({ echo: async () => 'first' })],
    })
    const second = await realm.run({
      program: 'await echoCurrent()',
      bindings: [tools({ echo: async () => 'second' })],
    })
    expect(second.value).toBe('second')
  })

  it('fails a captured wrapper once its member is revoked', async () => {
    const realm = createRealm()
    await realm.run({
      program: 'const capturedEcho = globalThis.tools.echo\n"stored"',
      bindings: [tools({ echo: async args => args })],
    })
    const second = await realm.run({
      program: `
        let revokedMessage = 'called'
        try { await capturedEcho({ n: 1 }) } catch (error) { revokedMessage = error.message }
        revokedMessage
      `,
      bindings: [tools({ other: async args => args })],
    })
    expect(second.value).toContain('unknown binding')
  })

  it('routes a binding rejection through the declared error class', async () => {
    const realm = createRealm()
    const namespace: CodeBindingNamespace = {
      global: 'tools',
      functions: { boom: () => Promise.reject(new Error('host refused')) },
      errorClass: { name: 'ToolError', memberNameProperty: 'tool' },
    }
    const result = await realm.run({
      program: `
        let rejection
        try { await globalThis.tools.boom({}) } catch (error) {
          rejection = { name: error.name, tool: error.tool, message: error.message, typed: error instanceof ToolError }
        }
        rejection
      `,
      bindings: [namespace],
    })
    expect(result.value).toEqual({ name: 'ToolError', tool: 'boom', message: 'host refused', typed: true })
  })

  it('refuses tool calls and discards output from work an earlier run detached', async () => {
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        const detachedTrace = []
        let releaseDetached
        const detachedGate = new Promise(resolve => { releaseDetached = resolve })
        void detachedGate.then(async () => {
          console.log('detached output')
          try {
            await globalThis.tools.echo({ n: 1 })
            detachedTrace.push('called')
          } catch (error) {
            detachedTrace.push(error.message)
          }
        })
        'armed'
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(armed.value).toBe('armed')

    const observed = await realm.run({
      program: 'releaseDetached()\nawait new Promise(resolve => setTimeout(resolve, 30))\ndetachedTrace',
      bindings: [tools({ echo: async args => args })],
    })
    expect(observed.value).toEqual([expect.stringContaining('tool lease revoked')])
    expect(observed.logs).toEqual([])
  })

  it('survives a detached rejection instead of losing the realm heap', async () => {
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        const keptThroughDetachedRejection = 'v1'
        let releaseRejected
        const rejectedGate = new Promise(resolve => { releaseRejected = resolve })
        void rejectedGate.then(() => globalThis.tools.echo({ n: 1 }))
        'armed'
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(armed.value).toBe('armed')

    const observed = await realm.run({
      program: 'releaseRejected()\nawait new Promise(resolve => setTimeout(resolve, 30))\nkeptThroughDetachedRejection',
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
      program: 'let firedAfterSettlement = false\nsetTimeout(() => { firedAfterSettlement = true }, 20)\n"armed"',
      bindings: [],
    })
    await sleep(80)
    const result = await realm.run({ program: 'firedAfterSettlement', bindings: [] })
    expect(result.value).toBe(false)
  })
})

describe('host call settlement', () => {
  it('waits for an accepted void host call before settling or dispatching the next cell', async () => {
    const realm = createRealm()
    const started = deferred<void>()
    const release = deferred<void>()
    const events: string[] = []

    const first = realm.run({
      program: 'void globalThis.tools.mutate({})\n"first"',
      bindings: [tools({
        mutate: async () => {
          events.push('host started')
          started.resolve(undefined)
          await release.promise
          events.push('host finished')
          return null
        },
      })],
    }).then((result) => {
      events.push('first settled')
      return result
    })

    await started.promise
    const second = realm.run(
      { program: '"second"', bindings: [] },
      () => { events.push('second dispatched') },
    ).then((result) => {
      events.push('second settled')
      return result
    })

    await sleep(50)
    const beforeRelease = [...events]
    release.resolve(undefined)

    expect((await first).value).toBe('first')
    expect((await second).value).toBe('second')
    expect(beforeRelease).toEqual(['host started'])
    expect(events).toEqual([
      'host started',
      'host finished',
      'first settled',
      'second dispatched',
      'second settled',
    ])
  })

  it('wall-times out and hard-kills a cell whose accepted void host call never settles', async () => {
    const realm = createRealm({ maxWallMs: 150 })
    const started = deferred<void>()
    const parked = deferred<CodeJsonValue>()

    const pending = realm.run({
      program: 'const keptBeforeDetachedTimeout = "v1"\nvoid globalThis.tools.park({})\n"unreachable completion"',
      bindings: [tools({
        park: () => {
          started.resolve(undefined)
          return parked.promise
        },
      })],
    })

    await started.promise
    const result = await pending
    const after = await realm.run({
      program: 'typeof keptBeforeDetachedTimeout === "undefined" ? "lost" : keptBeforeDetachedTimeout',
      bindings: [],
    })
    parked.resolve(null)

    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('wall-clock')
    expect(after.value).toBe('lost')
    expect(realm.generation).toBe(2)
  })

  it('waits for an accepted void host call before settling a program exception', async () => {
    const realm = createRealm()
    const started = deferred<void>()
    const release = deferred<void>()
    const events: string[] = []

    const pending = realm.run({
      program: 'void globalThis.tools.mutate({})\nthrow new Error("boom after call")',
      bindings: [tools({
        mutate: async () => {
          events.push('host started')
          started.resolve(undefined)
          await release.promise
          events.push('host finished')
          return null
        },
      })],
    }).then((result) => {
      events.push('run settled')
      return result
    })

    await started.promise
    await sleep(50)
    const beforeRelease = [...events]
    release.resolve(undefined)
    const result = await pending

    expect(beforeRelease).toEqual(['host started'])
    expect(events).toEqual(['host started', 'host finished', 'run settled'])
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('boom after call')
    expect(realm.generation).toBe(1)
  })
})

describe('serialization and abort', () => {
  it('runs strictly in admission order', async () => {
    const realm = createRealm()
    const gate = deferred<CodeJsonValue>()
    const first = realm.run({
      program: 'await globalThis.tools.wait({})\nconst admittedOrder = ["first"]\n"first"',
      bindings: [tools({ wait: () => gate.promise })],
    })
    const second = realm.run({ program: 'admittedOrder.push("second")\nadmittedOrder', bindings: [] })

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
      program: 'await globalThis.tools.wait({})\n"first"',
      bindings: [tools({ wait: () => gate.promise })],
    })
    const second = realm.run({ program: '"second"', bindings: [], signal: controller.signal })

    await sleep(30)
    controller.abort('queued cancelled')
    expect((await second).error).toEqual({ kind: 'abort', message: 'queued cancelled' })

    gate.resolve(null)
    expect((await first).value).toBe('first')
    expect(realm.generation).toBe(1)
  })

  it('hard-kills the worker when the active run is aborted', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const keptBeforeAbort = "v1"\n"ok"', bindings: [] })

    const controller = new AbortController()
    const pending = realm.run({ program: 'await new Promise(() => {})', bindings: [], signal: controller.signal })
    await sleep(30)
    controller.abort('stop now')

    expect((await pending).error).toEqual({ kind: 'abort', message: 'stop now' })
    expect(realm.generation).toBe(2)

    const after = await realm.run({
      program: 'typeof keptBeforeAbort === "undefined" ? "lost" : keptBeforeAbort',
      bindings: [],
    })
    expect(after.value).toBe('lost')
    expect(realm.generation).toBe(2)
  })
})

describe('budgets and completion', () => {
  it('times out an active run on the wall clock and starts a new generation', async () => {
    const realm = createRealm({ maxWallMs: 150 })
    const result = await realm.run({
      program: 'const keptBeforeWallTimeout = "v1"\nawait new Promise(() => {})',
      bindings: [],
    })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('wall-clock')
    expect(realm.generation).toBe(2)

    const after = await realm.run({
      program: 'typeof keptBeforeWallTimeout === "undefined" ? "lost" : keptBeforeWallTimeout',
      bindings: [],
    })
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
    const burn = 'const burnEnd = Date.now() + 300\nwhile (Date.now() < burnEnd) {}\n"burned"'
    expect((await realm.run({ program: burn, bindings: [] })).value).toBe('burned')
    expect((await realm.run({ program: burn, bindings: [] })).value).toBe('burned')
    expect(realm.generation).toBe(1)
  })

  it('fails a run whose logs exceed the output cap and loses the generation', async () => {
    const realm = createRealm({ maxOutputBytes: 512 })
    const result = await realm.run({ program: 'console.log("x".repeat(2000))\n"ok"', bindings: [] })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs).toEqual([])
    expect(realm.generation).toBe(2)
  })

  it('references an oversized completion without losing the realm heap', async () => {
    // REWRITTEN BY PHASE 2 (plan §9 Phase 2, §10 "affected existing
    // assertions"): a completion too large for the wire is no longer a failure.
    // The cell succeeds, the model gets a bounded reference to the value, and
    // the namespace it was declared in is untouched — which is the half of this
    // case that was always the point.
    const realm = createRealm({ maxOutputBytes: 512 })
    const result = await realm.run({
      program: 'const keptAfterOversizedCompletion = "v1"\n"y".repeat(2000)',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, type: 'string', truncated: true })
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: 'keptAfterOversizedCompletion', bindings: [] })).value).toBe('v1')
  })

  it('retains a non-lossless completion as opaque without losing the cell', async () => {
    // REWRITTEN BY WP-C: a non-lossless completion no longer fails the cell —
    // it is retained under the opaque budgets and answered with the fixed
    // envelope, and the namespace keeps every declaration the program made.
    const realm = createRealm()
    const result = await realm.run({
      program: 'const keptAfterOpaqueCompletion = "v1";\n({ size: NaN })',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ retained: true, type: 'object', opaque: true, truncated: true })
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: 'keptAfterOpaqueCompletion', bindings: [] })).value).toBe('v1')
  })

  it('accepts an undefined completion and retains every other non-lossless completion shape', async () => {
    // REWRITTEN BY WP-C: only `undefined` completes without a result. Every
    // other non-lossless shape is retained as opaque and answered with the
    // fixed envelope; none of them cost the realm its heap.
    const realm = createRealm()
    const completionCases = [
      { program: 'undefined', opaque: false },
      { program: '() => 42', opaque: true },
      { program: 'new Map([["answer", 42]])', opaque: true },
      {
        program: 'const cyclicCompletion = {}; cyclicCompletion.self = cyclicCompletion; cyclicCompletion',
        opaque: true,
      },
    ] as const

    for (const completionCase of completionCases) {
      const result = await realm.run({ program: completionCase.program, bindings: [] })
      expect(result.error, completionCase.program).toBeUndefined()
      if (completionCase.opaque) {
        expect(result.value, completionCase.program).toMatchObject({ retained: true, opaque: true, truncated: true })
      } else {
        expect(result.value, completionCase.program).toBeUndefined()
      }
    }
    expect(realm.generation).toBe(1)
  })
})

describe('substrate failures and disposal', () => {
  it('reports a worker that exits on its own and starts a new generation', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const keptBeforeExit = "v1"\n"ok"', bindings: [] })

    const result = await realm.run({ program: 'process.exit(3)\n"unreachable"', bindings: [] })
    expect(result.error?.kind).toBe('worker-exit')
    expect(realm.generation).toBe(2)

    const after = await realm.run({
      program: 'typeof keptBeforeExit === "undefined" ? "lost" : keptBeforeExit',
      bindings: [],
    })
    expect(after.value).toBe('lost')
    expect(realm.generation).toBe(2)
  })

  it('reports a program that does not survive the type strip without spawning a worker', async () => {
    const realm = createRealm()
    const result = await realm.run({ program: 'enum Color { Red }\nColor.Red', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(realm.generation).toBe(1)
    expect(realm.idle).toBe(true)
  })

  it('rejects native dynamic import without damaging the generation', async () => {
    const realm = createRealm()
    await realm.run({ program: 'const keptBeforeImportFailure = "v1"\nkeptBeforeImportFailure', bindings: [] })

    const imported = await realm.run({ program: 'await import("node:path")', bindings: [] })
    expect(imported.error?.kind).toBe('exception')
    expect(imported.error?.message).toContain('dynamic import callback')
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: 'keptBeforeImportFailure', bindings: [] })).value).toBe('v1')
  })

  it('rejects a namespace that names a backend-owned global', async () => {
    const realm = createRealm()
    await expect(realm.run({ program: '1', bindings: [{ global: 'console', functions: {} }] }))
      .rejects.toThrow('reserved binding global')
  })

  it('rejects a namespace with no functions record instead of throwing synchronously', async () => {
    const realm = createRealm()
    const pending = realm.run({ program: '1', bindings: [{ global: 'tools' } as CodeBindingNamespace] })
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
      program: `
        let hostileRejection = 'resolved'
        try { await globalThis.tools.boom({}) } catch (error) { hostileRejection = 'rejected: ' + typeof error.message }
        hostileRejection
      `,
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
      program: 'await globalThis.tools.wait({})\n"never"',
      bindings: [tools({ wait: () => gate.promise })],
    })
    await sleep(30)
    await realm.dispose()

    expect((await pending).error).toEqual({ kind: 'abort', message: 'realm disposed' })
    await expect(realm.run({ program: '1', bindings: [] })).rejects.toThrow('after disposal')
    expect(realm.idle).toBe(true)
  })

  it('renders an abort reason whose toString throws, on both the queued and the active path', async () => {
    const realm = createRealm()
    const hostile = { toString(): string { throw new Error('no string') } }

    const preAborted = new AbortController()
    preAborted.abort(hostile)
    const queued = await realm.run({ program: '1', bindings: [], signal: preAborted.signal })
    expect(queued.error).toEqual({ kind: 'abort', message: 'aborted' })

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
    await realm.run({ program: '"ok"', bindings: [] })
    expect(realm.idle).toBe(true)
    expect(realm.lastUsedAt).toBeGreaterThan(before)
  })

  it('lets a headless host exit while idle and wakes the same worker for later queued cells', async () => {
    // This child cannot inherit Vitest's TypeScript resolver; `npm test` builds
    // the package before the suite, so exercise the exact emitted headless path.
    const realmModule = new URL('../lib/realm/realm.js', import.meta.url).href
    const stdout = await runHeadlessProbe(`
      import { PersistentRealm } from ${JSON.stringify(realmModule)}
      const realm = new PersistentRealm({
        realmId: 'headless-idle-lifecycle',
        budgets: { computeMs: 5_000, maxWallMs: 10_000, maxOutputBytes: 65_536, maxOldGenerationSizeMb: 128 },
      })
      const seeded = await realm.run({ program: 'const retainedForHeadless = 41; retainedForHeadless', bindings: [] })
      await new Promise(resolve => setTimeout(resolve, 50))
      const active = realm.run({
        program: 'await new Promise(resolve => setTimeout(resolve, 100)); retainedForHeadless',
        bindings: [],
      })
      const queued = realm.run({ program: 'retainedForHeadless + 1', bindings: [] })
      const [activeResult, queuedResult] = await Promise.all([active, queued])
      console.log(JSON.stringify({ seed: seeded.value, active: activeResult.value, queued: queuedResult.value }))
      // Deliberately do not dispose: an idle persistent Worker must not own the
      // lifetime of a completed headless invocation.
    `)
    expect(JSON.parse(stdout.trim())).toEqual({ seed: 41, active: 41, queued: 42 })
  })
})

describe('hostile program code', () => {
  it('keeps the control channel out of reach when the program patches MessagePort.prototype', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const { MessageChannel, MessagePort } = process.getBuiltinModule('node:worker_threads')
        let interceptedPorts = 0
        let capturedPort
        const originalPostMessage = MessagePort.prototype.postMessage
        MessagePort.prototype.postMessage = function (...args) {
          interceptedPorts += 1
          capturedPort = this
          return Reflect.apply(originalPostMessage, this, args)
        }
        const ownChannel = new MessageChannel()
        ownChannel.port1.postMessage('own port')
        ownChannel.port1.close()
        ownChannel.port2.close()
        const echoedThroughPrivatePort = await globalThis.tools.echo({ ping: true })
        console.log('a log line');
        ({ interceptedPorts, echoedThroughPrivatePort, capturedOwnPort: capturedPort === ownChannel.port1 })
      `,
      bindings: [tools({ echo: async args => args as CodeJsonValue })],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({
      interceptedPorts: 1,
      echoedThroughPrivatePort: { ping: true },
      capturedOwnPort: true,
    })
    expect(result.logs).toContain('a log line')
  })

  it('cannot settle its own run through the ambient parentPort', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const { parentPort } = process.getBuiltinModule('node:worker_threads')
        parentPort?.postMessage({ type: 'done', runId: 1, nonce: 'guessed', json: '"forged"' })
        await new Promise(resolve => setTimeout(resolve, 40))
        'real completion'
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('real completion')
  })

  it('cancels a promise-based timer left behind by a settled cell', async () => {
    const realm = createRealm()
    const armed = await realm.run({
      program: `
        const promiseTimers = process.getBuiltinModule('node:timers/promises')
        const promiseTimerMarks = []
        promiseTimers.setTimeout(150, 'late').then(() => { promiseTimerMarks.push('ran') }).catch(() => {})
        'armed'
      `,
      bindings: [],
    })
    expect(armed.value).toBe('armed')

    await sleep(300)
    expect((await realm.run({ program: 'promiseTimerMarks', bindings: [] })).value).toEqual([])
  })

  it('still honors a promise-based timer awaited inside its own cell', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const promiseTimers = process.getBuiltinModule('node:timers/promises')
        const promiseTimerStarted = Date.now()
        await promiseTimers.setTimeout(40)
        Date.now() - promiseTimerStarted >= 30
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(true)
  })

  it('rejects control-port enumeration and runtime module-loader entry points', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const runtimeCapabilityAttacks = [
          () => process._getActiveHandles(),
          () => process._getActiveRequests(),
          () => process.getBuiltinModule('node:async_hooks'),
          () => process.getBuiltinModule('node:module'),
          () => process.getBuiltinModule('node:inspector'),
          () => process.getBuiltinModule('node:inspector/promises'),
          () => process.binding('inspector'),
        ]
        const controlledRejections = []
        for (const attack of runtimeCapabilityAttacks) {
          try {
            attack()
            controlledRejections.push(false)
          } catch (error) {
            controlledRejections.push(error instanceof Error && error.message.includes('disabled'))
          }
        }
        controlledRejections
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual([true, true, true, true, true, true, true])
    expect(realm.generation).toBe(1)
    expect((await realm.run({ program: '21 * 2', bindings: [] })).value).toBe(42)
  })

  it('keeps tools, timers and later cells isolated from collection prototype hooks', async () => {
    const realm = createRealm()
    const attacked = await realm.run({
      program: `
        let runtimePrototypeHookCalls = 0
        const runtimePrototypeHooks = [
          [Map.prototype, 'clear'],
          [Map.prototype, 'delete'],
          [Map.prototype, 'forEach'],
          [Map.prototype, 'get'],
          [Map.prototype, 'set'],
          [Set.prototype, 'add'],
          [Set.prototype, 'clear'],
          [Set.prototype, 'delete'],
          [Set.prototype, 'forEach'],
          [Set.prototype, 'has'],
          [Array.prototype, 'push'],
          [Array.prototype, Symbol.iterator],
        ]
        const runtimePrototypeDescriptors = new Array(runtimePrototypeHooks.length)
        for (let index = 0; index < runtimePrototypeHooks.length; index++) {
          const target = runtimePrototypeHooks[index][0]
          const key = runtimePrototypeHooks[index][1]
          const descriptor = Object.getOwnPropertyDescriptor(target, key)
          const original = descriptor.value
          runtimePrototypeDescriptors[index] = descriptor
          Object.defineProperty(target, key, {
            ...descriptor,
            value: function (...args) {
              runtimePrototypeHookCalls += 1
              return Reflect.apply(original, this, args)
            },
          })
        }

        const hookedEcho = await globalThis.tools.echo({ answer: 41 })
        const promiseTimers = process.getBuiltinModule('node:timers/promises')
        const callerController = new AbortController()
        const hookedTimerValue = await promiseTimers.setTimeout(20, 'timer', { signal: callerController.signal })
        ;({ hookedEcho, hookedTimerValue, completion: 42, hookCalls: runtimePrototypeHookCalls })
      `,
      bindings: [tools({ echo: async args => args })],
    })
    expect(attacked.error).toBeUndefined()
    expect(attacked.value).toEqual({
      hookedEcho: { answer: 41 },
      hookedTimerValue: 'timer',
      completion: 42,
      hookCalls: 0,
    })

    const next = await realm.run({
      program: `
        const hookCallsAfterSettlement = runtimePrototypeHookCalls
        for (let index = 0; index < runtimePrototypeHooks.length; index++) {
          Object.defineProperty(
            runtimePrototypeHooks[index][0],
            runtimePrototypeHooks[index][1],
            runtimePrototypeDescriptors[index],
          )
        }
        ({ nextCell: 21 * 2, hookCalls: hookCallsAfterSettlement })
      `,
      bindings: [],
    })
    expect(next.error).toBeUndefined()
    expect(next.value).toEqual({ nextCell: 42, hookCalls: 0 })
    expect(realm.generation).toBe(1)
  })

  it('keeps Inspector requests working after prototype-hook attacks are rejected', async () => {
    const realm = createRealm()
    const attacked = await realm.run({
      program: `
        const rejectedPrototypeAttacks = []
        const prototypeAttacks = [
          () => Object.defineProperty(Object.prototype, 'toJSON', { value() { return null } }),
          () => Object.defineProperty(Array.prototype, 'toJSON', { value() { return null } }),
          () => Object.defineProperty(Object.prototype, 'params', { set() {} }),
          () => Object.defineProperty(Object.prototype, 'params', { writable: false }),
          () => { Object.prototype.params = { forged: true } },
        ]
        for (const attack of prototypeAttacks) {
          try { attack(); rejectedPrototypeAttacks.push(false) } catch { rejectedPrototypeAttacks.push(true) }
        }
        rejectedPrototypeAttacks
      `,
      bindings: [],
    })
    expect(attacked.value).toEqual([true, true, true, true, true])
    expect((await realm.run({ program: '21 * 2', bindings: [] })).value).toBe(42)
  })

  it('snapshots arrays through captured intrinsics when a getter patches Array.prototype.push', async () => {
    const realm = createRealm()
    const result = await realm.run({
      program: `
        const originalArrayPush = Array.prototype.push
        const hostileArrayGetter = {}
        Object.defineProperty(hostileArrayGetter, 'values', {
          enumerable: true,
          get() {
            Array.prototype.push = () => 0
            queueMicrotask(() => { Array.prototype.push = originalArrayPush })
            return [2]
          },
        })
        hostileArrayGetter
      `,
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ values: [2] })
  })

  it('captures direct process stream output in the run that wrote it', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: 'process.stdout.write("direct output")\n"wrote"',
      bindings: [],
    })
    expect(first.value).toBe('wrote')
    expect(first.logs).toContain('direct output')

    const second = await realm.run({ program: 'console.log("second run output")\n"second"', bindings: [] })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe('second')
    expect(second.logs).toEqual(['second run output'])
  })

  it('charges output that bypasses the patched write method to the cell that wrote it', async () => {
    const realm = createRealm()
    const first = await realm.run({
      program: `
        const { Writable } = process.getBuiltinModule('node:stream')
        for (let index = 0; index < 40; index++) {
          Writable.prototype.write.call(process.stdout, 'STRAY-MARKER-' + index)
        }
        'wrote'
      `,
      bindings: [],
    })
    expect(first.value).toBe('wrote')
    expect(first.logs.filter(line => line.includes('STRAY-MARKER'))).toHaveLength(40)

    const second = await realm.run({ program: 'console.log("second run output")\n"second"', bindings: [] })
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
        'never'
      `,
      bindings: [],
    })
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('realm worker failed outside the program')
    expect(result.error?.message).not.toContain('/host/secret')
  })
})
