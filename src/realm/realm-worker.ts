/**
 * Long-lived realm worker: one V8 isolate per realm generation that owns a
 * REPL namespace surviving across cells, executes at most one program at a
 * time, and leases binding members only for the duration of the run that
 * declared them.
 *
 * This module boots as a bare Node worker — no bundler, no path aliases, an
 * empty environment and `execArgv: []` — so it may only import Node builtins
 * and TYPE-ONLY declarations. Intrinsics are captured at load, before any model
 * code can reassign a global.
 * @module dsh-prime-agent/realm/realm-worker
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Runtime } from 'node:inspector'
import { Session as InspectorSession } from 'node:inspector/promises'
import { createRequire } from 'node:module'
import { inspect } from 'node:util'
import { workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import type {
  HostToRealm,
  RealmCompletionHistoryLimits,
  RealmNamespaceSpec,
  RealmProgramFailure,
  RealmToHost,
} from './protocol.js'

const CapturedAbortController = AbortController
const CapturedAbortSignal = AbortSignal
const CapturedError = Error
const CapturedMap = Map
const CapturedSet = Set
const capturedAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const capturedAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const capturedAbortSignalAny = AbortSignal.any
const capturedArrayPush = Array.prototype.push
const capturedArraySplice = Array.prototype.splice
const capturedArrayIsArray = Array.isArray
const capturedBufferByteLength = Buffer.byteLength
const capturedJsonParse = JSON.parse
const capturedJsonStringify = JSON.stringify
const capturedMapClear = Map.prototype.clear
const capturedMapDelete = Map.prototype.delete
const capturedMapForEach = Map.prototype.forEach
const capturedMapGet = Map.prototype.get
const capturedMapSet = Map.prototype.set
const capturedNumberIsFinite = Number.isFinite
const capturedNumberIsSafeInteger = Number.isSafeInteger
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty
const capturedObjectFreeze = Object.freeze
const capturedObjectGetPrototypeOf = Object.getPrototypeOf
const capturedObjectHasOwn = Object.hasOwn
const capturedObjectIs = Object.is
const capturedObjectPrototype = Object.prototype
const capturedPropertyIsEnumerable = Object.prototype.propertyIsEnumerable
const capturedReflectApply = Reflect.apply
const capturedReflectDeleteProperty = Reflect.deleteProperty
const capturedReflectOwnKeys = Reflect.ownKeys
const capturedSetAdd = Set.prototype.add
const capturedSetClear = Set.prototype.clear
const capturedSetDelete = Set.prototype.delete
const capturedSetForEach = Set.prototype.forEach
const capturedSetHas = Set.prototype.has
const capturedStringSlice = String.prototype.slice
const capturedStringStartsWith = String.prototype.startsWith
const capturedSymbolIterator = Symbol.iterator

/**
 * Mirrors `HIDDEN_BINDING_MEMBER` in `./protocol.ts`, which this module cannot
 * import at runtime. Defense in depth: the host already filters the name out of
 * every namespace declaration it sends.
 */
const HIDDEN_BINDING_MEMBER = 'prime_realm_identity'

/** Bounded inspect options, so a pathological value cannot explode the rendering. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const

/** The five console methods the shim captures. */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const

const boot = (workerData ?? {}) as { port?: MessagePort }
const bootPort = boot.port
if (!bootPort) throw new CapturedError('dsh-prime-agent: realm worker started without its private control port')
// Model code can read `workerData` through node:worker_threads. Drop the
// reference so the private control channel stays out of the program's reach;
// the ambient `parentPort` it CAN reach is not wired to anything host-side.
delete boot.port
const port = bootPort

/**
 * The port's OWN `postMessage`, taken off its prototype at load. Model code runs
 * in this isolate and can reassign `MessagePort.prototype.postMessage`; a
 * dynamic `port.postMessage(...)` would then invoke the program's function with
 * `this` bound to the private control port, handing it the channel. From there
 * it could forge `call` messages to reach revoked bindings and forge `done` to
 * settle a run early — defeating both the lease and the one-run-at-a-time
 * invariant. Reading the method through the captured `getPrototypeOf` before any
 * program has run is what keeps the channel ours.
 */
const capturedPostMessage = (capturedObjectGetPrototypeOf(port) as { postMessage: (message: unknown) => void }).postMessage

/** Install one immutable program-visible global owned by the runtime. */
function installReadonlyGlobal(name: string, value: unknown): void {
  capturedObjectDefineProperty(globalThis, name, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  })
}

// Inspector's own request serializer uses ordinary objects and arrays. An
// inherited `toJSON` can therefore rewrite the command before V8 sees it. Lock
// the two absent hooks before any model code runs. Session.post assigns
// `message.params` after creating its request object, so the fixed inherited
// accessor materializes that own data property. The model cannot replace the
// non-configurable setter or freeze a writable inherited data slot underneath
// the Inspector.
capturedObjectDefineProperty(capturedObjectPrototype, 'toJSON', {
  value: undefined,
  enumerable: false,
  writable: false,
  configurable: false,
})
capturedObjectDefineProperty(Array.prototype, 'toJSON', {
  value: undefined,
  enumerable: false,
  writable: false,
  configurable: false,
})
capturedObjectDefineProperty(capturedObjectPrototype, 'params', {
  get: (): undefined => undefined,
  set(this: object, value: unknown): void {
    capturedObjectDefineProperty(this, 'params', {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  },
  enumerable: false,
  configurable: false,
})

const capturedGetBuiltinModule = process.getBuiltinModule

/** Prevent a cell from recovering the runtime Inspector or a module loader. */
function restrictedGetBuiltinModule(id: string): object | undefined {
  const normalized = capturedReflectApply(capturedStringStartsWith, id, ['node:'])
    ? capturedReflectApply(capturedStringSlice, id, ['node:'.length]) as string
    : id
  if (normalized === 'module' || normalized === 'async_hooks' || normalized === 'inspector'
    || capturedReflectApply(capturedStringStartsWith, normalized, ['inspector/'])) {
    throw new CapturedError(`program access to ${capturedJsonStringify(id)} is disabled`)
  }
  return capturedReflectApply(capturedGetBuiltinModule, process, [id]) as object | undefined
}

capturedObjectDefineProperty(process, 'getBuiltinModule', {
  value: restrictedGetBuiltinModule,
  enumerable: false,
  writable: false,
  configurable: false,
})
capturedObjectDefineProperty(process, 'binding', {
  value: (): never => { throw new CapturedError('process.binding is disabled in the persistent realm') },
  enumerable: false,
  writable: false,
  configurable: false,
})
for (const name of ['_getActiveHandles', '_getActiveRequests'] as const) {
  capturedObjectDefineProperty(process, name, {
    value: (): never => { throw new CapturedError(`${name} is disabled in the persistent realm`) },
    enumerable: false,
    writable: false,
    configurable: false,
  })
}

/** Constructor type for one program-visible binding rejection class. */
type BindingErrorConstructor = new (memberName: string, message: string) => Error

/** One namespace's cross-run identity: the same proxy and wrappers every run. */
interface NamespaceHandle {
  global: string
  proxy: object
  wrappers: Map<string, (args: unknown) => Promise<unknown>>
  /** Members leased for the CURRENT run; emptied the moment a run settles. */
  allowed: Set<string>
  errorClass: BindingErrorConstructor | undefined
}

/** One parked binding call, settled by the host's reply. */
interface PendingCall {
  resolve: (value: unknown) => void
  reject: (message: string) => void
}

/** The single run in flight, if any. */
interface ActiveRun {
  id: number
  /** The host's single-use secret for this run; quoted on every outbound message. */
  nonce: string
  /**
   * The completion handle the host reserved for this run, spent only if the run
   * completes with a value that opens a NEW history slot.
   */
  completionId: number
  logs: LogBuffer
  pending: Map<number, PendingCall>
  nextCallId: number
  timers: { clear: (handle: unknown) => void; handle: unknown }[]
  /**
   * Aborted at settlement, cancelling the promise-based timers this run armed.
   * Those yield no handle to clear, so a signal is the only cancellation seam
   * `node:timers/promises` offers.
   */
  cancel: AbortController
}

const handles = new CapturedMap<string, NamespaceHandle>()
const errorClasses = new CapturedMap<string, BindingErrorConstructor>()
const runContext = new AsyncLocalStorage<number>()
let active: ActiveRun | undefined

/** Post one control message, tolerating a host that already closed the port. */
function post(message: RealmToHost): void {
  try {
    capturedReflectApply(capturedPostMessage, port, [message])
  } catch {
    // The host tore the realm down; there is nobody left to report to.
  }
}

/**
 * The run id whose lease is currently valid for the CALLER, or `undefined`.
 * Both an active run and a caller whose async context belongs to that run are
 * required, so a detached continuation armed by an earlier run cannot borrow
 * the current run's lease.
 */
function leasedRunId(): number | undefined {
  const run = active
  if (run === undefined) return undefined
  return capturedReflectApply(capturedAsyncLocalStorageGetStore, runContext, []) === run.id ? run.id : undefined
}

/** Ordered per-run text capture under the run's share of the outer output cap. */
class LogBuffer {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0
  private limited = false
  private readonly maxBytes: number
  private readonly runId: number
  private readonly nonce: string

  constructor(maxBytes: number, runId: number, nonce: string) {
    this.maxBytes = maxBytes
    this.runId = runId
    this.nonce = nonce
  }

  /** Stream one captured line to the host, or report the cap once and go quiet. */
  push(text: string): void {
    if (this.limited) return
    const separatorBytes = this.entries > 0 ? 1 : 0
    const cost = capturedBufferByteLength(capturedJsonStringify(text), 'utf8') + separatorBytes
    if (this.bytes + cost > this.maxBytes) {
      this.limited = true
      post({ type: 'output-limit', runId: this.runId, nonce: this.nonce })
      return
    }
    this.bytes += cost
    this.entries += 1
    post({ type: 'log', runId: this.runId, nonce: this.nonce, text })
  }

  /** Exact bytes left for this run's completion value or failure message. */
  remaining(): number {
    return this.maxBytes - this.bytes
  }
}

/**
 * Capture one rendered line for the run that produced it. Output emitted after
 * its own run's lease was revoked is DISCARDED rather than attributed to
 * whichever run happens to be active.
 */
function emit(text: string): void {
  const run = active
  if (run === undefined || leasedRunId() === undefined) return
  run.logs.push(text)
}

/** Render console arguments the way Node's console would, closely enough for a model to recognize. */
function render(args: unknown[]): string {
  let line = ''
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    line += (index > 0 ? ' ' : '') + (typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS))
  }
  return line
}

const consoleShim = capturedObjectCreate(null) as Record<string, (...args: unknown[]) => void>
for (const level of CONSOLE_LEVELS) {
  consoleShim[level] = (...args: unknown[]): void => { emit(render(args)) }
}
installReadonlyGlobal('console', consoleShim)

/** One writable stream as far as this module needs to reshape it. */
interface CapturableStream {
  write: (chunk: unknown, ...rest: unknown[]) => boolean
  _write: (chunk: unknown, encoding: unknown, callback: (error?: Error | null) => void) => void
  _writev?: (chunks: { chunk: unknown }[], callback: (error?: Error | null) => void) => void
}

/** Render one written chunk the way the stream would have delivered it. */
function chunkText(chunk: unknown): string {
  return typeof chunk === 'string' ? chunk : String(chunk)
}

/**
 * Redirect a stream into the run's capture, preserving Node's callback contract.
 *
 * BOTH levels are replaced. The public `write` is the fast path every ordinary
 * `console.log` and `process.stdout.write` takes. The `_write`/`_writev` hooks
 * are what `Writable.prototype.write.call(process.stdout, ...)` reaches — a call
 * that deliberately steps over the own-property `write` above. Left alone, that
 * bypass reaches the worker's real forwarding and the bytes surface on the host's
 * native pipe, where nothing identifies which run wrote them: the pipe carries no
 * run id and routinely delivers long after the control channel said the run was
 * done, so the host would have to charge them to whichever run came next.
 * Capturing at the hook keeps the attribution question from ever arising.
 */
function captureStreamWrites(stream: CapturableStream): void {
  stream.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    emit(chunkText(chunk))
    const callback = typeof rest[0] === 'function'
      ? rest[0] as (error?: Error | null) => void
      : typeof rest[1] === 'function' ? rest[1] as (error?: Error | null) => void : undefined
    if (callback) queueMicrotask(() => { callback(null) })
    return true
  }
  stream._write = (chunk: unknown, _encoding: unknown, callback: (error?: Error | null) => void): void => {
    emit(chunkText(chunk))
    callback(null)
  }
  stream._writev = (chunks: { chunk: unknown }[], callback: (error?: Error | null) => void): void => {
    for (let index = 0; index < chunks.length; index++) emit(chunkText((chunks[index] as { chunk: unknown }).chunk))
    callback(null)
  }
}
captureStreamWrites(process.stdout as unknown as CapturableStream)
captureStreamWrites(process.stderr as unknown as CapturableStream)

/**
 * The `node:timers` exports object. Its ESM namespace is derived from it, so
 * patching it here — before anything imports the module — is what makes
 * `import('node:timers').setTimeout` reach the wrapper too, instead of handing
 * the program an untracked factory beside the patched global.
 */
const timersModule = createRequire(import.meta.url)('node:timers') as Record<string, unknown>

/**
 * Wrap one timer factory so every handle it hands the program is tracked
 * against the run that created it and cleared before that run settles.
 * `queueMicrotask` is deliberately unwrapped: it yields no handle to clear, and
 * its callbacks drain within the run that queued them.
 */
function wrapTimerFactory(factoryName: string, clearName: string): void {
  const globals = globalThis as unknown as Record<string, unknown>
  const create = globals[factoryName] as (...args: unknown[]) => unknown
  const clear = globals[clearName] as (handle: unknown) => void
  const wrapper = (...args: unknown[]): unknown => {
    const handle = capturedReflectApply(create, undefined, args)
    const run = active
    if (run !== undefined) capturedReflectApply(capturedArrayPush, run.timers, [{ clear, handle }])
    return handle
  }
  globals[factoryName] = wrapper
  timersModule[factoryName] = wrapper
}
wrapTimerFactory('setTimeout', 'clearTimeout')
wrapTimerFactory('setInterval', 'clearInterval')
wrapTimerFactory('setImmediate', 'clearImmediate')

/**
 * The `node:timers/promises` exports object, patched for the same reason as the
 * callback module: its timers hand back a promise rather than a handle, so the
 * only cancellation seam they offer is an `AbortSignal`, and without one a
 * program could park a continuation there and wake up inside somebody else's
 * run.
 *
 * This is best effort, not a closed door. The roadmap already declares detached
 * detached async work unsupported precisely because the set of ways an isolate
 * can schedule future work is not enumerable — `AbortSignal.timeout`,
 * `fs.watch`, sockets, and native addons all schedule outside anything patched
 * here. What the lease enforces unconditionally is the part that matters: a
 * continuation waking up late cannot call a tool or emit a log, whatever woke it.
 */
const promiseTimersModule = createRequire(import.meta.url)('node:timers/promises') as Record<string, unknown>

/** A two-signal array whose iteration never consults mutable Array prototypes. */
function ownedSignalPair(first: AbortSignal, second: AbortSignal): AbortSignal[] {
  const signals = [first, second]
  capturedObjectDefineProperty(signals, capturedSymbolIterator, {
    value: (): Iterator<AbortSignal> => {
      let index = 0
      const iterator = capturedObjectCreate(null) as Iterator<AbortSignal>
      capturedObjectDefineProperty(iterator, 'next', {
        value: (): IteratorResult<AbortSignal> => {
          if (index === 0) {
            index = 1
            return { value: first, done: false }
          }
          if (index === 1) {
            index = 2
            return { value: second, done: false }
          }
          return { value: undefined, done: true }
        },
      })
      return iterator
    },
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return signals
}

/** The current run's cancellation signal merged with whatever the caller passed. */
function runCancellation(supplied: unknown): AbortSignal | undefined {
  const run = active
  const callerSignal = supplied instanceof CapturedAbortSignal ? supplied : undefined
  if (run === undefined) return callerSignal
  return callerSignal ? capturedAbortSignalAny(ownedSignalPair(run.cancel.signal, callerSignal)) : run.cancel.signal
}

/**
 * Wrap one promise-timer factory so the run that armed it also owns cancelling
 * it. The options bag is the last documented parameter of each factory, so the
 * wrapper rebuilds it at that position rather than guessing from arity.
 */
function wrapPromiseTimer(factoryName: string, optionsIndex: number): void {
  const create = promiseTimersModule[factoryName]
  if (typeof create !== 'function') return
  const original = create as (...args: unknown[]) => unknown
  promiseTimersModule[factoryName] = (...args: unknown[]): unknown => {
    const supplied = args[optionsIndex]
    const options = typeof supplied === 'object' && supplied !== null ? { ...supplied } : {}
    const signal = runCancellation((options as { signal?: unknown }).signal)
    // Padded to the options position: called as `setTimeout(50)`, the bag would
    // otherwise land in the value slot.
    while (args.length < optionsIndex) capturedReflectApply(capturedArrayPush, args, [undefined])
    args[optionsIndex] = { ...options, ...signal ? { signal } : {} }
    return capturedReflectApply(original, undefined, args)
  }
}
wrapPromiseTimer('setTimeout', 2)
wrapPromiseTimer('setInterval', 2)
wrapPromiseTimer('setImmediate', 1)

// `scheduler.wait` is `setTimeout` under another name, so it gets the same
// treatment; `scheduler.yield` resolves within the run that called it.
const scheduler = promiseTimersModule.scheduler
if (typeof scheduler === 'object' && scheduler !== null) {
  const wait = (scheduler as Record<string, unknown>).wait
  if (typeof wait === 'function') {
    const originalWait = wait as (...args: unknown[]) => unknown
    ;(scheduler as Record<string, unknown>).wait = (...args: unknown[]): unknown => {
      const supplied = args[1]
      const options = typeof supplied === 'object' && supplied !== null ? { ...supplied } : {}
      const signal = runCancellation((options as { signal?: unknown }).signal)
      args[1] = { ...options, ...signal ? { signal } : {} }
      return capturedReflectApply(originalWait, undefined, args)
    }
  }
}

/**
 * A detached rejection must not cost the realm its heap. The lease mechanism
 * MANUFACTURES these: a continuation an earlier run left behind is refused with
 * an explicit rejection, and by construction nobody is awaiting it. Node's
 * default would kill the worker, so a program that armed one detached call
 * would destroy the state of whichever run happens to be in flight when it
 * resolves. The rejection already reached the program as a failed call; here it
 * is only reported, and only to the run that actually produced it.
 */
process.on('unhandledRejection', () => {
  // Discarded, not captured: Node emits this outside the rejecting promise's
  // async context, so there is no trustworthy run to attribute it to, and
  // charging it to whichever run is active would put one run's detached failure
  // in another run's logs. The program already saw the rejection at its own
  // call site; what matters here is only that it is not fatal.
})

/** Define one public binding-error field without consulting mutable descriptor prototypes. */
function defineBindingErrorField(error: Error, key: string, value: string): void {
  const attributes = capturedObjectCreate(null) as PropertyDescriptor
  attributes.enumerable = true
  attributes.value = value
  capturedObjectDefineProperty(error, key, attributes)
}

/**
 * Materialize one namespace's rejection class, cached across runs so a
 * constructor captured by a retained binding keeps its identity.
 */
function ensureErrorClass(descriptor: { name: string; memberNameProperty: string }): BindingErrorConstructor {
  // A JSON pair, not a delimiter-joined string: no member name can forge a
  // collision with a different class name.
  const cacheKey = capturedJsonStringify([descriptor.name, descriptor.memberNameProperty])
  const cached = capturedReflectApply(capturedMapGet, errorClasses, [cacheKey]) as BindingErrorConstructor | undefined
  if (cached) return cached
  const created = class BindingCallError extends CapturedError {
    constructor(memberName: string, message: string) {
      super(message)
      defineBindingErrorField(this, 'name', descriptor.name)
      defineBindingErrorField(this, descriptor.memberNameProperty, memberName)
    }
  }
  installReadonlyGlobal(descriptor.name, created)
  capturedReflectApply(capturedMapSet, errorClasses, [cacheKey, created])
  return created
}

/** Build the namespace-specific rejection for one refused or failed binding call. */
function bindingFailure(handle: NamespaceHandle, name: string, message: string): Error {
  const errorClass = handle.errorClass
  return errorClass ? new errorClass(name, message) : new CapturedError(message)
}

/**
 * The stable wrapper for one member name: created once per namespace and reused
 * forever, so a retained closure still resolves to the CURRENT run's host
 * implementation on a later run.
 */
function wrapperFor(handle: NamespaceHandle, name: string): (args: unknown) => Promise<unknown> {
  const cached = capturedReflectApply(capturedMapGet, handle.wrappers, [name]) as ((args: unknown) => Promise<unknown>) | undefined
  if (cached) return cached
  const wrapper = (args: unknown): Promise<unknown> => callBinding(handle, name, args)
  capturedReflectApply(capturedMapSet, handle.wrappers, [name, wrapper])
  return wrapper
}

/** Validate the lease at CALL time, then bridge one call over the private port. */
function callBinding(handle: NamespaceHandle, name: string, args: unknown): Promise<unknown> {
  const runId = leasedRunId()
  if (runId === undefined) {
    return Promise.reject(bindingFailure(handle, name, `tool lease revoked for ${handle.global}.${name}: it is not callable outside its own run`))
  }
  if (!capturedReflectApply(capturedSetHas, handle.allowed, [name])) {
    return Promise.reject(bindingFailure(handle, name, `unknown binding ${capturedJsonStringify(`${handle.global}.${name}`)}`))
  }
  const run = active as ActiveRun
  let json: string
  try {
    json = capturedJsonStringify(snapshotJson(args))
  } catch {
    return Promise.reject(bindingFailure(handle, name, 'binding arguments must be lossless JSON'))
  }
  return new Promise<unknown>((resolve, reject) => {
    const id = run.nextCallId++
    capturedReflectApply(capturedMapSet, run.pending, [id, {
      resolve,
      reject: (message: string) => { reject(bindingFailure(handle, name, message)) },
    }])
    post({ type: 'call', runId, nonce: run.nonce, id, global: handle.global, name, json })
  })
}

/**
 * The cross-run proxy for one namespace global. Its identity never changes, so
 * a closure the program persisted keeps working; what changes each run is the
 * leased member set behind it.
 */
function ensureHandle(global: string): NamespaceHandle {
  const cached = capturedReflectApply(capturedMapGet, handles, [global]) as NamespaceHandle | undefined
  if (cached) return cached
  const target = capturedObjectCreate(null) as object
  const handle: NamespaceHandle = {
    global,
    proxy: target,
    wrappers: new CapturedMap<string, (args: unknown) => Promise<unknown>>(),
    allowed: new CapturedSet<string>(),
    errorClass: undefined,
  }
  handle.proxy = new Proxy(target, {
    get: (_target, property) => typeof property === 'string' && capturedReflectApply(capturedSetHas, handle.allowed, [property])
      ? wrapperFor(handle, property)
      : undefined,
    has: (_target, property) => typeof property === 'string' && capturedReflectApply(capturedSetHas, handle.allowed, [property]),
    ownKeys: () => {
      const names: string[] = []
      capturedReflectApply(capturedSetForEach, handle.allowed, [(name: string) => {
        capturedReflectApply(capturedArrayPush, names, [name])
      }])
      return names
    },
    getOwnPropertyDescriptor: (_target, property) => typeof property === 'string'
      && capturedReflectApply(capturedSetHas, handle.allowed, [property])
      ? { value: wrapperFor(handle, property), enumerable: true, configurable: true, writable: false }
      : undefined,
    getPrototypeOf: () => null,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  })
  installReadonlyGlobal(global, handle.proxy)
  capturedReflectApply(capturedMapSet, handles, [global, handle])
  return handle
}

/** Install exactly this run's lease across every namespace the realm has ever seen. */
function installNamespaces(specs: RealmNamespaceSpec[]): void {
  capturedReflectApply(capturedMapForEach, handles, [(handle: NamespaceHandle) => {
    capturedReflectApply(capturedSetClear, handle.allowed, [])
    handle.errorClass = undefined
  }])
  for (let specIndex = 0; specIndex < specs.length; specIndex++) {
    const spec = specs[specIndex] as RealmNamespaceSpec
    const handle = ensureHandle(spec.global)
    for (let nameIndex = 0; nameIndex < spec.names.length; nameIndex++) {
      const name = spec.names[nameIndex] as string
      if (name === HIDDEN_BINDING_MEMBER) continue
      capturedReflectApply(capturedSetAdd, handle.allowed, [name])
    }
    handle.errorClass = spec.errorClass ? ensureErrorClass(spec.errorClass) : undefined
  }
}

/** Revoke every lease. Called before a run's terminal message reaches the host. */
function revokeLeases(): void {
  capturedReflectApply(capturedMapForEach, handles, [(handle: NamespaceHandle) => {
    capturedReflectApply(capturedSetClear, handle.allowed, [])
  }])
}

/**
 * Bookkeeping the capture walk fills in as it goes.
 *
 * Everything here is gathered during the SINGLE traversal that already builds
 * the boundary snapshot. A second pass is not an option: the walk reads program
 * getters, so re-walking would fire their side effects twice and a getter that
 * threw on the second pass would turn an already-successful run into a failure.
 * The same rule covers key enumeration — a dictionary-mode object has no cheap
 * "first N keys" path (`Object.keys().slice` costs 857 ms on a 64 MiB wide
 * object, `docs/plan/phase0-bench-results.zh.md` §3.7), so the sample below is
 * taken from the enumeration the walk performs anyway.
 */
interface CaptureStats {
  /** Every value visited, containers and leaves alike. */
  nodes: number
  nodeLimit: number
  /**
   * Set the moment the walk crosses `nodeLimit`, which permanently disqualifies
   * the value from the history.
   *
   * What is true TODAY: the flag is written during the walk, read only after it
   * finishes, and the walk always runs to completion. Phase 1 therefore does NOT
   * avoid the expansion — it only avoids being fooled by it. Writing the flag
   * inline rather than deriving it from a finished snapshot is groundwork for
   * Phase 2, and it is also the only way the answer can be right: `seen` is a
   * path set (deleted on exit below) that refuses cycles without recognizing
   * sharing, so a few KiB of live DAG expands into tens of millions of nodes at
   * the boundary (§3.8) and a post-hoc count would be a count of the
   * amplification rather than of the value.
   *
   * Do NOT turn this into an early exit while Phase 1's wire contract stands.
   * The full JSON is still what crosses, and a value can blow the node budget
   * while its serialization fits `maxOutputBytes` with room to spare; abandoning
   * the walk would abandon that serialization too, so a cell that succeeds today
   * would start failing with `invalid-output` — a model-visible regression, not
   * an internal one. Guarded by "refuses a shared subgraph whose expansion the
   * walk counted, without abandoning the walk" in
   * `tests/completion-history.spec.ts`. Phase 2, which projects a large
   * completion instead of serializing it, is where the early return becomes
   * correct.
   *
   * Nothing in the walk READS this flag, and nothing may start to: the sampling
   * below has to survive it intact. Phase 1 gets away with that for free, since
   * a value tripping the flag is refused outright and its stats are discarded
   * with it — but Phase 2 must still PROJECT a value it refuses to retain, and
   * that projection needs this walk's key sample. A "stop collecting once the
   * budget is blown" shortcut would leave exactly the oversized values that need
   * a projection without the material to build one, and re-enumerating keys is
   * the one thing the benchmark rules out (§3.7). Guarded from Phase 2 onwards
   * by the first Phase 2 acceptance item in the plan: the projector must produce
   * an envelope carrying a key sample for a value that tripped this flag.
   */
  overNodeLimit: boolean
  /** Container nesting, so root metadata can be taken without a second look. */
  depth: number
  /**
   * Own key total of a root OBJECT, and the first `ROOT_KEY_SAMPLE` of its keys.
   *
   * Only the count reaches a slot; the sample lives and dies with one capture.
   * It is collected anyway because this walk is the only place it can be had
   * cheaply, and because the invariant above — sampling is never cut short by a
   * blown budget — has to be true of the MECHANISM before Phase 2 can build a
   * projection on it.
   */
  rootKeyCount: number
  rootKeys: string[]
}

/** How many root keys one capture samples; the sample is never stored past it. */
const ROOT_KEY_SAMPLE = 16

/** A walk whose node budget can never bind, for values that are not completions. */
const UNLIMITED_NODES = Number.POSITIVE_INFINITY

function newCaptureStats(nodeLimit: number): CaptureStats {
  const stats = capturedObjectCreate(null) as CaptureStats
  stats.nodes = 0
  stats.nodeLimit = nodeLimit
  stats.overNodeLimit = false
  stats.depth = 0
  stats.rootKeyCount = 0
  stats.rootKeys = []
  return stats
}

/**
 * Validate and detach one boundary value as lossless JSON. Throws on anything
 * JSON would drop, coerce, or fail to round-trip: non-finite numbers, negative
 * zero, functions, symbols, bigints, exotic prototypes, sparse or
 * extra-propertied arrays, symbol/non-enumerable properties, and cycles.
 */
function snapshotJson(value: unknown): unknown {
  return snapshotValue(value, new CapturedSet<object>(), newCaptureStats(UNLIMITED_NODES))
}

function snapshotValue(value: unknown, seen: Set<object>, stats: CaptureStats): unknown {
  stats.nodes += 1
  // Written here, read only after the walk returns; see `CaptureStats.overNodeLimit`
  // for why this must not become an early exit.
  if (stats.nodes > stats.nodeLimit) stats.overNodeLimit = true
  if (value === null) return null
  const kind = typeof value
  if (kind === 'boolean' || kind === 'string') return value
  if (kind === 'number') {
    if (!capturedNumberIsFinite(value) || capturedObjectIs(value, -0)) throw new CapturedError('value is not lossless JSON')
    return value
  }
  if (kind !== 'object') throw new CapturedError('value is not lossless JSON')
  const source = value as object
  if (capturedReflectApply(capturedSetHas, seen, [source])) throw new CapturedError('value is not lossless JSON')
  capturedReflectApply(capturedSetAdd, seen, [source])
  const root = stats.depth === 0
  stats.depth += 1
  let snapshot: unknown
  if (capturedArrayIsArray(source)) {
    const items = source as unknown[]
    if (capturedReflectOwnKeys(items).length !== items.length + 1) throw new CapturedError('value is not lossless JSON')
    const target: unknown[] = []
    for (let index = 0; index < items.length; index++) {
      if (!capturedObjectHasOwn(items, index)) throw new CapturedError('value is not lossless JSON')
      capturedReflectApply(capturedArrayPush, target, [snapshotValue(items[index], seen, stats)])
    }
    snapshot = target
  } else {
    const prototype: unknown = capturedObjectGetPrototypeOf(source)
    if (prototype !== null && prototype !== capturedObjectPrototype) throw new CapturedError('value is not lossless JSON')
    const target = capturedObjectCreate(null) as Record<string, unknown>
    const keys = capturedReflectOwnKeys(source)
    if (root) stats.rootKeyCount = keys.length
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string | symbol
      if (typeof key !== 'string' || !capturedReflectApply(capturedPropertyIsEnumerable, source, [key])) {
        throw new CapturedError('value is not lossless JSON')
      }
      // Sampled from the enumeration above rather than from a second one; see
      // the note on `CaptureStats`.
      if (root && stats.rootKeys.length < ROOT_KEY_SAMPLE) {
        capturedReflectApply(capturedArrayPush, stats.rootKeys, [key])
      }
      target[key] = snapshotValue((source as Record<string, unknown>)[key], seen, stats)
    }
    snapshot = target
  }
  stats.depth -= 1
  capturedReflectApply(capturedSetDelete, seen, [source])
  return snapshot
}

/**
 * One retained completion. `value` is the program's ORIGINAL object, not a copy:
 * the Phase 0 benchmark measured the null-prototype snapshot copy at 1.7x-2.8x
 * the heap of the original whenever a user binding holds it too, and 3.1x on the
 * worst legal shape (`docs/plan/phase0-bench-results.zh.md` §3.3, §4.2). Keeping
 * the identity is also what makes `$out.drop(id)` release the history's claim
 * WITHOUT touching a binding the program declared over the same object.
 */
interface CompletionSlot {
  id: number
  value: unknown
  /** Serialized bytes at CAPTURE time; in-place mutation drifts this, by design. */
  bytes: number
  nodes: number
  type: string
  /**
   * Own key total of a root object. The first keys are sampled by the walk but
   * deliberately NOT stored: Phase 2 generates its projection inline during the
   * capture traversal rather than from slot metadata, so a stored sample would
   * be retained by every slot and read by nobody.
   */
  keyCount: number
}

/** Model-visible intrinsics this runtime owns; see `protocol.ts` for the reserved name. */
const COMPLETION_HISTORY_GLOBAL = '$out'
const LAST_RESULT_GLOBAL = '$_'
const COMPLETION_EXPIRED_ERROR = 'CompletionExpiredError'

/** Emitted once, when the program takes `$_` for itself; Node's REPL rule for `_`. */
const LAST_RESULT_CLAIMED_NOTICE = `[prime-realm] ${LAST_RESULT_GLOBAL} is now a program variable, `
  + `so automatic last-result tracking is off; use ${COMPLETION_HISTORY_GLOBAL}(id) to reach retained results`

/**
 * Restates `DEFAULT_COMPLETION_HISTORY_LIMITS` in `./protocol.ts`, which this
 * module cannot import at runtime. Only a placeholder: the host sends the
 * realm's real limits with every run, before any completion can be captured.
 */
let completionLimits: RealmCompletionHistoryLimits = {
  maxCompletionHistoryEntries: 16,
  maxCompletionHistoryEstimatedBytes: 33_554_432,
  maxCompletionHistoryNodes: 1_000_000,
  maxCompletionHistoryEntryBytes: 8_388_608,
}

/** Retained completions in FIFO order, oldest first. Generation-local by construction. */
const completionSlots: CompletionSlot[] = []
let retainedBytes = 0
let retainedNodes = 0
/**
 * The slot the LAST completion landed in, which is not the newest slot: an
 * identity hit reuses an older slot and deliberately keeps its FIFO position, so
 * reading `$_` off the tail would answer with somebody else's value.
 */
let lastRetainedId: number | undefined

/** How `$out.list()` names a value, without rendering any of its content. */
function completionType(value: unknown): string {
  if (value === null) return 'null'
  if (capturedArrayIsArray(value)) return 'array'
  return typeof value
}

function findCompletionSlot(id: number): CompletionSlot | undefined {
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    if (slot.id === id) return slot
  }
  return undefined
}

/** Drop the oldest slot, releasing the history's claim on its value. */
function evictOldestCompletion(): void {
  const evicted = capturedReflectApply(capturedArraySplice, completionSlots, [0, 1]) as CompletionSlot[]
  const slot = evicted[0]
  if (slot === undefined) return
  retainedBytes -= slot.bytes
  retainedNodes -= slot.nodes
}

/** Whether one more entry of this size fits inside all three history budgets. */
function completionHistoryFits(bytes: number, nodes: number): boolean {
  return completionSlots.length + 1 <= completionLimits.maxCompletionHistoryEntries
    && retainedBytes + bytes <= completionLimits.maxCompletionHistoryEstimatedBytes
    && retainedNodes + nodes <= completionLimits.maxCompletionHistoryNodes
}

/**
 * Whether this value could be retained AT ALL, in an empty history.
 *
 * Asked before anything is evicted, because a value that cannot fit on its own
 * will not fit after the store is emptied either — and emptying it would trade
 * every handle the model still holds for nothing.
 */
function completionFitsAlone(bytes: number, nodes: number): boolean {
  return bytes <= completionLimits.maxCompletionHistoryEntryBytes
    && bytes <= completionLimits.maxCompletionHistoryEstimatedBytes
    // Already implied by the walk's own node budget; restated so this test
    // stands on its own rather than on that coupling.
    && nodes <= completionLimits.maxCompletionHistoryNodes
}

/**
 * Admit one successful run's completion into the history.
 *
 * Identity first: an OBJECT already retained keeps its slot, its handle and its
 * FIFO position, and costs nothing. The Phase 0 simulation showed per-slot
 * billing flushing the history in two of three recirculation traces, and failing
 * in the worst possible shape — the object still in the store under a new id
 * while the handle the model was holding had expired
 * (`docs/plan/phase0-bench-results.zh.md` §3.6, §4.3).
 *
 * Primitives are excluded from that scan on purpose. `Object.is` on two strings
 * compares CONTENT, so two independently computed equal strings are not the same
 * result in any sense the model would recognize, and folding them together would
 * park the newer one at the older one's FIFO position. The comparison is also
 * O(length) per slot, which a run returning long strings would pay on every
 * capture.
 */
function retainCompletion(value: unknown, bytes: number, stats: CaptureStats): void {
  if (typeof value === 'object' && value !== null) {
    for (let index = 0; index < completionSlots.length; index++) {
      const slot = completionSlots[index] as CompletionSlot
      if (capturedObjectIs(slot.value, value)) {
        lastRetainedId = slot.id
        return
      }
    }
  }
  const run = active
  if (run === undefined) return
  // Refused outright rather than evicted for: one oversized result must not cost
  // the model every earlier handle it still holds.
  if (stats.overNodeLimit || !completionFitsAlone(bytes, stats.nodes)) return
  while (completionSlots.length > 0 && !completionHistoryFits(bytes, stats.nodes)) evictOldestCompletion()
  /* c8 ignore next 2 -- unreachable: the value fits an empty store and the entry budget is a positive integer, so an emptied store always has room. */
  if (!completionHistoryFits(bytes, stats.nodes)) return
  const slot = capturedObjectCreate(null) as CompletionSlot
  slot.id = run.completionId
  slot.value = value
  slot.bytes = bytes
  slot.nodes = stats.nodes
  slot.type = completionType(value)
  slot.keyCount = stats.rootKeyCount
  capturedReflectApply(capturedArrayPush, completionSlots, [slot])
  retainedBytes += bytes
  retainedNodes += stats.nodes
  lastRetainedId = slot.id
}

/**
 * The rejection a stale handle gets. Installed as an immutable global through
 * the same mechanism as a namespace's binding-error class, so a program can
 * branch on it by identity, and the host reserves the name so no binding
 * declaration can collide with it.
 */
const CompletionExpiredError = class CompletionExpiredError extends CapturedError {
  constructor(message: string) {
    super(message)
    defineBindingErrorField(this, 'name', COMPLETION_EXPIRED_ERROR)
  }
}
capturedObjectFreeze(CompletionExpiredError.prototype)
capturedObjectFreeze(CompletionExpiredError)
installReadonlyGlobal(COMPLETION_EXPIRED_ERROR, CompletionExpiredError)

/**
 * Refuse any history access from outside its own run.
 *
 * The history is runtime-owned state reachable from model code, so it takes the
 * same fencing a leased binding does: without it a continuation an earlier run
 * parked could read — or clear — whatever the CURRENT run has retained.
 */
function requireCompletionRun(intrinsic: string): void {
  if (leasedRunId() === undefined) {
    throw new CapturedError(`${intrinsic} is only reachable while its own cell is running`)
  }
}

function requireCompletionHandle(id: unknown): number {
  if (typeof id !== 'number' || !capturedNumberIsSafeInteger(id)) {
    throw new CapturedError(`${COMPLETION_HISTORY_GLOBAL}(id) takes an integer completion handle`)
  }
  return id
}

/**
 * Retrieve one retained completion, or say plainly that it is gone.
 *
 * An arrow rather than a declaration, here and below: a function declaration
 * carries a `prototype` object, which would hand model code a mutable surface
 * hanging off a frozen intrinsic and would let `new $out()` mean something.
 */
const completionHandle = (id: unknown): unknown => {
  requireCompletionRun(COMPLETION_HISTORY_GLOBAL)
  const handle = requireCompletionHandle(id)
  const slot = findCompletionSlot(handle)
  // A handle from a previous generation lands here too: ids are never reused, so
  // an old one is simply absent and can never name a value it did not create.
  if (slot === undefined) throw new CompletionExpiredError(`result ${handle} was evicted; recompute it`)
  return slot.value
}

/** Bounded metadata for every retained completion, in creation order. */
const completionList = (): unknown[] => {
  requireCompletionRun(COMPLETION_HISTORY_GLOBAL)
  const rows: unknown[] = []
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    capturedReflectApply(capturedArrayPush, rows, [{
      id: slot.id,
      type: slot.type,
      serializedBytesAtCapture: slot.bytes,
      nodes: slot.nodes,
    }])
  }
  return rows
}

/** Release one retained completion. Idempotent: an unknown handle answers `false`. */
const completionDrop = (id: unknown): boolean => {
  requireCompletionRun(COMPLETION_HISTORY_GLOBAL)
  const handle = requireCompletionHandle(id)
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    if (slot.id !== handle) continue
    capturedReflectApply(capturedArraySplice, completionSlots, [index, 1])
    retainedBytes -= slot.bytes
    retainedNodes -= slot.nodes
    if (lastRetainedId === handle) lastRetainedId = undefined
    return true
  }
  return false
}

/** Release the whole history, answering how many slots that was. */
const completionClear = (): number => {
  requireCompletionRun(COMPLETION_HISTORY_GLOBAL)
  const released = completionSlots.length
  completionSlots.length = 0
  retainedBytes = 0
  retainedNodes = 0
  lastRetainedId = undefined
  return released
}

/** The value of the most recent retained completion, or `undefined`. */
function lastRetainedValue(): unknown {
  if (lastRetainedId === undefined) return undefined
  return findCompletionSlot(lastRetainedId)?.value
}

/** Attach one immutable method to the program-visible `$out` function. */
function defineIntrinsicMethod(target: object, name: string, value: unknown): void {
  capturedObjectDefineProperty(target, name, { value, enumerable: true, writable: false, configurable: false })
}
defineIntrinsicMethod(completionHandle, 'list', completionList)
defineIntrinsicMethod(completionHandle, 'drop', completionDrop)
defineIntrinsicMethod(completionHandle, 'clear', completionClear)
capturedObjectFreeze(completionHandle)

/**
 * Hand one intrinsic name over to the program, as an ordinary global assignment
 * would leave it. Nothing is lost that the runtime needs: the history stays
 * runtime-owned and the next generation reinstalls the accessor.
 */
function claimIntrinsicName(name: string, assigned: unknown): void {
  capturedObjectDefineProperty(globalThis, name, {
    value: assigned,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Install the two model-visible intrinsics.
 *
 * CONFIGURABLE on purpose. A non-configurable own global makes a top-level
 * `const $out` fail the whole cell with `Identifier has already been declared`,
 * and `tests/completion-contracts.spec.ts` pins that declaration as legal today.
 * Configurable accessors let a lexical declaration shadow them the way Node's
 * REPL lets a user shadow `_`; the function object itself is frozen, so the
 * program can lose its own access to the history but can never reshape it.
 *
 * Both accessors are fenced on BOTH sides. A getter that answered outside its
 * run would leak a later run's values to a parked continuation; a setter that
 * answered would let that continuation retire an intrinsic the CURRENT run is
 * relying on. Refusing the write is not a loss for the program either: an
 * assignment nobody is running to observe had no legitimate reader.
 */
function completionIntrinsicDescriptor(name: string): PropertyDescriptor {
  const descriptor = capturedObjectCreate(null) as PropertyDescriptor
  descriptor.get = name === COMPLETION_HISTORY_GLOBAL
    ? (): unknown => completionHandle
    : (): unknown => {
        requireCompletionRun(LAST_RESULT_GLOBAL)
        return lastRetainedValue()
      }
  // Assignment retires the accessor for this generation, which is what makes the
  // `$_` notice single-shot: the setter no longer exists to fire a second time.
  descriptor.set = (assigned: unknown): void => {
    requireCompletionRun(name)
    claimIntrinsicName(name, assigned)
    if (name === LAST_RESULT_GLOBAL) emit(LAST_RESULT_CLAIMED_NOTICE)
  }
  descriptor.enumerable = false
  descriptor.configurable = true
  return descriptor
}

/**
 * Install both intrinsics, and reinstall either one the program DELETED.
 *
 * Deletion and assignment are different acts and get different answers. An
 * assignment leaves a data property the program is now using, and reviving the
 * accessor over it would take a live variable away mid-namespace; a deletion
 * leaves the name free, and nothing is served by making the model live without
 * the history for the rest of the generation over one stray `delete`. Testing
 * for the name's ABSENCE tells the two apart without tracking any extra state,
 * and running it at the start of every run also repairs a deletion issued from a
 * detached continuation, which no run could otherwise undo.
 *
 * A convenience, NOT a security boundary — do not build one on it. A program
 * that deletes the name and defines its own in the same cell reaches exactly the
 * end state an ordinary assignment would, and keeps it: that is the same
 * acceptable self-harm, reached by a longer route. What actually protects the
 * history is that the store is reachable only through closures, never through
 * this global.
 */
function installCompletionIntrinsics(): void {
  if (!capturedObjectHasOwn(globalThis, COMPLETION_HISTORY_GLOBAL)) {
    capturedObjectDefineProperty(globalThis, COMPLETION_HISTORY_GLOBAL, completionIntrinsicDescriptor(COMPLETION_HISTORY_GLOBAL))
  }
  if (!capturedObjectHasOwn(globalThis, LAST_RESULT_GLOBAL)) {
    capturedObjectDefineProperty(globalThis, LAST_RESULT_GLOBAL, completionIntrinsicDescriptor(LAST_RESULT_GLOBAL))
  }
}
installCompletionIntrinsics()

/** The terminal fragment of one run, without its envelope fields. */
type DoneFragment = { json?: string; error?: RealmProgramFailure }

/** Build the fixed overflow fragment without carrying the rejected bytes. */
function outputLimit(maxOutputBytes: number): DoneFragment {
  return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } }
}

/** Admit one bounded failure message, or replace it with the fixed overflow diagnostic. */
function boundedFailure(kind: 'exception' | 'invalid-output', message: string, remaining: number, maxOutputBytes: number): DoneFragment {
  if (capturedBufferByteLength(capturedJsonStringify(message), 'utf8') > remaining) return outputLimit(maxOutputBytes)
  return { error: { kind, message } }
}

/**
 * Prepare the program's completion value; only lossless JSON within budget
 * crosses. A value that does cross is also the only thing the history retains:
 * this is the one place that holds the live value, its exact serialized size and
 * its node count at once, and it runs before the run's Inspector object group is
 * released. Reached only from the SUCCESS arm of the boundary, so an exception,
 * abort, timeout, cancellation or output overflow never opens a slot.
 */
function prepareCompletion(value: unknown, remaining: number, maxOutputBytes: number): DoneFragment {
  if (value === undefined) return {}
  const stats = newCaptureStats(completionLimits.maxCompletionHistoryNodes)
  let json: string
  try {
    json = capturedJsonStringify(snapshotValue(value, new CapturedSet<object>(), stats))
  } catch {
    return boundedFailure('invalid-output', 'program completion must be lossless JSON', remaining, maxOutputBytes)
  }
  const bytes = capturedBufferByteLength(json, 'utf8')
  if (bytes > remaining) return outputLimit(maxOutputBytes)
  retainCompletion(value, bytes, stats)
  return { json }
}

/** Prepare a thrown program value without sending an unbounded stack across the port. */
function prepareException(error: unknown, remaining: number, maxOutputBytes: number): DoneFragment {
  let message: string
  try {
    const detail: unknown = error instanceof CapturedError ? error.stack ?? error.message : error
    message = typeof detail === 'string' ? detail : String(detail)
  } catch {
    message = 'program threw an unrenderable value'
  }
  return boundedFailure('exception', message, remaining, maxOutputBytes)
}

type BoundaryKind = 'completion' | 'exception'
type ReplEvaluateParameters = Runtime.EvaluateParameterType & { disableBreaks: boolean; replMode: boolean }

const INTERNAL_BOUNDARY_GROUP = 'dsh-prime-internal-boundary'
const INTERNAL_BOUNDARY_GLOBAL = '__dsh_prime_internal_boundary__'
const CALL_BOUNDARY = 'function(kind, value, remaining, maxOutputBytes) { return this(kind, value, remaining, maxOutputBytes); }'

/** One retained module-local entry point shared by completion and exception values. */
function prepareBoundary(
  kind: BoundaryKind,
  value: unknown,
  remaining: number,
  maxOutputBytes: number,
): DoneFragment {
  return kind === 'completion'
    ? prepareCompletion(value, remaining, maxOutputBytes)
    : prepareException(value, remaining, maxOutputBytes)
}

/** Convert one Inspector value into a same-world call argument without serializing it. */
function callArgument(value: Runtime.RemoteObject): Runtime.CallArgument {
  const argument = capturedObjectCreate(null) as Runtime.CallArgument
  if (capturedObjectHasOwn(value, 'objectId') && value.objectId !== undefined) {
    argument.objectId = value.objectId
  } else if (capturedObjectHasOwn(value, 'unserializableValue') && value.unserializableValue !== undefined) {
    argument.unserializableValue = value.unserializableValue
  } else if (capturedObjectHasOwn(value, 'value')) {
    argument.value = value.value
  }
  return argument
}

/** Detach the trusted, already-validated boundary envelope returned by value. */
function doneFragment(value: Runtime.RemoteObject): DoneFragment {
  if (!capturedObjectHasOwn(value, 'value') || typeof value.value !== 'object' || value.value === null) {
    throw new CapturedError('Inspector boundary returned an invalid terminal fragment')
  }
  const fragment = value.value as Record<string, unknown>
  const hasJson = capturedObjectHasOwn(fragment, 'json')
  const hasError = capturedObjectHasOwn(fragment, 'error')
  if (hasJson && hasError) throw new CapturedError('Inspector boundary returned an ambiguous terminal fragment')
  if (hasJson) {
    if (typeof fragment.json !== 'string') throw new CapturedError('Inspector boundary returned invalid completion JSON')
    return { json: fragment.json }
  }
  if (!hasError) return {}
  const error = fragment.error
  if (typeof error !== 'object' || error === null) throw new CapturedError('Inspector boundary returned an invalid failure')
  const record = error as Record<string, unknown>
  const kind = record.kind
  if ((kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') || typeof record.message !== 'string') {
    throw new CapturedError('Inspector boundary returned an invalid failure')
  }
  return { error: { kind, message: record.message } }
}

const inspectorSession = new InspectorSession()
inspectorSession.connect()
await inspectorSession.post('Runtime.enable')

// Inspector has no API for turning a module-local JS value into a RemoteObject.
// Expose the dispatcher only long enough to retain its handle, before any model
// code can run, then delete the sole program-visible route to it.
capturedObjectDefineProperty(globalThis, INTERNAL_BOUNDARY_GLOBAL, {
  value: prepareBoundary,
  enumerable: false,
  writable: false,
  configurable: true,
})
let retainedBoundary: Runtime.EvaluateReturnType
try {
  retainedBoundary = await inspectorSession.post('Runtime.evaluate', {
    expression: `globalThis[${capturedJsonStringify(INTERNAL_BOUNDARY_GLOBAL)}]`,
    objectGroup: INTERNAL_BOUNDARY_GROUP,
    includeCommandLineAPI: false,
    silent: true,
    returnByValue: false,
    generatePreview: false,
  })
} finally {
  if (!capturedReflectDeleteProperty(globalThis, INTERNAL_BOUNDARY_GLOBAL)) {
    throw new CapturedError('failed to hide the Inspector boundary bridge')
  }
}
if (capturedObjectHasOwn(retainedBoundary, 'exceptionDetails') || retainedBoundary.result.objectId === undefined) {
  throw new CapturedError('failed to retain the Inspector boundary bridge')
}
const boundaryObjectId = retainedBoundary.result.objectId

/** Run the existing boundary policy against a RemoteObject in its own V8 world. */
async function prepareRemoteBoundary(
  kind: BoundaryKind,
  value: Runtime.RemoteObject,
  remaining: number,
  maxOutputBytes: number,
  objectGroup: string,
): Promise<DoneFragment> {
  const prepared = await inspectorSession.post('Runtime.callFunctionOn', {
    objectId: boundaryObjectId,
    functionDeclaration: CALL_BOUNDARY,
    arguments: [
      { value: kind },
      callArgument(value),
      { value: remaining },
      { value: maxOutputBytes },
    ],
    silent: true,
    returnByValue: true,
    generatePreview: false,
    awaitPromise: false,
    objectGroup,
  })
  if (capturedObjectHasOwn(prepared, 'exceptionDetails')) {
    throw new CapturedError('Inspector boundary execution failed')
  }
  return doneFragment(prepared.result)
}

/** Execute one program body, then settle exactly once. */
async function startRun(message: Extract<HostToRealm, { type: 'run' }>): Promise<void> {
  const run: ActiveRun = {
    id: message.runId,
    nonce: message.nonce,
    completionId: message.completion.id,
    logs: new LogBuffer(message.maxOutputBytes, message.runId, message.nonce),
    pending: new CapturedMap<number, PendingCall>(),
    nextCallId: 1,
    timers: [],
    cancel: new CapturedAbortController(),
  }
  active = run

  // Everything from lease installation onwards is inside the guard: a run must
  // reach exactly one terminal message even if the SETUP fails, or the host
  // waits out its wall clock for a message that is never coming.
  let done: DoneFragment
  const objectGroup = `dsh-prime-run-${run.id}`
  try {
    // Inside the guard with the rest of the setup: a malformed run message must
    // still reach a terminal, not strand the host waiting out its wall clock.
    completionLimits = message.completion.limits
    installCompletionIntrinsics()
    installNamespaces(message.namespaces)
    const parameters: ReplEvaluateParameters = {
      // The directive and the program's first line deliberately share a
      // physical line, so every later source line keeps its original number.
      expression: `'use strict';${message.code}\n//# sourceURL=dsh-prime-cell-${run.id}.mjs`,
      objectGroup,
      includeCommandLineAPI: false,
      silent: true,
      returnByValue: false,
      generatePreview: false,
      awaitPromise: true,
      disableBreaks: true,
      replMode: true,
    }
    const evaluated = await capturedReflectApply(capturedAsyncLocalStorageRun, runContext, [
      run.id,
      () => inspectorSession.post('Runtime.evaluate', parameters),
    ]) as Runtime.EvaluateReturnType
    const exceptionDetails = capturedObjectHasOwn(evaluated, 'exceptionDetails') ? evaluated.exceptionDetails : undefined
    done = await prepareRemoteBoundary(
      exceptionDetails === undefined ? 'completion' : 'exception',
      exceptionDetails?.exception ?? evaluated.result,
      run.logs.remaining(),
      message.maxOutputBytes,
      objectGroup,
    )
  } catch (error: unknown) {
    done = prepareException(error, run.logs.remaining(), message.maxOutputBytes)
  } finally {
    try {
      await inspectorSession.post('Runtime.releaseObjectGroup', { objectGroup })
    } catch (error: unknown) {
      done = prepareException(error, run.logs.remaining(), message.maxOutputBytes)
    }
  }

  // Revoke first, then release the run slot, then clean up the managed handles
  // this run left behind: nothing the program armed may outlive its settlement.
  revokeLeases()
  active = undefined
  for (let timerIndex = 0; timerIndex < run.timers.length; timerIndex++) {
    const timer = run.timers[timerIndex] as ActiveRun['timers'][number]
    try {
      timer.clear(timer.handle)
    } catch {
      // A handle the program already cleared itself.
    }
  }
  // Cancels the promise-based timers this run armed. Their rejections are
  // deliberately left unhandled: nobody within this run is awaiting them, and
  // the process-level handler above keeps that from being fatal.
  run.cancel.abort()
  // Calls the program fired without awaiting can never be answered now: the
  // host stops replying at settlement. Failing them keeps a program that
  // persisted one from hanging its next run on a promise nobody will settle.
  capturedReflectApply(capturedMapForEach, run.pending, [(call: PendingCall) => {
    call.reject('tool lease revoked: the run that issued this call has ended')
  }])
  capturedReflectApply(capturedMapClear, run.pending, [])
  post({ type: 'done', runId: run.id, nonce: run.nonce, ...done })
}

port.on('message', (message: HostToRealm) => {
  if (typeof message !== 'object' || message === null) return
  if (message.type === 'run') {
    void startRun(message)
    return
  }
  if (message.type !== 'reply') return
  const run = active
  if (run === undefined || run.id !== message.runId) return
  const entry = capturedReflectApply(capturedMapGet, run.pending, [message.id]) as PendingCall | undefined
  if (!entry) return
  capturedReflectApply(capturedMapDelete, run.pending, [message.id])
  if (!message.ok) {
    entry.reject(message.message)
    return
  }
  let value: unknown
  try {
    value = capturedJsonParse(message.json)
  } catch {
    entry.reject('binding resolution must be lossless JSON')
    return
  }
  entry.resolve(value)
})
