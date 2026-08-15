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
import type { HostToRealm, RealmNamespaceSpec, RealmProgramFailure, RealmToHost } from './protocol.js'

const CapturedAbortController = AbortController
const CapturedAbortSignal = AbortSignal
const CapturedError = Error
const CapturedMap = Map
const CapturedSet = Set
const capturedAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore
const capturedAsyncLocalStorageRun = AsyncLocalStorage.prototype.run
const capturedAbortSignalAny = AbortSignal.any
const capturedArrayPush = Array.prototype.push
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
const capturedObjectCreate = Object.create
const capturedObjectDefineProperty = Object.defineProperty
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
 * async work unsupported in v0.3 precisely because the set of ways an isolate
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
 * Validate and detach one boundary value as lossless JSON. Throws on anything
 * JSON would drop, coerce, or fail to round-trip: non-finite numbers, negative
 * zero, functions, symbols, bigints, exotic prototypes, sparse or
 * extra-propertied arrays, symbol/non-enumerable properties, and cycles.
 */
function snapshotJson(value: unknown): unknown {
  return snapshotValue(value, new CapturedSet<object>())
}

function snapshotValue(value: unknown, seen: Set<object>): unknown {
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
  let snapshot: unknown
  if (capturedArrayIsArray(source)) {
    const items = source as unknown[]
    if (capturedReflectOwnKeys(items).length !== items.length + 1) throw new CapturedError('value is not lossless JSON')
    const target: unknown[] = []
    for (let index = 0; index < items.length; index++) {
      if (!capturedObjectHasOwn(items, index)) throw new CapturedError('value is not lossless JSON')
      capturedReflectApply(capturedArrayPush, target, [snapshotValue(items[index], seen)])
    }
    snapshot = target
  } else {
    const prototype: unknown = capturedObjectGetPrototypeOf(source)
    if (prototype !== null && prototype !== capturedObjectPrototype) throw new CapturedError('value is not lossless JSON')
    const target = capturedObjectCreate(null) as Record<string, unknown>
    const keys = capturedReflectOwnKeys(source)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string | symbol
      if (typeof key !== 'string' || !capturedReflectApply(capturedPropertyIsEnumerable, source, [key])) {
        throw new CapturedError('value is not lossless JSON')
      }
      target[key] = snapshotValue((source as Record<string, unknown>)[key], seen)
    }
    snapshot = target
  }
  capturedReflectApply(capturedSetDelete, seen, [source])
  return snapshot
}

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

/** Prepare the program's completion value; only lossless JSON within budget crosses. */
function prepareCompletion(value: unknown, remaining: number, maxOutputBytes: number): DoneFragment {
  if (value === undefined) return {}
  let json: string
  try {
    json = capturedJsonStringify(snapshotJson(value))
  } catch {
    return boundedFailure('invalid-output', 'program completion must be lossless JSON', remaining, maxOutputBytes)
  }
  if (capturedBufferByteLength(json, 'utf8') > remaining) return outputLimit(maxOutputBytes)
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
