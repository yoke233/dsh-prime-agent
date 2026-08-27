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
  RealmCompletionOpaqueLimits,
  RealmCompletionProjectionLimits,
  RealmNamespaceSpec,
  RealmProgramFailure,
  RealmRunMetrics,
  RealmToHost,
} from './protocol.js'

const CapturedAbortController = AbortController
const CapturedAbortSignal = AbortSignal
const CapturedError = Error
const CapturedMap = Map
const CapturedSet = Set
const CapturedWeakMap = WeakMap
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
const capturedStringCharCodeAt = String.prototype.charCodeAt
const capturedStringSlice = String.prototype.slice
const capturedStringStartsWith = String.prototype.startsWith
const capturedSymbolIterator = Symbol.iterator
const capturedWeakMapGet = WeakMap.prototype.get
const capturedWeakMapSet = WeakMap.prototype.set

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
  wrappers: Map<string, (...args: unknown[]) => Promise<unknown>>
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
function wrapperFor(handle: NamespaceHandle, name: string): (...args: unknown[]) => Promise<unknown> {
  const cached = capturedReflectApply(capturedMapGet, handle.wrappers, [name]) as ((...args: unknown[]) => Promise<unknown>) | undefined
  if (cached) return cached
  const wrapper = handle.global === 'refine'
    ? (...args: unknown[]): Promise<unknown> => callRefineBinding(handle, name, args)
    : (args: unknown): Promise<unknown> => callBinding(handle, name, args)
  capturedReflectApply(capturedMapSet, handle.wrappers, [name, wrapper])
  return wrapper
}

/** Model the packaged refine Skill's small script API over its private host binding. */
function callRefineBinding(handle: NamespaceHandle, name: string, args: unknown[]): Promise<unknown> {
  if (name === 'status') {
    if (args.length !== 0) return Promise.reject(bindingFailure(handle, name, 'refine.status() accepts no arguments'))
    return callBinding(handle, name, capturedObjectCreate(null))
  }
  if (name !== 'run') return Promise.reject(bindingFailure(handle, name, `unknown refine member ${capturedJsonStringify(name)}`))
  if (args.length > 2) return Promise.reject(bindingFailure(handle, name, 'refine.run() accepts instructions and options'))
  const instructions = args[0]
  if (instructions !== undefined && typeof instructions !== 'string') {
    return Promise.reject(bindingFailure(handle, name, 'refine.run() instructions must be a string'))
  }
  const options = args[1]
  let scope: unknown
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || capturedArrayIsArray(options)) {
      return Promise.reject(bindingFailure(handle, name, 'refine.run() options must be an object'))
    }
    const keys = capturedReflectOwnKeys(options)
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'scope')) {
      return Promise.reject(bindingFailure(handle, name, 'refine.run() options accept only scope'))
    }
    scope = (options as { scope?: unknown }).scope
    if (scope !== undefined && scope !== 'local' && scope !== 'global') {
      return Promise.reject(bindingFailure(handle, name, 'refine.run() scope must be local or global'))
    }
  }
  const request = capturedObjectCreate(null) as { instructions?: string; scope?: 'local' | 'global' }
  if (instructions !== undefined) request.instructions = instructions
  if (scope !== undefined) request.scope = scope as 'local' | 'global'
  return callBinding(handle, name, request)
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
    wrappers: new CapturedMap<string, (...args: unknown[]) => Promise<unknown>>(),
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
 * "first N keys" path (`Object.keys().slice` costs 857 ms on the measured
 * 64 MiB wide object in `bench/results/key-iteration.json`), so the sample below
 * is taken from the enumeration the walk performs anyway.
 */
interface CaptureStats {
  /** Every value visited, containers and leaves alike. */
  nodes: number
  nodeLimit: number
  /**
   * Set the moment the walk crosses `nodeLimit`, which permanently disqualifies
   * the value from the history.
   *
   * It is written INLINE rather than derived from a finished snapshot, and that
   * is the only way the answer can be right: `seen` is a path set (deleted on
   * exit below) that refuses cycles without recognizing sharing, so a few KiB of
   * live DAG expands into tens of millions of boundary nodes. A post-hoc count
   * would measure that amplification rather than the value.
   *
   * Tripping it does NOT by itself end the walk; `overCaptureCeiling` does, and
   * only once the value has also grown past what could have crossed whole. The
   * distinction is model-visible. A value can blow the node budget while its
   * serialization stays small — the expanding DAG above is exactly that shape —
   * and for those the full JSON still crosses, unretained. Abandoning the walk
   * there would abandon the serialization with it and turn a successful cell
   * into `invalid-output`. Guarded by "refuses a shared subgraph whose expansion
   * the walk counted, without abandoning the walk" in
   * `tests/completion-history.spec.ts`.
   */
  overNodeLimit: boolean
  /**
   * Serialized bytes the walk has accounted for, as a LOWER BOUND: escapes and
   * multi-byte code points only add, and every leaf is charged at least what its
   * shortest legal serialization would cost. Under-counting is the safe
   * direction — the walk abandons a value only once the bound alone proves it
   * cannot be used, so nothing that would have fitted is ever cut short.
   */
  bytes: number
  /**
   * The point past which the walk gives up: the higher of the per-slot admission
   * ceiling and the full-value threshold, so crossing it proves the value can
   * neither be retained nor sent whole.
   *
   * Placing the early exit at the ADMISSION ceiling rather than at the
   * projection threshold is what keeps exact accounting exact. A walk that
   * finishes inside this bound yields a real byte count and node count, which
   * the history needs to charge a slot. A walk that crosses it belongs to a
   * value that could never have been retained, so the projection uses what the
   * walk already gathered. Capture cost is therefore bounded independently of
   * value size.
   */
  byteLimit: number
  /** The size past which a completion is projected rather than sent whole. */
  fullLimit: number
  /** Set when `overCaptureCeiling` ended the walk; the snapshot is then partial. */
  aborted: boolean
  /** Container nesting, so root metadata can be taken without a second look. */
  depth: number
  /** Own key total of a root OBJECT, recorded for the slot that retains it. */
  rootKeyCount: number
  /** Projection nodes materialized so far, against `PROJECTION_NODES`. */
  projectionNodes: number
}

/** A walk with no ceiling at all, for values that are not completions. */
const UNLIMITED = Number.POSITIVE_INFINITY

function newCaptureStats(nodeLimit: number, byteLimit: number, fullLimit: number): CaptureStats {
  const stats = capturedObjectCreate(null) as CaptureStats
  stats.nodes = 0
  stats.nodeLimit = nodeLimit
  stats.overNodeLimit = false
  stats.bytes = 0
  stats.byteLimit = byteLimit
  stats.fullLimit = fullLimit
  stats.aborted = false
  stats.depth = 0
  stats.rootKeyCount = 0
  stats.projectionNodes = 0
  return stats
}

/**
 * Charge one value's shortest legal serialization, ending the walk if the total
 * proves the value is beyond use.
 *
 * Two ways out, and both have to hold something. Past `byteLimit` the value can
 * neither be retained nor sent whole, so nothing is lost by stopping. Past
 * `fullLimit` it can no longer be sent whole either, but stopping is only
 * justified once the node budget has ALSO been blown — otherwise the walk would
 * abandon a value the history was still willing to take.
 */
function chargeCapture(stats: CaptureStats, bytes: number): void {
  stats.bytes += bytes
  if (stats.bytes > stats.byteLimit || (stats.overNodeLimit && stats.bytes > stats.fullLimit)) stats.aborted = true
}

/**
 * The projector's hard limits, grounded in the checked-in projection
 * measurements under `bench/results/`. They bound the projection independently
 * of the value: whatever the walk is looking at, at most this many nodes of it
 * are ever rendered.
 */
const PROJECTION_DEPTH = 4
const PROJECTION_ARRAY_SAMPLE = 8
const PROJECTION_KEY_SAMPLE = 16
const PROJECTION_STRING_CHARS = 256
const PROJECTION_NODES = 512

/**
 * One position in the projection tree, filled in by the walk as it passes.
 *
 * A slot rather than a return value because the walk may not come back: it is
 * assigned the moment a container is entered, BEFORE its children are visited,
 * so a capture the ceiling cuts short still leaves the parent holding whatever
 * had been rendered by then.
 */
interface ProjectionSlot {
  node: unknown
}

function newProjectionSlot(stats: CaptureStats): ProjectionSlot | undefined {
  if (stats.projectionNodes >= PROJECTION_NODES) return undefined
  stats.projectionNodes += 1
  const slot = capturedObjectCreate(null) as ProjectionSlot
  slot.node = undefined
  return slot
}

/**
 * Cut one string to the projector's character budget without splitting a
 * surrogate pair. A naive `slice` breaks this by leaving a lone high surrogate
 * that no longer names the character it came from.
 */
function truncateForProjection(text: string): string {
  let end = PROJECTION_STRING_CHARS
  const code = capturedReflectApply(capturedStringCharCodeAt, text, [end - 1]) as number
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return capturedReflectApply(capturedStringSlice, text, [0, end]) as string
}

/** A string as the projection renders it: itself when short, its head when not. */
function projectString(text: string): unknown {
  if (text.length <= PROJECTION_STRING_CHARS) return text
  const node = capturedObjectCreate(null) as Record<string, unknown>
  node.type = 'string'
  node.length = text.length
  node.prefix = truncateForProjection(text)
  return node
}

/**
 * One sampled object key, as its own projection entry.
 *
 * Entries are a LIST rather than an object keyed by name because over-long keys
 * are truncated like any other string. Two 20,000-character keys sharing their
 * first 256 characters would otherwise collide, at which point `JSON.stringify`
 * silently drops one entry. A list keeps the truncation honest and keeps every
 * sampled key visible.
 */
function projectKeyEntry(key: string): Record<string, unknown> {
  const entry = capturedObjectCreate(null) as Record<string, unknown>
  if (key.length <= PROJECTION_STRING_CHARS) {
    entry.key = key
    return entry
  }
  entry.key = truncateForProjection(key)
  entry.keyLength = key.length
  return entry
}

/**
 * Validate and detach one boundary value as lossless JSON. Values that JSON
 * would drop, coerce, or fail to round-trip throw: non-finite numbers, negative
 * zero, functions, symbols, bigints, exotic prototypes, sparse or
 * extra-propertied arrays, symbol/non-enumerable properties, and cycles.
 */
function snapshotJson(value: unknown): unknown {
  return snapshotValue(
    value,
    new CapturedSet<object>(),
    newCaptureStats(UNLIMITED, UNLIMITED, UNLIMITED),
    undefined,
  )
}

/**
 * Walk one boundary value once, producing three things at the same time: the
 * detached snapshot, the admission bookkeeping, and — when a slot is supplied —
 * the bounded projection.
 *
 * All three come from a SINGLE traversal, and none of them may be recovered by a
 * second one. The walk reads program getters, so re-walking would fire their
 * side effects twice and a getter that threw the second time would turn an
 * already-successful run into a failure. The same rule covers key enumeration: a
 * dictionary-mode object has no cheap "first N keys" path (`Object.keys().slice`
 * costs 857 ms on the measured 64 MiB wide object in
 * `bench/results/key-iteration.json`), so the projector samples from the enumeration this walk performs anyway
 * and never runs one of its own.
 */
function snapshotValue(
  value: unknown,
  seen: Set<object>,
  stats: CaptureStats,
  slot: ProjectionSlot | undefined,
): unknown {
  if (stats.aborted) return undefined
  stats.nodes += 1
  if (stats.nodes > stats.nodeLimit) stats.overNodeLimit = true
  if (value === null) {
    chargeCapture(stats, 4)
    if (slot) slot.node = null
    return null
  }
  const kind = typeof value
  if (kind === 'boolean') {
    chargeCapture(stats, value === true ? 4 : 5)
    if (slot) slot.node = value
    return value
  }
  if (kind === 'string') {
    // One byte per UTF-16 unit is a floor: a surrogate pair costs two units and
    // four UTF-8 bytes, and every escape only adds.
    chargeCapture(stats, 2 + (value as string).length)
    if (slot) slot.node = projectString(value as string)
    return value
  }
  if (kind === 'number') {
    if (!capturedNumberIsFinite(value) || capturedObjectIs(value, -0)) throw new CapturedError('value is not lossless JSON')
    // One digit, which every number has and some have twenty-odd of. This is the
    // loosest charge the walk makes, and it is left loose deliberately: a tighter
    // one costs a length computation per number, while the property that matters
    // — a ceiling that does not grow with the value — holds either way, since the
    // longest legal JSON number is a constant.
    chargeCapture(stats, 1)
    if (slot) slot.node = value
    return value
  }
  if (kind !== 'object') throw new CapturedError('value is not lossless JSON')
  const source = value as object
  if (capturedReflectApply(capturedSetHas, seen, [source])) throw new CapturedError('value is not lossless JSON')
  capturedReflectApply(capturedSetAdd, seen, [source])
  const root = stats.depth === 0
  stats.depth += 1
  // Children are sampled only while the container itself sits inside the depth
  // budget; deeper containers still report their size, just not their contents.
  const sampling = slot !== undefined && stats.depth <= PROJECTION_DEPTH
  let snapshot: unknown
  if (capturedArrayIsArray(source)) {
    const items = source as unknown[]
    chargeCapture(stats, items.length > 0 ? items.length + 1 : 2)
    const sample: unknown[] | undefined = sampling ? [] : undefined
    if (slot) {
      const node = capturedObjectCreate(null) as Record<string, unknown>
      node.type = 'array'
      node.length = items.length
      if (sample) node.items = sample
      slot.node = node
    }
    const target: unknown[] = []
    for (let index = 0; index < items.length; index++) {
      // Before the element is READ, so a capture the ceiling already stopped
      // does not reach an index accessor it had decided not to need.
      if (stats.aborted) break
      if (!capturedObjectHasOwn(items, index)) throw new CapturedError('value is not lossless JSON')
      const child = sample !== undefined && index < PROJECTION_ARRAY_SAMPLE ? newProjectionSlot(stats) : undefined
      capturedReflectApply(capturedArrayPush, target, [snapshotValue(items[index], seen, stats, child)])
      // An unvisited child left its slot empty. Rendering it would put a `null`
      // in the sample, and a projected `null` means the walk SAW a null.
      if (child && child.node !== undefined) capturedReflectApply(capturedArrayPush, sample, [child.node])
    }
    // Deferred past the walk on purpose. This is the one array check that costs
    // a materialized key per ELEMENT — `Reflect.ownKeys` on a 13.4M-element
    // array measured 5.3 s and 1.2 GiB (`bench/results/g1-exit-gate.json`) — so
    // running it up front would make every aborted capture pay O(value) for an
    // answer it then throws away. A finished walk is bounded by the ceiling, as
    // is the check. The tradeoff is that sparse or extra-propertied arrays past
    // the ceiling are projected rather than rejected, consistently with other
    // validity checks beyond the walk.
    if (!stats.aborted && capturedReflectOwnKeys(items).length !== items.length + 1) {
      throw new CapturedError('value is not lossless JSON')
    }
    snapshot = target
  } else {
    const prototype: unknown = capturedObjectGetPrototypeOf(source)
    if (prototype !== null && prototype !== capturedObjectPrototype) throw new CapturedError('value is not lossless JSON')
    const target = capturedObjectCreate(null) as Record<string, unknown>
    const keys = capturedReflectOwnKeys(source)
    if (root) stats.rootKeyCount = keys.length
    chargeCapture(stats, keys.length > 0 ? keys.length + 1 : 2)
    const entries: Record<string, unknown>[] | undefined = sampling ? [] : undefined
    if (slot) {
      const node = capturedObjectCreate(null) as Record<string, unknown>
      node.type = 'object'
      node.keyCount = keys.length
      if (entries) node.keys = entries
      slot.node = node
    }
    let visited = keys.length
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string | symbol
      if (typeof key !== 'string' || !capturedReflectApply(capturedPropertyIsEnumerable, source, [key])) {
        throw new CapturedError('value is not lossless JSON')
      }
      chargeCapture(stats, key.length + 3)
      // The name has been charged and the value has NOT been read. Stopping in
      // this gap is what keeps an aborted capture from invoking a getter it had
      // already decided it did not need — and a getter that THREW there would
      // turn a run the projector was about to answer successfully into a
      // failure. This key counts as unvisited, so the fill below names it.
      if (stats.aborted) {
        visited = index
        break
      }
      const child = entries !== undefined && index < PROJECTION_KEY_SAMPLE ? newProjectionSlot(stats) : undefined
      let entry: Record<string, unknown> | undefined
      if (child && entries) {
        // Recorded from the enumeration above rather than from a second one, and
        // recorded BEFORE the child is visited so an abort inside it still
        // leaves the key named.
        entry = projectKeyEntry(key)
        capturedReflectApply(capturedArrayPush, entries, [entry])
      }
      const childValue = (source as Record<string, unknown>)[key]
      target[key] = snapshotValue(childValue, seen, stats, child)
      if (child && entry && child.node !== undefined) entry.value = child.node
      if (stats.aborted) {
        visited = index + 1
        break
      }
    }
    // The walk stopped inside one child, so later siblings were never read.
    // Their names are already in hand from the single enumeration and cost
    // nothing to report; sampling values would fire getters the aborted walk
    // deliberately left untouched.
    if (stats.aborted && entries !== undefined) {
      for (let index = visited; index < keys.length && index < PROJECTION_KEY_SAMPLE; index++) {
        const key = keys[index] as string | symbol
        if (typeof key !== 'string') break
        capturedReflectApply(capturedArrayPush, entries, [projectKeyEntry(key)])
      }
    }
    snapshot = target
  }
  stats.depth -= 1
  capturedReflectApply(capturedSetDelete, seen, [source])
  return snapshot
}

/**
 * One retained completion. `value` is the program's ORIGINAL object, not a copy:
 * the checked-in retention measurements under `bench/results/` show the
 * null-prototype snapshot copy at 1.7x-2.8x the heap of the original whenever a
 * user binding holds it too, and 3.1x on the worst measured legal shape. Keeping
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
   * Own key total of a root object. The keys THEMSELVES are never stored: the
   * projection is generated inline during the capture traversal and travels with
   * that run's envelope, so a stored sample would be held by every slot and read
   * by nobody. It is also deliberately absent from `$out.list()` because sixteen
   * 20,000-character keys across sixteen rows would make a quarter-megabyte
   * metadata answer.
   */
  keyCount: number
  /**
   * Whether this slot holds a NON-JSON live value. Opaque slots are charged
   * against their own entries/nodes/bytes budgets, evicted FIFO within their
   * own class, and their rows in `$out.list()` carry `opaque: true` so the
   * byte/node numbers there are read as capture-walk charges rather than as
   * serialized sizes.
   */
  opaque: boolean
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

/** Restates `DEFAULT_COMPLETION_OPAQUE_LIMITS`, on the same terms. */
let opaqueLimits: RealmCompletionOpaqueLimits = {
  maxCompletionOpaqueEntries: 8,
  maxCompletionOpaqueEstimatedBytes: 8_388_608,
  maxCompletionOpaqueNodes: 262_144,
}

/** Restates `DEFAULT_COMPLETION_PROJECTION_LIMITS`, on the same terms. */
let projectionLimits: RealmCompletionProjectionLimits = {
  maxCompletionFullBytes: 65_536,
  maxCompletionProjectionBytes: 4_096,
}

/**
 * This run's contribution to the realm's bounded metrics.
 *
 * Module state read by `startRun` after the boundary call rather than carried
 * back through it: the Inspector bridge revalidates every field of the fragment
 * it detaches, and there is nothing to gain from teaching it to revalidate
 * counters that never left this isolate.
 */
let runMetrics: RealmRunMetrics = {}

/** History accesses refused since the last settlement, whoever attempted them. */
let refusedAccesses = 0

/**
 * Retained completions in FIFO order, oldest first. Generation-local by
 * construction. Lossless-JSON and opaque slots share ONE store — handles,
 * `$_` and `$out.list()` are a single namespace — while the budgets behind
 * them stay independent: each class is charged and evicted on its own.
 */
const completionSlots: CompletionSlot[] = []
/** Official tool text keyed by the exact canonical object returned to model code. */
const completionPresentations = new CapturedWeakMap<object, string>()
let retainedBytes = 0
let retainedNodes = 0
/** Opaque-store totals, kept apart from the JSON store's for the same reason. */
let opaqueBytes = 0
let opaqueNodes = 0
/**
 * The slot the LAST completion landed in, which is not the newest slot: an
 * identity hit reuses an older slot and deliberately keeps its FIFO position, so
 * reading `$_` off the tail would answer with somebody else's value.
 */
let lastRetainedId: number | undefined

/**
 * How `$out.list()` names a value, without rendering any of its content.
 *
 * `Array.isArray` is the one call here that can throw — a revoked proxy — and
 * the opaque path reaches it with values the walk already refused, so the
 * throw is answered with the safe `typeof` verdict instead of escaping.
 */
function completionType(value: unknown): string {
  if (value === null) return 'null'
  try {
    if (capturedArrayIsArray(value)) return 'array'
  } catch {
    // A revoked proxy: not an array by any test the program cannot veto.
  }
  return typeof value
}

function findCompletionSlot(id: number): CompletionSlot | undefined {
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    if (slot.id === id) return slot
  }
  return undefined
}

/** Lossless-JSON slots currently held, whatever the shared store's total length. */
function jsonEntryCount(): number {
  let count = 0
  for (let index = 0; index < completionSlots.length; index++) {
    if (!(completionSlots[index] as CompletionSlot).opaque) count += 1
  }
  return count
}

/** Opaque slots currently held, whatever the shared store's total length. */
function opaqueEntryCount(): number {
  let count = 0
  for (let index = 0; index < completionSlots.length; index++) {
    if ((completionSlots[index] as CompletionSlot).opaque) count += 1
  }
  return count
}

/** Drop the oldest LOSSLESS-JSON slot, releasing the history's claim on its value. */
function evictOldestCompletion(): void {
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    if (slot.opaque) continue
    capturedReflectApply(capturedArraySplice, completionSlots, [index, 1])
    retainedBytes -= slot.bytes
    retainedNodes -= slot.nodes
    runMetrics.evicted = (runMetrics.evicted ?? 0) + 1
    return
  }
}

/** Drop the oldest OPAQUE slot, leaving every lossless-JSON slot untouched. */
function evictOldestOpaqueCompletion(): void {
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    if (!slot.opaque) continue
    capturedReflectApply(capturedArraySplice, completionSlots, [index, 1])
    opaqueBytes -= slot.bytes
    opaqueNodes -= slot.nodes
    runMetrics.evicted = (runMetrics.evicted ?? 0) + 1
    return
  }
}

/** Whether one more JSON entry of this size fits inside all three JSON budgets. */
function completionHistoryFits(bytes: number, nodes: number): boolean {
  return jsonEntryCount() + 1 <= completionLimits.maxCompletionHistoryEntries
    && retainedBytes + bytes <= completionLimits.maxCompletionHistoryEstimatedBytes
    && retainedNodes + nodes <= completionLimits.maxCompletionHistoryNodes
}

/** Whether one more opaque entry of this charge fits inside all three opaque budgets. */
function opaqueHistoryFits(bytes: number, nodes: number): boolean {
  return opaqueEntryCount() + 1 <= opaqueLimits.maxCompletionOpaqueEntries
    && opaqueBytes + bytes <= opaqueLimits.maxCompletionOpaqueEstimatedBytes
    && opaqueNodes + nodes <= opaqueLimits.maxCompletionOpaqueNodes
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
 * FIFO position, and costs nothing. The checked-in recirculation measurements
 * under `bench/results/` show per-slot billing flushing the history in two of
 * three traces, and failing in the worst possible shape — the object still in
 * the store under a new id while the handle the model was holding had expired.
 * The completion-history tests exercise the retained behavior.
 *
 * Primitives are excluded from that scan on purpose. `Object.is` on two strings
 * compares CONTENT, so two independently computed equal strings are not the same
 * result in any sense the model would recognize, and folding them together would
 * park the newer one at the older one's FIFO position. The comparison is also
 * O(length) per slot, which a run returning long strings would pay on every
 * capture.
 */
function retainCompletion(value: unknown, bytes: number, stats: CaptureStats): number | undefined {
  // The identity scan is scoped to the JSON class. The same object can be
  // retained once as JSON and later, mutated, again as opaque: each capture is
  // charged to the class that admitted it, so a JSON hit must not reuse an
  // opaque slot (or vice versa) and quietly move a value between budgets.
  if (typeof value === 'object' && value !== null) {
    for (let index = 0; index < completionSlots.length; index++) {
      const slot = completionSlots[index] as CompletionSlot
      if (slot.opaque) continue
      if (capturedObjectIs(slot.value, value)) {
        lastRetainedId = slot.id
        return slot.id
      }
    }
  }
  const run = active
  /* c8 ignore next -- capture runs inside its own run, so the slot is always held here. */
  if (run === undefined) return undefined
  // Refused outright rather than evicted for: one oversized result must not cost
  // the model every earlier handle it still holds.
  if (stats.overNodeLimit || !completionFitsAlone(bytes, stats.nodes)) return undefined
  while (jsonEntryCount() > 0 && !completionHistoryFits(bytes, stats.nodes)) evictOldestCompletion()
  /* c8 ignore next 2 -- unreachable: the value fits an empty store and the entry budget is a positive integer, so an emptied store always has room. */
  if (!completionHistoryFits(bytes, stats.nodes)) return undefined
  const slot = capturedObjectCreate(null) as CompletionSlot
  slot.id = run.completionId
  slot.value = value
  slot.bytes = bytes
  slot.nodes = stats.nodes
  slot.type = completionType(value)
  slot.keyCount = stats.rootKeyCount
  slot.opaque = false
  capturedReflectApply(capturedArrayPush, completionSlots, [slot])
  retainedBytes += bytes
  retainedNodes += stats.nodes
  lastRetainedId = slot.id
  return slot.id
}

/**
 * Admit one successful run's NON-JSON completion into the opaque history.
 *
 * Reached only from the catch arm of the classification walk, so the value's
 * graph was deliberately never measured: the slot is charged what the walk
 * accounted for before it threw, against the OPAQUE budgets alone. Identity
 * reuse follows the JSON rule with one extension — functions are scanned too,
 * because `Object.is` on a function is an identity test with no content cost,
 * and a function is the most common live value a model recirculates. The
 * refused-oversized rule is the same: a charge that cannot fit an EMPTY
 * opaque store never clears the store for it.
 */
function retainOpaqueCompletion(value: unknown, stats: CaptureStats): number | undefined {
  const kind = typeof value
  if (kind === 'object' || kind === 'function') {
    for (let index = 0; index < completionSlots.length; index++) {
      const slot = completionSlots[index] as CompletionSlot
      if (!slot.opaque) continue
      if (capturedObjectIs(slot.value, value)) {
        lastRetainedId = slot.id
        return slot.id
      }
    }
  }
  const run = active
  /* c8 ignore next -- capture runs inside its own run, so the slot is always held here. */
  if (run === undefined) return undefined
  const bytes = stats.bytes
  const nodes = stats.nodes
  if (bytes > opaqueLimits.maxCompletionOpaqueEstimatedBytes
    || nodes > opaqueLimits.maxCompletionOpaqueNodes) return undefined
  while (opaqueEntryCount() > 0 && !opaqueHistoryFits(bytes, nodes)) evictOldestOpaqueCompletion()
  /* c8 ignore next 2 -- unreachable: the charge fits an empty store and the entry budget is a positive integer, so an emptied store always has room. */
  if (!opaqueHistoryFits(bytes, nodes)) return undefined
  const slot = capturedObjectCreate(null) as CompletionSlot
  slot.id = run.completionId
  slot.value = value
  slot.bytes = bytes
  slot.nodes = nodes
  slot.type = completionType(value)
  slot.keyCount = 0
  slot.opaque = true
  capturedReflectApply(capturedArrayPush, completionSlots, [slot])
  opaqueBytes += bytes
  opaqueNodes += nodes
  lastRetainedId = slot.id
  return slot.id
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
    // Counted OUTSIDE any run's report and drained by the next settlement: the
    // refusals worth counting are exactly the ones that happen when no run owns
    // the caller, including those that land between two runs.
    refusedAccesses += 1
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
  if (slot === undefined) {
    runMetrics.expired = (runMetrics.expired ?? 0) + 1
    throw new CompletionExpiredError(`result ${handle} was evicted; recompute it`)
  }
  return slot.value
}

/** Bounded metadata for every retained completion, in creation order. */
const completionList = (): unknown[] => {
  requireCompletionRun(COMPLETION_HISTORY_GLOBAL)
  const rows: unknown[] = []
  for (let index = 0; index < completionSlots.length; index++) {
    const slot = completionSlots[index] as CompletionSlot
    const row = capturedObjectCreate(null) as Record<string, unknown>
    row.id = slot.id
    row.type = slot.type
    // For an opaque slot these are the classification walk's CHARGE, not a
    // serialized size — the `opaque: true` marker is what tells the two apart.
    row.serializedBytesAtCapture = slot.bytes
    row.nodes = slot.nodes
    // The COUNT, never the keys themselves. It is one small integer whatever
    // the value's shape, which is what separates it from the names: sixteen
    // 20,000-character keys across sixteen rows would make a quarter-megabyte
    // metadata answer. Opaque values are never walked for their keys, so their
    // count is always zero.
    row.keyCount = slot.keyCount
    if (slot.opaque) row.opaque = true
    capturedReflectApply(capturedArrayPush, rows, [row])
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
    if (slot.opaque) {
      opaqueBytes -= slot.bytes
      opaqueNodes -= slot.nodes
    } else {
      retainedBytes -= slot.bytes
      retainedNodes -= slot.nodes
    }
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
  opaqueBytes = 0
  opaqueNodes = 0
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
 * Set while the fragment `prepareCompletion` produced is a projection envelope,
 * so `startRun` can mark the terminal message. Read once, immediately after the
 * boundary call; see `runMetrics` for why it travels in module state.
 */
let projectedCompletion = false

/**
 * Render one bounded reference to a completion the model is not being shown.
 *
 * The chain is `rich -> minimal -> output-limit`, and both rungs are tested
 * against the SAME two ceilings: the projection budget, which bounds what a
 * completion may cost the conversation, and the wire budget left after logs,
 * which bounds what the protocol can carry. A handle appears only for a value
 * that was retained; a dead handle is worse than none because the `use`
 * expression is written to be copied and would immediately fail.
 */
function projectCompletion(
  value: unknown,
  id: number | undefined,
  bytes: number | undefined,
  projection: unknown,
  remaining: number,
  maxOutputBytes: number,
): DoneFragment {
  const budget = projectionLimits.maxCompletionProjectionBytes < remaining
    ? projectionLimits.maxCompletionProjectionBytes
    : remaining
  const type = completionType(value)
  const rich = capturedObjectCreate(null) as Record<string, unknown>
  if (id !== undefined) {
    rich[COMPLETION_HISTORY_GLOBAL] = id
    rich.use = `${COMPLETION_HISTORY_GLOBAL}(${id})`
  }
  rich.retained = id !== undefined
  rich.type = type
  // Reported whenever the walk MEASURED it. A capture the ceiling cut short
  // never learned the real size, and a lower bound reported as an exact number
  // would be a measurement nobody took.
  if (bytes !== undefined) rich.serializedBytesAtCapture = bytes
  if (projection !== undefined) rich.projection = projection
  if (id === undefined) rich.reason = bytes === undefined ? 'too large to capture' : 'too large to retain'
  rich.truncated = true
  const richJson = capturedJsonStringify(rich)
  if (capturedBufferByteLength(richJson, 'utf8') <= budget) return { json: richJson }

  const minimal = capturedObjectCreate(null) as Record<string, unknown>
  if (id !== undefined) {
    minimal[COMPLETION_HISTORY_GLOBAL] = id
    minimal.use = `${COMPLETION_HISTORY_GLOBAL}(${id})`
  }
  minimal.type = type
  minimal.truncated = true
  const minimalJson = capturedJsonStringify(minimal)
  if (capturedBufferByteLength(minimalJson, 'utf8') <= remaining) return { json: minimalJson }
  return outputLimit(maxOutputBytes)
}

/**
 * The FIXED envelope a NON-JSON completion crosses as, whatever it was.
 *
 * The value itself never serializes, and rendering it would mean calling the
 * program's own hooks — toJSON, toString, inspect, or any proxy trap — so
 * the envelope deliberately carries no contents at all: a handle when the value
 * was retained, the safe typeof-grade type, and the 'opaque: true' marker
 * that tells the model this is a live value to reach through $out(id), not a
 * projection of something serializable. The chain is the same
 * rich -> minimal -> output-limit as the JSON projector's, and the rich rung
 * is already small enough that the minimal one exists only for the most
 * starved wire budgets.
 */
function projectOpaqueCompletion(
  value: unknown,
  id: number | undefined,
  remaining: number,
  maxOutputBytes: number,
): DoneFragment {
  const budget = projectionLimits.maxCompletionProjectionBytes < remaining
    ? projectionLimits.maxCompletionProjectionBytes
    : remaining
  const type = completionType(value)
  const rich = capturedObjectCreate(null) as Record<string, unknown>
  if (id !== undefined) {
    rich[COMPLETION_HISTORY_GLOBAL] = id
    rich.use = `${COMPLETION_HISTORY_GLOBAL}(${id})`
  }
  rich.retained = id !== undefined
  rich.type = type
  rich.opaque = true
  // The value was never measured (measuring it would run the program's own
  // code), so there is no capture size to report and no reason to invent one.
  if (id === undefined) rich.reason = 'opaque history budget exceeded'
  rich.truncated = true
  const richJson = capturedJsonStringify(rich)
  if (capturedBufferByteLength(richJson, 'utf8') <= budget) return { json: richJson }

  const minimal = capturedObjectCreate(null) as Record<string, unknown>
  if (id !== undefined) {
    minimal[COMPLETION_HISTORY_GLOBAL] = id
    minimal.use = `${COMPLETION_HISTORY_GLOBAL}(${id})`
  }
  minimal.type = type
  minimal.opaque = true
  minimal.truncated = true
  const minimalJson = capturedJsonStringify(minimal)
  if (capturedBufferByteLength(minimalJson, 'utf8') <= remaining) return { json: minimalJson }
  return outputLimit(maxOutputBytes)
}

/**
 * Prepare the program's completion value; only lossless JSON crosses, whole when
 * it is small enough and as a bounded reference when it is not. This is also the
 * one place the history can retain from: it holds the live value, its exact
 * serialized size and its node count at once, and it runs before the run's
 * Inspector object group is released. Reached only from the SUCCESS arm of the
 * boundary, so an exception, abort, timeout, cancellation or output overflow
 * never opens a slot.
 *
 * A value the walk refuses is NOT a failed cell: it is a live object whose
 * generation-local retention the opaque budgets decide, answered with a fixed
 * envelope. The one walk does double duty — it classifies, and it charges the
 * opaque slot with what it accounted for before refusing — so a second pass that
 * could fire user getters again is never taken.
 *
 * Validity is judged over the part the bounded walk reached. A value whose tail
 * lies past the capture ceiling is never read, so a bigint hiding there is never
 * found and the run succeeds with a projection rather than failing. This avoids
 * serializing 64 MiB merely to discover it was unusable and costs the model
 * nothing real: the history retains the original object, not the snapshot, so
 * `$out(id)` still returns the exact value. The completion-projection tests pin
 * that observable boundary.
 */
function prepareCompletion(value: unknown, remaining: number, maxOutputBytes: number): DoneFragment {
  if (value === undefined) return {}
  // The walk may stop only once the value is beyond BOTH uses it could still be
  // put to. Taking the retention ceiling alone would let a deployment that
  // retains little turn ordinary mid-sized results into references, which is a
  // model-visible contract decided by an unrelated knob.
  const full = projectionLimits.maxCompletionFullBytes
  const entry = completionLimits.maxCompletionHistoryEntryBytes
  const stats = newCaptureStats(completionLimits.maxCompletionHistoryNodes, entry > full ? entry : full, full)
  const slot = capturedObjectCreate(null) as ProjectionSlot
  slot.node = undefined
  let snapshot: unknown
  try {
    snapshot = snapshotValue(value, new CapturedSet<object>(), stats, slot)
  } catch {
    // NON-JSON live value: retain it under the opaque budgets and answer with
    // the fixed envelope. The walk already stopped at the first thing it would
    // not render — a bigint, a function, a non-plain prototype, a getter that
    // threw, a revoked proxy — and none of the program's own hooks were needed
    // to say so. The cell is a SUCCESS either way.
    projectedCompletion = true
    const id = retainOpaqueCompletion(value, stats)
    runMetrics.retained = id !== undefined
    runMetrics.rejected = id === undefined
    runMetrics.historyEntries = jsonEntryCount()
    runMetrics.historyBytes = retainedBytes
    runMetrics.historyOpaqueEntries = opaqueEntryCount()
    runMetrics.historyOpaqueBytes = opaqueBytes
    return projectOpaqueCompletion(value, id, remaining, maxOutputBytes)
  }
  projectedCompletion = true
  if (stats.aborted) {
    // Past the admission ceiling: unmeasurable without finishing a walk that was
    // abandoned for good reason, and unretainable whatever the measurement would
    // have said.
    runMetrics.rejected = true
    runMetrics.historyEntries = jsonEntryCount()
    runMetrics.historyBytes = retainedBytes
    runMetrics.historyOpaqueEntries = opaqueEntryCount()
    runMetrics.historyOpaqueBytes = opaqueBytes
    return projectCompletion(value, undefined, undefined, slot.node, remaining, maxOutputBytes)
  }
  let json: string
  try {
    json = capturedJsonStringify(snapshot)
  } catch {
    /* c8 ignore next 2 -- unreachable: the walk already refused everything JSON cannot render, so the detached snapshot always serializes. */
    return boundedFailure('invalid-output', 'program completion must be lossless JSON', remaining, maxOutputBytes)
  }
  const bytes = capturedBufferByteLength(json, 'utf8')
  const id = retainCompletion(value, bytes, stats)
  runMetrics.captureBytes = bytes
  runMetrics.captureNodes = stats.nodes
  runMetrics.retained = id !== undefined
  runMetrics.rejected = id === undefined
  runMetrics.historyEntries = jsonEntryCount()
  runMetrics.historyBytes = retainedBytes
  runMetrics.historyOpaqueEntries = opaqueEntryCount()
  runMetrics.historyOpaqueBytes = opaqueBytes
  if (bytes <= projectionLimits.maxCompletionFullBytes && bytes <= remaining) {
    projectedCompletion = false
    return { json }
  }
  return projectCompletion(value, id, bytes, slot.node, remaining, maxOutputBytes)
}

/** Prepare a thrown program value as one concise diagnostic; internal stacks are not model-actionable. */
function prepareException(error: unknown, remaining: number, maxOutputBytes: number): DoneFragment {
  let message: string
  try {
    const detail: unknown = error instanceof CapturedError ? error.message : error
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
  if (kind === 'completion' && typeof value === 'object' && value !== null) {
    const presentation = capturedReflectApply(capturedWeakMapGet, completionPresentations, [value]) as string | undefined
    if (presentation !== undefined) return prepareCompletion(presentation, remaining, maxOutputBytes)
  }
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
  // A primitive never gets an objectId: the Inspector INLINES its value in the
  // evaluate response, so by the time this runs the whole thing is already a
  // detached value in this isolate's heap. Sending it back through
  // `callFunctionOn` would serialize and reparse it a second time for nothing —
  // measured at 4.6 s and 2.5 GiB for a 128 MiB string, half of it this second
  // round trip (`bench/results/g1-exit-gate.json`). The remaining half is the
  // response that already happened, and no early exit can reach it: it is spent
  // before this module sees the value at all.
  //
  // Applied only when the Inspector actually gave a value. An unserializable
  // primitive — a bigint, `NaN`, `-0` — arrives as `unserializableValue` with no
  // `value` at all, and has to go the remote route to reach the boundary as the
  // real thing rather than as its rendering.
  if (value.objectId === undefined && capturedObjectHasOwn(value, 'value')) {
    return prepareBoundary(kind, value.value, remaining, maxOutputBytes)
  }
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
  runMetrics = capturedObjectCreate(null) as RealmRunMetrics
  projectedCompletion = false

  // Everything from lease installation onwards is inside the guard: a run must
  // reach exactly one terminal message even if the SETUP fails, or the host
  // waits out its wall clock for a message that is never coming.
  let done: DoneFragment
  const objectGroup = `dsh-prime-run-${run.id}`
  try {
    // Inside the guard with the rest of the setup: a malformed run message must
    // still reach a terminal, not strand the host waiting out its wall clock.
    completionLimits = message.completion.limits
    projectionLimits = message.completion.projection
    opaqueLimits = message.completion.opaque
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
  // The projection marker is the run's own nonce, which never reaches the
  // program: a completion the model built to look like an envelope travels the
  // ordinary path and arrives without it. Set only alongside a value — a chain
  // that ran out of budget ends in `output-limit`, which is not a projection.
  if (refusedAccesses > 0) {
    runMetrics.refused = refusedAccesses
    refusedAccesses = 0
  }
  const projected = projectedCompletion && done.json !== undefined ? { projected: run.nonce } : {}
  post({ type: 'done', runId: run.id, nonce: run.nonce, ...done, ...projected, metrics: runMetrics })
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
  if (typeof value === 'object' && value !== null && !capturedArrayIsArray(value)) {
    const envelope = value as Record<string, unknown>
    if (envelope.$dshPrimeBinding === 'presentation-v1' && typeof envelope.presentation === 'string'
      && capturedObjectHasOwn(envelope, 'value')) {
      value = envelope.value
      if (typeof value === 'object' && value !== null) {
        capturedReflectApply(capturedWeakMapSet, completionPresentations, [value, envelope.presentation])
      }
    }
  }
  entry.resolve(value)
})
