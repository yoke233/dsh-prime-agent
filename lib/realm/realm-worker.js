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
import { AsyncLocalStorage } from 'node:async_hooks';
import { Session as InspectorSession } from 'node:inspector/promises';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { workerData } from 'node:worker_threads';
const CapturedAbortController = AbortController;
const CapturedAbortSignal = AbortSignal;
const CapturedError = Error;
const CapturedMap = Map;
const CapturedSet = Set;
const CapturedWeakMap = WeakMap;
const capturedAsyncLocalStorageGetStore = AsyncLocalStorage.prototype.getStore;
const capturedAsyncLocalStorageRun = AsyncLocalStorage.prototype.run;
const capturedAbortSignalAny = AbortSignal.any;
const capturedArrayPush = Array.prototype.push;
const capturedArrayIsArray = Array.isArray;
const capturedBufferByteLength = Buffer.byteLength;
const capturedJsonParse = JSON.parse;
const capturedJsonStringify = JSON.stringify;
const capturedMapClear = Map.prototype.clear;
const capturedMapDelete = Map.prototype.delete;
const capturedMapForEach = Map.prototype.forEach;
const capturedMapGet = Map.prototype.get;
const capturedMapSet = Map.prototype.set;
const capturedNumberIsFinite = Number.isFinite;
const capturedObjectCreate = Object.create;
const capturedObjectDefineProperty = Object.defineProperty;
const capturedObjectGetPrototypeOf = Object.getPrototypeOf;
const capturedObjectHasOwn = Object.hasOwn;
const capturedObjectIs = Object.is;
const capturedObjectPrototype = Object.prototype;
const capturedPropertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const capturedReflectApply = Reflect.apply;
const capturedReflectDeleteProperty = Reflect.deleteProperty;
const capturedReflectOwnKeys = Reflect.ownKeys;
const capturedSetAdd = Set.prototype.add;
const capturedSetClear = Set.prototype.clear;
const capturedSetDelete = Set.prototype.delete;
const capturedSetForEach = Set.prototype.forEach;
const capturedSetHas = Set.prototype.has;
const capturedStringCharCodeAt = String.prototype.charCodeAt;
const capturedStringSlice = String.prototype.slice;
const capturedStringStartsWith = String.prototype.startsWith;
const capturedSymbolIterator = Symbol.iterator;
const capturedWeakMapGet = WeakMap.prototype.get;
const capturedWeakMapSet = WeakMap.prototype.set;
/** Bounded inspect options, so a pathological value cannot explode the rendering. */
const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 };
/** The five console methods the shim captures. */
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const boot = (workerData ?? {});
const bootPort = boot.port;
if (!bootPort)
    throw new CapturedError('dsh-prime-agent: realm worker started without its private control port');
// Model code can read `workerData` through node:worker_threads. Drop the
// reference so the private control channel stays out of the program's reach;
// the ambient `parentPort` it CAN reach is not wired to anything host-side.
delete boot.port;
const port = bootPort;
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
const capturedPostMessage = capturedObjectGetPrototypeOf(port).postMessage;
/** Install one immutable program-visible global owned by the runtime. */
function installReadonlyGlobal(name, value) {
    capturedObjectDefineProperty(globalThis, name, {
        value,
        enumerable: false,
        writable: false,
        configurable: false,
    });
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
});
capturedObjectDefineProperty(Array.prototype, 'toJSON', {
    value: undefined,
    enumerable: false,
    writable: false,
    configurable: false,
});
capturedObjectDefineProperty(capturedObjectPrototype, 'params', {
    get: () => undefined,
    set(value) {
        capturedObjectDefineProperty(this, 'params', {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
        });
    },
    enumerable: false,
    configurable: false,
});
const capturedGetBuiltinModule = process.getBuiltinModule;
/** Prevent a cell from recovering the runtime Inspector or a module loader. */
function restrictedGetBuiltinModule(id) {
    const normalized = capturedReflectApply(capturedStringStartsWith, id, ['node:'])
        ? capturedReflectApply(capturedStringSlice, id, ['node:'.length])
        : id;
    if (normalized === 'module' || normalized === 'async_hooks' || normalized === 'inspector'
        || capturedReflectApply(capturedStringStartsWith, normalized, ['inspector/'])) {
        throw new CapturedError(`program access to ${capturedJsonStringify(id)} is disabled`);
    }
    return capturedReflectApply(capturedGetBuiltinModule, process, [id]);
}
capturedObjectDefineProperty(process, 'getBuiltinModule', {
    value: restrictedGetBuiltinModule,
    enumerable: false,
    writable: false,
    configurable: false,
});
capturedObjectDefineProperty(process, 'binding', {
    value: () => { throw new CapturedError('process.binding is disabled in the persistent realm'); },
    enumerable: false,
    writable: false,
    configurable: false,
});
for (const name of ['_getActiveHandles', '_getActiveRequests']) {
    capturedObjectDefineProperty(process, name, {
        value: () => { throw new CapturedError(`${name} is disabled in the persistent realm`); },
        enumerable: false,
        writable: false,
        configurable: false,
    });
}
const handles = new CapturedMap();
const errorClasses = new CapturedMap();
const runContext = new AsyncLocalStorage();
let active;
/** Post one control message, tolerating a host that already closed the port. */
function post(message) {
    try {
        capturedReflectApply(capturedPostMessage, port, [message]);
    }
    catch {
        // The host tore the realm down; there is nobody left to report to.
    }
}
/**
 * The run id whose lease is currently valid for the CALLER, or `undefined`.
 * Both an active run and a caller whose async context belongs to that run are
 * required, so a detached continuation armed by an earlier run cannot borrow
 * the current run's lease.
 */
function leasedRunId() {
    const run = active;
    if (run === undefined)
        return undefined;
    return capturedReflectApply(capturedAsyncLocalStorageGetStore, runContext, []) === run.id ? run.id : undefined;
}
/** Ordered per-run text capture under the run's share of the outer output cap. */
class LogBuffer {
    bytes = 2; // JSON serialization of the empty logs array: []
    entries = 0;
    limited = false;
    maxBytes;
    runId;
    nonce;
    constructor(maxBytes, runId, nonce) {
        this.maxBytes = maxBytes;
        this.runId = runId;
        this.nonce = nonce;
    }
    /** Stream one captured line to the host, or report the cap once and go quiet. */
    push(text) {
        if (this.limited)
            return;
        const separatorBytes = this.entries > 0 ? 1 : 0;
        const cost = capturedBufferByteLength(capturedJsonStringify(text), 'utf8') + separatorBytes;
        if (this.bytes + cost > this.maxBytes) {
            this.limited = true;
            post({ type: 'output-limit', runId: this.runId, nonce: this.nonce });
            return;
        }
        this.bytes += cost;
        this.entries += 1;
        post({ type: 'log', runId: this.runId, nonce: this.nonce, text });
    }
    /** Exact bytes left for this run's completion value or failure message. */
    remaining() {
        return this.maxBytes - this.bytes;
    }
}
/**
 * Capture one rendered line for the run that produced it. Output emitted after
 * its own run's lease was revoked is DISCARDED rather than attributed to
 * whichever run happens to be active.
 */
function emit(text) {
    const run = active;
    if (run === undefined || leasedRunId() === undefined)
        return;
    run.logs.push(text);
}
/** Render console arguments the way Node's console would, closely enough for a model to recognize. */
function render(args) {
    let line = '';
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        line += (index > 0 ? ' ' : '') + (typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS));
    }
    return line;
}
const consoleShim = capturedObjectCreate(null);
for (const level of CONSOLE_LEVELS) {
    consoleShim[level] = (...args) => { emit(render(args)); };
}
installReadonlyGlobal('console', consoleShim);
/** Render one written chunk the way the stream would have delivered it. */
function chunkText(chunk) {
    return typeof chunk === 'string' ? chunk : String(chunk);
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
function captureStreamWrites(stream) {
    stream.write = (chunk, ...rest) => {
        emit(chunkText(chunk));
        const callback = typeof rest[0] === 'function'
            ? rest[0]
            : typeof rest[1] === 'function' ? rest[1] : undefined;
        if (callback)
            queueMicrotask(() => { callback(null); });
        return true;
    };
    stream._write = (chunk, _encoding, callback) => {
        emit(chunkText(chunk));
        callback(null);
    };
    stream._writev = (chunks, callback) => {
        for (let index = 0; index < chunks.length; index++)
            emit(chunkText(chunks[index].chunk));
        callback(null);
    };
}
captureStreamWrites(process.stdout);
captureStreamWrites(process.stderr);
/**
 * The `node:timers` exports object. Its ESM namespace is derived from it, so
 * patching it here — before anything imports the module — is what makes
 * `import('node:timers').setTimeout` reach the wrapper too, instead of handing
 * the program an untracked factory beside the patched global.
 */
const timersModule = createRequire(import.meta.url)('node:timers');
/**
 * Wrap one timer factory so every handle it hands the program is tracked
 * against the run that created it and cleared before that run settles.
 * `queueMicrotask` is deliberately unwrapped: it yields no handle to clear, and
 * its callbacks drain within the run that queued them.
 */
function wrapTimerFactory(factoryName, clearName) {
    const globals = globalThis;
    const create = globals[factoryName];
    const clear = globals[clearName];
    const wrapper = (...args) => {
        const handle = capturedReflectApply(create, undefined, args);
        const run = active;
        if (run !== undefined)
            capturedReflectApply(capturedArrayPush, run.timers, [{ clear, handle }]);
        return handle;
    };
    globals[factoryName] = wrapper;
    timersModule[factoryName] = wrapper;
}
wrapTimerFactory('setTimeout', 'clearTimeout');
wrapTimerFactory('setInterval', 'clearInterval');
wrapTimerFactory('setImmediate', 'clearImmediate');
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
const promiseTimersModule = createRequire(import.meta.url)('node:timers/promises');
/** A two-signal array whose iteration never consults mutable Array prototypes. */
function ownedSignalPair(first, second) {
    const signals = [first, second];
    capturedObjectDefineProperty(signals, capturedSymbolIterator, {
        value: () => {
            let index = 0;
            const iterator = capturedObjectCreate(null);
            capturedObjectDefineProperty(iterator, 'next', {
                value: () => {
                    if (index === 0) {
                        index = 1;
                        return { value: first, done: false };
                    }
                    if (index === 1) {
                        index = 2;
                        return { value: second, done: false };
                    }
                    return { value: undefined, done: true };
                },
            });
            return iterator;
        },
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return signals;
}
/** The current run's cancellation signal merged with whatever the caller passed. */
function runCancellation(supplied) {
    const run = active;
    const callerSignal = supplied instanceof CapturedAbortSignal ? supplied : undefined;
    if (run === undefined)
        return callerSignal;
    return callerSignal ? capturedAbortSignalAny(ownedSignalPair(run.cancel.signal, callerSignal)) : run.cancel.signal;
}
/**
 * Wrap one promise-timer factory so the run that armed it also owns cancelling
 * it. The options bag is the last documented parameter of each factory, so the
 * wrapper rebuilds it at that position rather than guessing from arity.
 */
function wrapPromiseTimer(factoryName, optionsIndex) {
    const create = promiseTimersModule[factoryName];
    if (typeof create !== 'function')
        return;
    const original = create;
    promiseTimersModule[factoryName] = (...args) => {
        const supplied = args[optionsIndex];
        const options = typeof supplied === 'object' && supplied !== null ? { ...supplied } : {};
        const signal = runCancellation(options.signal);
        // Padded to the options position: called as `setTimeout(50)`, the bag would
        // otherwise land in the value slot.
        while (args.length < optionsIndex)
            capturedReflectApply(capturedArrayPush, args, [undefined]);
        args[optionsIndex] = { ...options, ...signal ? { signal } : {} };
        return capturedReflectApply(original, undefined, args);
    };
}
wrapPromiseTimer('setTimeout', 2);
wrapPromiseTimer('setInterval', 2);
wrapPromiseTimer('setImmediate', 1);
// `scheduler.wait` is `setTimeout` under another name, so it gets the same
// treatment; `scheduler.yield` resolves within the run that called it.
const scheduler = promiseTimersModule.scheduler;
if (typeof scheduler === 'object' && scheduler !== null) {
    const wait = scheduler.wait;
    if (typeof wait === 'function') {
        const originalWait = wait;
        scheduler.wait = (...args) => {
            const supplied = args[1];
            const options = typeof supplied === 'object' && supplied !== null ? { ...supplied } : {};
            const signal = runCancellation(options.signal);
            args[1] = { ...options, ...signal ? { signal } : {} };
            return capturedReflectApply(originalWait, undefined, args);
        };
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
});
/** Define one public binding-error field without consulting mutable descriptor prototypes. */
function defineBindingErrorField(error, key, value) {
    const attributes = capturedObjectCreate(null);
    attributes.enumerable = true;
    attributes.value = value;
    capturedObjectDefineProperty(error, key, attributes);
}
/**
 * Materialize one namespace's rejection class, cached across runs so a
 * constructor captured by a retained binding keeps its identity.
 */
function ensureErrorClass(descriptor) {
    // A JSON pair, not a delimiter-joined string: no member name can forge a
    // collision with a different class name.
    const cacheKey = capturedJsonStringify([descriptor.name, descriptor.memberNameProperty]);
    const cached = capturedReflectApply(capturedMapGet, errorClasses, [cacheKey]);
    if (cached)
        return cached;
    const created = class BindingCallError extends CapturedError {
        constructor(memberName, message) {
            super(message);
            defineBindingErrorField(this, 'name', descriptor.name);
            defineBindingErrorField(this, descriptor.memberNameProperty, memberName);
        }
    };
    installReadonlyGlobal(descriptor.name, created);
    capturedReflectApply(capturedMapSet, errorClasses, [cacheKey, created]);
    return created;
}
/** Build the namespace-specific rejection for one refused or failed binding call. */
function bindingFailure(handle, name, message) {
    const errorClass = handle.errorClass;
    return errorClass ? new errorClass(name, message) : new CapturedError(message);
}
/**
 * The stable wrapper for one member name: created once per namespace and reused
 * forever, so a retained closure still resolves to the CURRENT run's host
 * implementation on a later run.
 */
function wrapperFor(handle, name) {
    const cached = capturedReflectApply(capturedMapGet, handle.wrappers, [name]);
    if (cached)
        return cached;
    const wrapper = handle.global === 'refine'
        ? (...args) => callRefineBinding(handle, name, args)
        : (args) => callBinding(handle, name, args);
    capturedReflectApply(capturedMapSet, handle.wrappers, [name, wrapper]);
    return wrapper;
}
/** Model the packaged refine Skill's small script API over its private host binding. */
function callRefineBinding(handle, name, args) {
    if (name === 'status') {
        if (args.length !== 0)
            return Promise.reject(bindingFailure(handle, name, 'refine.status() accepts no arguments'));
        return callBinding(handle, name, capturedObjectCreate(null));
    }
    if (name !== 'run')
        return Promise.reject(bindingFailure(handle, name, `unknown refine member ${capturedJsonStringify(name)}`));
    if (args.length > 2)
        return Promise.reject(bindingFailure(handle, name, 'refine.run() accepts instructions and options'));
    const instructions = args[0];
    if (instructions !== undefined && typeof instructions !== 'string') {
        return Promise.reject(bindingFailure(handle, name, 'refine.run() instructions must be a string'));
    }
    const options = args[1];
    let scope;
    if (options !== undefined) {
        if (typeof options !== 'object' || options === null || capturedArrayIsArray(options)) {
            return Promise.reject(bindingFailure(handle, name, 'refine.run() options must be an object'));
        }
        const keys = capturedReflectOwnKeys(options);
        if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'scope')) {
            return Promise.reject(bindingFailure(handle, name, 'refine.run() options accept only scope'));
        }
        scope = options.scope;
        if (scope !== undefined && scope !== 'local' && scope !== 'global') {
            return Promise.reject(bindingFailure(handle, name, 'refine.run() scope must be local or global'));
        }
    }
    const request = capturedObjectCreate(null);
    if (instructions !== undefined)
        request.instructions = instructions;
    if (scope !== undefined)
        request.scope = scope;
    return callBinding(handle, name, request);
}
/** Validate the lease at CALL time, then bridge one call over the private port. */
function callBinding(handle, name, args) {
    const runId = leasedRunId();
    if (runId === undefined) {
        return Promise.reject(bindingFailure(handle, name, `tool lease revoked for ${handle.global}.${name}: it is not callable outside its own run`));
    }
    if (!capturedReflectApply(capturedSetHas, handle.allowed, [name])) {
        return Promise.reject(bindingFailure(handle, name, `unknown binding ${capturedJsonStringify(`${handle.global}.${name}`)}`));
    }
    const run = active;
    let json;
    try {
        json = capturedJsonStringify(snapshotJson(args));
    }
    catch {
        return Promise.reject(bindingFailure(handle, name, 'binding arguments must be lossless JSON'));
    }
    return new Promise((resolve, reject) => {
        const id = run.nextCallId++;
        capturedReflectApply(capturedMapSet, run.pending, [id, {
                resolve,
                reject: (message) => { reject(bindingFailure(handle, name, message)); },
            }]);
        post({ type: 'call', runId, nonce: run.nonce, id, global: handle.global, name, json });
    });
}
/**
 * The cross-run proxy for one namespace global. Its identity never changes, so
 * a closure the program persisted keeps working; what changes each run is the
 * leased member set behind it.
 */
function ensureHandle(global) {
    const cached = capturedReflectApply(capturedMapGet, handles, [global]);
    if (cached)
        return cached;
    const target = capturedObjectCreate(null);
    const handle = {
        global,
        proxy: target,
        wrappers: new CapturedMap(),
        allowed: new CapturedSet(),
        errorClass: undefined,
    };
    handle.proxy = new Proxy(target, {
        get: (_target, property) => typeof property === 'string' && capturedReflectApply(capturedSetHas, handle.allowed, [property])
            ? wrapperFor(handle, property)
            : undefined,
        has: (_target, property) => typeof property === 'string' && capturedReflectApply(capturedSetHas, handle.allowed, [property]),
        ownKeys: () => {
            const names = [];
            capturedReflectApply(capturedSetForEach, handle.allowed, [(name) => {
                    capturedReflectApply(capturedArrayPush, names, [name]);
                }]);
            return names;
        },
        getOwnPropertyDescriptor: (_target, property) => typeof property === 'string'
            && capturedReflectApply(capturedSetHas, handle.allowed, [property])
            ? { value: wrapperFor(handle, property), enumerable: true, configurable: true, writable: false }
            : undefined,
        getPrototypeOf: () => null,
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
    });
    installReadonlyGlobal(global, handle.proxy);
    capturedReflectApply(capturedMapSet, handles, [global, handle]);
    return handle;
}
/** Install exactly this run's lease across every namespace the realm has ever seen. */
function installNamespaces(specs) {
    capturedReflectApply(capturedMapForEach, handles, [(handle) => {
            capturedReflectApply(capturedSetClear, handle.allowed, []);
            handle.errorClass = undefined;
        }]);
    for (let specIndex = 0; specIndex < specs.length; specIndex++) {
        const spec = specs[specIndex];
        const handle = ensureHandle(spec.global);
        for (let nameIndex = 0; nameIndex < spec.names.length; nameIndex++) {
            const name = spec.names[nameIndex];
            capturedReflectApply(capturedSetAdd, handle.allowed, [name]);
        }
        handle.errorClass = spec.errorClass ? ensureErrorClass(spec.errorClass) : undefined;
    }
}
/** Revoke every lease. Called before a run's terminal message reaches the host. */
function revokeLeases() {
    capturedReflectApply(capturedMapForEach, handles, [(handle) => {
            capturedReflectApply(capturedSetClear, handle.allowed, []);
        }]);
}
/** A walk with no ceiling at all, for values that are not completions. */
const UNLIMITED = Number.POSITIVE_INFINITY;
function newCaptureStats(nodeLimit, byteLimit, fullLimit) {
    const stats = capturedObjectCreate(null);
    stats.nodes = 0;
    stats.nodeLimit = nodeLimit;
    stats.overNodeLimit = false;
    stats.bytes = 0;
    stats.byteLimit = byteLimit;
    stats.fullLimit = fullLimit;
    stats.aborted = false;
    stats.depth = 0;
    stats.projectionNodes = 0;
    return stats;
}
/**
 * Charge one value's shortest legal serialization, ending the walk if the total
 * proves the value is beyond use.
 *
 * Two ways out, and both have to hold something. Past `byteLimit` the value can
 * neither be retained nor sent whole, so nothing is lost by stopping. Past
 * `fullLimit` it can no longer be sent whole either, but stopping is only
 * justified once the node budget has ALSO been blown — otherwise the walk would
 * abandon a value retention was still willing to take.
 */
function chargeCapture(stats, bytes) {
    stats.bytes += bytes;
    if (stats.bytes > stats.byteLimit || (stats.overNodeLimit && stats.bytes > stats.fullLimit))
        stats.aborted = true;
}
/**
 * The projector's hard limits, grounded in the checked-in projection
 * measurements under `bench/results/`. They bound the projection independently
 * of the value: whatever the walk is looking at, at most this many nodes of it
 * are ever rendered.
 */
const PROJECTION_DEPTH = 4;
const PROJECTION_ARRAY_SAMPLE = 8;
const PROJECTION_KEY_SAMPLE = 16;
const PROJECTION_STRING_CHARS = 256;
const PROJECTION_NODES = 512;
function newProjectionSlot(stats) {
    if (stats.projectionNodes >= PROJECTION_NODES)
        return undefined;
    stats.projectionNodes += 1;
    const slot = capturedObjectCreate(null);
    slot.node = undefined;
    return slot;
}
/**
 * Cut one string to the projector's character budget without splitting a
 * surrogate pair. A naive `slice` breaks this by leaving a lone high surrogate
 * that no longer names the character it came from.
 */
function truncateForProjection(text) {
    let end = PROJECTION_STRING_CHARS;
    const code = capturedReflectApply(capturedStringCharCodeAt, text, [end - 1]);
    if (code >= 0xd800 && code <= 0xdbff)
        end -= 1;
    return capturedReflectApply(capturedStringSlice, text, [0, end]);
}
/** A string as the projection renders it: itself when short, its head when not. */
function projectString(text) {
    if (text.length <= PROJECTION_STRING_CHARS)
        return text;
    const node = capturedObjectCreate(null);
    node.type = 'string';
    node.length = text.length;
    node.prefix = truncateForProjection(text);
    return node;
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
function projectKeyEntry(key) {
    const entry = capturedObjectCreate(null);
    if (key.length <= PROJECTION_STRING_CHARS) {
        entry.key = key;
        return entry;
    }
    entry.key = truncateForProjection(key);
    entry.keyLength = key.length;
    return entry;
}
/**
 * Validate and detach one boundary value as lossless JSON. Values that JSON
 * would drop, coerce, or fail to round-trip throw: non-finite numbers, negative
 * zero, functions, symbols, bigints, exotic prototypes, sparse or
 * extra-propertied arrays, symbol/non-enumerable properties, and cycles.
 */
function snapshotJson(value) {
    return snapshotValue(value, new CapturedSet(), newCaptureStats(UNLIMITED, UNLIMITED, UNLIMITED), undefined);
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
function snapshotValue(value, seen, stats, slot) {
    if (stats.aborted)
        return undefined;
    stats.nodes += 1;
    if (stats.nodes > stats.nodeLimit)
        stats.overNodeLimit = true;
    if (value === null) {
        chargeCapture(stats, 4);
        if (slot)
            slot.node = null;
        return null;
    }
    const kind = typeof value;
    if (kind === 'boolean') {
        chargeCapture(stats, value === true ? 4 : 5);
        if (slot)
            slot.node = value;
        return value;
    }
    if (kind === 'string') {
        // One byte per UTF-16 unit is a floor: a surrogate pair costs two units and
        // four UTF-8 bytes, and every escape only adds.
        chargeCapture(stats, 2 + value.length);
        if (slot)
            slot.node = projectString(value);
        return value;
    }
    if (kind === 'number') {
        if (!capturedNumberIsFinite(value) || capturedObjectIs(value, -0))
            throw new CapturedError('value is not lossless JSON');
        // One digit, which every number has and some have twenty-odd of. This is the
        // loosest charge the walk makes, and it is left loose deliberately: a tighter
        // one costs a length computation per number, while the property that matters
        // — a ceiling that does not grow with the value — holds either way, since the
        // longest legal JSON number is a constant.
        chargeCapture(stats, 1);
        if (slot)
            slot.node = value;
        return value;
    }
    if (kind !== 'object')
        throw new CapturedError('value is not lossless JSON');
    const source = value;
    if (capturedReflectApply(capturedSetHas, seen, [source]))
        throw new CapturedError('value is not lossless JSON');
    capturedReflectApply(capturedSetAdd, seen, [source]);
    stats.depth += 1;
    // Children are sampled only while the container itself sits inside the depth
    // budget; deeper containers still report their size, just not their contents.
    const sampling = slot !== undefined && stats.depth <= PROJECTION_DEPTH;
    let snapshot;
    if (capturedArrayIsArray(source)) {
        const items = source;
        chargeCapture(stats, items.length > 0 ? items.length + 1 : 2);
        const sample = sampling ? [] : undefined;
        if (slot) {
            const node = capturedObjectCreate(null);
            node.type = 'array';
            node.length = items.length;
            if (sample)
                node.items = sample;
            slot.node = node;
        }
        const target = [];
        for (let index = 0; index < items.length; index++) {
            // Before the element is READ, so a capture the ceiling already stopped
            // does not reach an index accessor it had decided not to need.
            if (stats.aborted)
                break;
            if (!capturedObjectHasOwn(items, index))
                throw new CapturedError('value is not lossless JSON');
            const child = sample !== undefined && index < PROJECTION_ARRAY_SAMPLE ? newProjectionSlot(stats) : undefined;
            capturedReflectApply(capturedArrayPush, target, [snapshotValue(items[index], seen, stats, child)]);
            // An unvisited child left its slot empty. Rendering it would put a `null`
            // in the sample, and a projected `null` means the walk SAW a null.
            if (child && child.node !== undefined)
                capturedReflectApply(capturedArrayPush, sample, [child.node]);
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
            throw new CapturedError('value is not lossless JSON');
        }
        snapshot = target;
    }
    else {
        const prototype = capturedObjectGetPrototypeOf(source);
        if (prototype !== null && prototype !== capturedObjectPrototype)
            throw new CapturedError('value is not lossless JSON');
        const target = capturedObjectCreate(null);
        const keys = capturedReflectOwnKeys(source);
        chargeCapture(stats, keys.length > 0 ? keys.length + 1 : 2);
        const entries = sampling ? [] : undefined;
        if (slot) {
            const node = capturedObjectCreate(null);
            node.type = 'object';
            node.keyCount = keys.length;
            if (entries)
                node.keys = entries;
            slot.node = node;
        }
        let visited = keys.length;
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            if (typeof key !== 'string' || !capturedReflectApply(capturedPropertyIsEnumerable, source, [key])) {
                throw new CapturedError('value is not lossless JSON');
            }
            chargeCapture(stats, key.length + 3);
            // The name has been charged and the value has NOT been read. Stopping in
            // this gap is what keeps an aborted capture from invoking a getter it had
            // already decided it did not need — and a getter that THREW there would
            // turn a run the projector was about to answer successfully into a
            // failure. This key counts as unvisited, so the fill below names it.
            if (stats.aborted) {
                visited = index;
                break;
            }
            const child = entries !== undefined && index < PROJECTION_KEY_SAMPLE ? newProjectionSlot(stats) : undefined;
            let entry;
            if (child && entries) {
                // Recorded from the enumeration above rather than from a second one, and
                // recorded BEFORE the child is visited so an abort inside it still
                // leaves the key named.
                entry = projectKeyEntry(key);
                capturedReflectApply(capturedArrayPush, entries, [entry]);
            }
            const childValue = source[key];
            target[key] = snapshotValue(childValue, seen, stats, child);
            if (child && entry && child.node !== undefined)
                entry.value = child.node;
            if (stats.aborted) {
                visited = index + 1;
                break;
            }
        }
        // The walk stopped inside one child, so later siblings were never read.
        // Their names are already in hand from the single enumeration and cost
        // nothing to report; sampling values would fire getters the aborted walk
        // deliberately left untouched.
        if (stats.aborted && entries !== undefined) {
            for (let index = visited; index < keys.length && index < PROJECTION_KEY_SAMPLE; index++) {
                const key = keys[index];
                if (typeof key !== 'string')
                    break;
                capturedReflectApply(capturedArrayPush, entries, [projectKeyEntry(key)]);
            }
        }
        snapshot = target;
    }
    stats.depth -= 1;
    capturedReflectApply(capturedSetDelete, seen, [source]);
    return snapshot;
}
/**
 * The latest retained completion. This is the program's ORIGINAL value, not a
 * copy: retaining a snapshot would duplicate the live graph and would also lose
 * exact object identity. `undefined` means there is no retained completion;
 * successful undefined completions deliberately leave this slot unchanged.
 */
let latestCompletion;
/** Model-visible automatic last-completion intrinsic; see `protocol.ts`. */
const LAST_RESULT_GLOBAL = '$_';
/** Emitted once when the program takes the runtime-owned name for itself. */
const LAST_RESULT_CLAIMED_NOTICE = `[prime-realm] ${LAST_RESULT_GLOBAL} is now a program variable, `
    + 'so automatic last-result tracking is off; save important results to named variables before running another value-producing cell';
/**
 * Restates `DEFAULT_COMPLETION_RETENTION_LIMITS` in `./protocol.ts`, which this
 * module cannot import at runtime. The host sends the realm's real limits with
 * every run, before any completion can be captured.
 */
let retentionLimits = {
    maxCompletionRetainedBytes: 8_388_608,
    maxCompletionRetainedNodes: 1_000_000,
    maxCompletionOpaqueBytes: 8_388_608,
    maxCompletionOpaqueNodes: 262_144,
};
/** Restates `DEFAULT_COMPLETION_PROJECTION_LIMITS`, on the same terms. */
let projectionLimits = {
    maxCompletionFullBytes: 65_536,
    maxCompletionProjectionBytes: 4_096,
};
/**
 * This run's contribution to the realm's bounded metrics.
 *
 * Module state read by `startRun` after the boundary call rather than carried
 * back through it: the Inspector bridge revalidates every field of the fragment
 * it detaches, and there is nothing to gain from teaching it to revalidate
 * counters that never left this isolate.
 */
let runMetrics = {};
/** Official tool text keyed by the exact canonical object returned to model code. */
const completionPresentations = new CapturedWeakMap();
/**
 * Classify a completion without consulting its rendering hooks.
 *
 * `Array.isArray` is the one call here that can throw — a revoked proxy — and
 * the opaque path answers with the safe `typeof` verdict instead.
 */
function completionType(value) {
    if (value === null)
        return 'null';
    try {
        if (capturedArrayIsArray(value))
            return 'array';
    }
    catch {
        // A revoked proxy: not an array by any test the program cannot veto.
    }
    return typeof value;
}
/**
 * Replace the single retained slot with one lossless-JSON completion.
 *
 * A refused non-undefined completion clears the former value: keeping it would
 * make `$_` claim to be the latest completion when the actual latest value was
 * not retained. Returning the same object simply assigns that identical object
 * again; single-slot replacement needs no identity-deduplication path.
 */
function retainCompletion(value, bytes, stats) {
    const retained = !stats.overNodeLimit
        && bytes <= retentionLimits.maxCompletionRetainedBytes
        && stats.nodes <= retentionLimits.maxCompletionRetainedNodes;
    latestCompletion = retained ? value : undefined;
    return retained;
}
/**
 * Replace the single retained slot with one NON-JSON live completion.
 *
 * The opaque budget uses only the bounded classification walk's charge; the
 * value is never serialized or traversed a second time.
 */
function retainOpaqueCompletion(value, stats) {
    const retained = stats.bytes <= retentionLimits.maxCompletionOpaqueBytes
        && stats.nodes <= retentionLimits.maxCompletionOpaqueNodes;
    latestCompletion = retained ? value : undefined;
    return retained;
}
/**
 * Refuse an intrinsic access from outside the cell that owns the caller.
 *
 * Without this fence, a continuation parked by an earlier cell could read or
 * claim a later cell's retained value.
 */
function requireCompletionRun() {
    if (leasedRunId() === undefined) {
        throw new CapturedError(`${LAST_RESULT_GLOBAL} is only reachable while its own cell is running`);
    }
}
/**
 * Hand the intrinsic name over to the program, as an ordinary global assignment
 * would leave it. The retained slot stays runtime-owned but is no longer
 * model-reachable in this worker generation.
 */
function claimLastResultName(assigned) {
    capturedObjectDefineProperty(globalThis, LAST_RESULT_GLOBAL, {
        value: assigned,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}
/**
 * Build the configurable `$_` accessor.
 *
 * Configurability lets a lexical declaration shadow it with the same semantics
 * as Node's REPL `_`. Both getter and setter are fenced against detached
 * continuations. Assignment retires the accessor for this generation, which
 * also makes the namespace notice single-shot.
 */
function lastResultDescriptor() {
    const descriptor = capturedObjectCreate(null);
    descriptor.get = () => {
        requireCompletionRun();
        return latestCompletion;
    };
    descriptor.set = (assigned) => {
        requireCompletionRun();
        claimLastResultName(assigned);
        emit(LAST_RESULT_CLAIMED_NOTICE);
    };
    descriptor.enumerable = false;
    descriptor.configurable = true;
    return descriptor;
}
/**
 * Install `$_`, or reinstall it after the program deleted it. An assignment
 * leaves a data property and is intentionally respected for this generation.
 */
function installCompletionIntrinsic() {
    if (!capturedObjectHasOwn(globalThis, LAST_RESULT_GLOBAL)) {
        capturedObjectDefineProperty(globalThis, LAST_RESULT_GLOBAL, lastResultDescriptor());
    }
}
installCompletionIntrinsic();
/** Build the fixed overflow fragment without carrying the rejected bytes. */
function outputLimit(maxOutputBytes) {
    return { error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` } };
}
/** Admit one bounded failure message, or replace it with the fixed overflow diagnostic. */
function boundedFailure(kind, message, remaining, maxOutputBytes) {
    if (capturedBufferByteLength(capturedJsonStringify(message), 'utf8') > remaining)
        return outputLimit(maxOutputBytes);
    return { error: { kind, message } };
}
/**
 * Set while the fragment `prepareCompletion` produced is a projection envelope,
 * so `startRun` can mark the terminal message. Read once, immediately after the
 * boundary call; see `runMetrics` for why it travels in module state.
 */
let projectedCompletion = false;
/**
 * Render one bounded preview of a completion the model is not being shown.
 *
 * The chain is `rich -> minimal -> output-limit`, and both rungs are tested
 * against the SAME two ceilings: the projection budget, which bounds what a
 * completion may cost the conversation, and the wire budget left after logs,
 * which bounds what the protocol can carry. Retention state is content-free and
 * tells the model whether the original value remains reachable as `$_`.
 */
function projectCompletion(value, retained, bytes, projection, remaining, maxOutputBytes) {
    const budget = projectionLimits.maxCompletionProjectionBytes < remaining
        ? projectionLimits.maxCompletionProjectionBytes
        : remaining;
    const type = completionType(value);
    const rich = capturedObjectCreate(null);
    rich.retained = retained;
    rich.type = type;
    // Reported whenever the walk MEASURED it. A capture the ceiling cut short
    // never learned the real size, and a lower bound reported as an exact number
    // would be a measurement nobody took.
    if (bytes !== undefined)
        rich.serializedBytesAtCapture = bytes;
    if (projection !== undefined)
        rich.projection = projection;
    if (!retained)
        rich.reason = bytes === undefined ? 'too large to capture' : 'too large to retain';
    rich.truncated = true;
    const richJson = capturedJsonStringify(rich);
    if (capturedBufferByteLength(richJson, 'utf8') <= budget)
        return { json: richJson };
    const minimal = capturedObjectCreate(null);
    minimal.retained = retained;
    minimal.type = type;
    minimal.truncated = true;
    const minimalJson = capturedJsonStringify(minimal);
    if (capturedBufferByteLength(minimalJson, 'utf8') <= remaining)
        return { json: minimalJson };
    return outputLimit(maxOutputBytes);
}
/**
 * The FIXED envelope a NON-JSON completion crosses as, whatever it was.
 *
 * The value itself never serializes, and rendering it would mean calling the
 * program's own hooks — toJSON, toString, inspect, or any proxy trap — so the
 * envelope deliberately carries no contents: only retention state, the safe
 * typeof-grade type, and the `opaque: true` marker. A retained value remains
 * reachable as `$_`. The chain is the same rich -> minimal -> output-limit as
 * the JSON projector's.
 */
function projectOpaqueCompletion(value, retained, remaining, maxOutputBytes) {
    const budget = projectionLimits.maxCompletionProjectionBytes < remaining
        ? projectionLimits.maxCompletionProjectionBytes
        : remaining;
    const type = completionType(value);
    const rich = capturedObjectCreate(null);
    rich.retained = retained;
    rich.type = type;
    rich.opaque = true;
    // The value was never measured (measuring it would run the program's own
    // code), so there is no capture size to report and no reason to invent one.
    if (!retained)
        rich.reason = 'opaque retention budget exceeded';
    rich.truncated = true;
    const richJson = capturedJsonStringify(rich);
    if (capturedBufferByteLength(richJson, 'utf8') <= budget)
        return { json: richJson };
    const minimal = capturedObjectCreate(null);
    minimal.retained = retained;
    minimal.type = type;
    minimal.opaque = true;
    minimal.truncated = true;
    const minimalJson = capturedJsonStringify(minimal);
    if (capturedBufferByteLength(minimalJson, 'utf8') <= remaining)
        return { json: minimalJson };
    return outputLimit(maxOutputBytes);
}
/**
 * Prepare a program completion. Small lossless JSON crosses whole; large JSON
 * crosses as a bounded preview; non-JSON live values cross as opaque metadata.
 * Every successful non-undefined completion decides the single retained slot
 * before the run's Inspector object group is released. A rejected completion
 * clears the previous slot, while `undefined` deliberately leaves it untouched.
 *
 * The one bounded walk classifies the value and gathers the applicable admission
 * charge. It is never repeated because another traversal could invoke program
 * getters again. Retained values are always the program's originals, preserving
 * exact identity through `$_`.
 */
function prepareCompletion(value, remaining, maxOutputBytes) {
    if (value === undefined)
        return {};
    // The walk may stop only once the value is beyond BOTH uses it could still be
    // put to. A small retention ceiling must not turn an otherwise ordinary
    // mid-sized result into a preview.
    const full = projectionLimits.maxCompletionFullBytes;
    const retainedBytes = retentionLimits.maxCompletionRetainedBytes;
    const stats = newCaptureStats(retentionLimits.maxCompletionRetainedNodes, retainedBytes > full ? retainedBytes : full, full);
    const slot = capturedObjectCreate(null);
    slot.node = undefined;
    let snapshot;
    try {
        snapshot = snapshotValue(value, new CapturedSet(), stats, slot);
    }
    catch {
        // NON-JSON live value: retain it under the opaque budgets and answer with
        // fixed metadata. The walk already stopped at the first thing it would not
        // render, so no program hook is consulted merely to present the result.
        projectedCompletion = true;
        const retained = retainOpaqueCompletion(value, stats);
        runMetrics.retained = retained;
        runMetrics.rejected = !retained;
        return projectOpaqueCompletion(value, retained, remaining, maxOutputBytes);
    }
    projectedCompletion = true;
    if (stats.aborted) {
        // Past the capture ceiling: exact measurement and retention are both
        // impossible without resuming a walk that was deliberately bounded.
        latestCompletion = undefined;
        runMetrics.rejected = true;
        return projectCompletion(value, false, undefined, slot.node, remaining, maxOutputBytes);
    }
    let json;
    try {
        json = capturedJsonStringify(snapshot);
    }
    catch {
        /* c8 ignore next 2 -- unreachable: the walk already refused everything JSON cannot render, so the detached snapshot always serializes. */
        return boundedFailure('invalid-output', 'program completion must be lossless JSON', remaining, maxOutputBytes);
    }
    const bytes = capturedBufferByteLength(json, 'utf8');
    const retained = retainCompletion(value, bytes, stats);
    runMetrics.captureBytes = bytes;
    runMetrics.captureNodes = stats.nodes;
    runMetrics.retained = retained;
    runMetrics.rejected = !retained;
    if (bytes <= projectionLimits.maxCompletionFullBytes && bytes <= remaining) {
        projectedCompletion = false;
        return { json };
    }
    return projectCompletion(value, retained, bytes, slot.node, remaining, maxOutputBytes);
}
/** Prepare a thrown program value as one concise diagnostic; internal stacks are not model-actionable. */
function prepareException(error, remaining, maxOutputBytes) {
    let message;
    try {
        const detail = error instanceof CapturedError ? error.message : error;
        message = typeof detail === 'string' ? detail : String(detail);
    }
    catch {
        message = 'program threw an unrenderable value';
    }
    return boundedFailure('exception', message, remaining, maxOutputBytes);
}
const INTERNAL_BOUNDARY_GROUP = 'dsh-prime-internal-boundary';
const INTERNAL_BOUNDARY_GLOBAL = '__dsh_prime_internal_boundary__';
const CALL_BOUNDARY = 'function(kind, value, remaining, maxOutputBytes) { return this(kind, value, remaining, maxOutputBytes); }';
/** One retained module-local entry point shared by completion and exception values. */
function prepareBoundary(kind, value, remaining, maxOutputBytes) {
    if (kind === 'completion' && typeof value === 'object' && value !== null) {
        const presentation = capturedReflectApply(capturedWeakMapGet, completionPresentations, [value]);
        if (presentation !== undefined)
            return prepareCompletion(presentation, remaining, maxOutputBytes);
    }
    return kind === 'completion'
        ? prepareCompletion(value, remaining, maxOutputBytes)
        : prepareException(value, remaining, maxOutputBytes);
}
/** Convert one Inspector value into a same-world call argument without serializing it. */
function callArgument(value) {
    const argument = capturedObjectCreate(null);
    if (capturedObjectHasOwn(value, 'objectId') && value.objectId !== undefined) {
        argument.objectId = value.objectId;
    }
    else if (capturedObjectHasOwn(value, 'unserializableValue') && value.unserializableValue !== undefined) {
        argument.unserializableValue = value.unserializableValue;
    }
    else if (capturedObjectHasOwn(value, 'value')) {
        argument.value = value.value;
    }
    return argument;
}
/** Detach the trusted, already-validated boundary envelope returned by value. */
function doneFragment(value) {
    if (!capturedObjectHasOwn(value, 'value') || typeof value.value !== 'object' || value.value === null) {
        throw new CapturedError('Inspector boundary returned an invalid terminal fragment');
    }
    const fragment = value.value;
    const hasJson = capturedObjectHasOwn(fragment, 'json');
    const hasError = capturedObjectHasOwn(fragment, 'error');
    if (hasJson && hasError)
        throw new CapturedError('Inspector boundary returned an ambiguous terminal fragment');
    if (hasJson) {
        if (typeof fragment.json !== 'string')
            throw new CapturedError('Inspector boundary returned invalid completion JSON');
        return { json: fragment.json };
    }
    if (!hasError)
        return {};
    const error = fragment.error;
    if (typeof error !== 'object' || error === null)
        throw new CapturedError('Inspector boundary returned an invalid failure');
    const record = error;
    const kind = record.kind;
    if ((kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') || typeof record.message !== 'string') {
        throw new CapturedError('Inspector boundary returned an invalid failure');
    }
    return { error: { kind, message: record.message } };
}
const inspectorSession = new InspectorSession();
inspectorSession.connect();
await inspectorSession.post('Runtime.enable');
// Inspector has no API for turning a module-local JS value into a RemoteObject.
// Expose the dispatcher only long enough to retain its handle, before any model
// code can run, then delete the sole program-visible route to it.
capturedObjectDefineProperty(globalThis, INTERNAL_BOUNDARY_GLOBAL, {
    value: prepareBoundary,
    enumerable: false,
    writable: false,
    configurable: true,
});
let retainedBoundary;
try {
    retainedBoundary = await inspectorSession.post('Runtime.evaluate', {
        expression: `globalThis[${capturedJsonStringify(INTERNAL_BOUNDARY_GLOBAL)}]`,
        objectGroup: INTERNAL_BOUNDARY_GROUP,
        includeCommandLineAPI: false,
        silent: true,
        returnByValue: false,
        generatePreview: false,
    });
}
finally {
    if (!capturedReflectDeleteProperty(globalThis, INTERNAL_BOUNDARY_GLOBAL)) {
        throw new CapturedError('failed to hide the Inspector boundary bridge');
    }
}
if (capturedObjectHasOwn(retainedBoundary, 'exceptionDetails') || retainedBoundary.result.objectId === undefined) {
    throw new CapturedError('failed to retain the Inspector boundary bridge');
}
const boundaryObjectId = retainedBoundary.result.objectId;
/** Run the existing boundary policy against a RemoteObject in its own V8 world. */
async function prepareRemoteBoundary(kind, value, remaining, maxOutputBytes, objectGroup) {
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
        return prepareBoundary(kind, value.value, remaining, maxOutputBytes);
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
    });
    if (capturedObjectHasOwn(prepared, 'exceptionDetails')) {
        throw new CapturedError('Inspector boundary execution failed');
    }
    return doneFragment(prepared.result);
}
/** Execute one program body, then settle exactly once. */
async function startRun(message) {
    const run = {
        id: message.runId,
        nonce: message.nonce,
        logs: new LogBuffer(message.maxOutputBytes, message.runId, message.nonce),
        pending: new CapturedMap(),
        nextCallId: 1,
        timers: [],
        cancel: new CapturedAbortController(),
    };
    active = run;
    runMetrics = capturedObjectCreate(null);
    projectedCompletion = false;
    // Everything from lease installation onwards is inside the guard: a run must
    // reach exactly one terminal message even if the SETUP fails, or the host
    // waits out its wall clock for a message that is never coming.
    let done;
    const objectGroup = `dsh-prime-run-${run.id}`;
    try {
        // Inside the guard with the rest of the setup: a malformed run message must
        // still reach a terminal, not strand the host waiting out its wall clock.
        retentionLimits = message.completion.retention;
        projectionLimits = message.completion.projection;
        installCompletionIntrinsic();
        installNamespaces(message.namespaces);
        const parameters = {
            // Keep the directive and neutral completion on the program's first physical
            // line so declarations yield undefined without shifting later source lines.
            expression: `'use strict';void 0;${message.code}\n//# sourceURL=dsh-prime-cell-${run.id}.mjs`,
            objectGroup,
            includeCommandLineAPI: false,
            silent: true,
            returnByValue: false,
            generatePreview: false,
            awaitPromise: true,
            disableBreaks: true,
            replMode: true,
        };
        const evaluated = await capturedReflectApply(capturedAsyncLocalStorageRun, runContext, [
            run.id,
            () => inspectorSession.post('Runtime.evaluate', parameters),
        ]);
        const exceptionDetails = capturedObjectHasOwn(evaluated, 'exceptionDetails') ? evaluated.exceptionDetails : undefined;
        done = await prepareRemoteBoundary(exceptionDetails === undefined ? 'completion' : 'exception', exceptionDetails?.exception ?? evaluated.result, run.logs.remaining(), message.maxOutputBytes, objectGroup);
    }
    catch (error) {
        done = prepareException(error, run.logs.remaining(), message.maxOutputBytes);
    }
    finally {
        try {
            await inspectorSession.post('Runtime.releaseObjectGroup', { objectGroup });
        }
        catch (error) {
            done = prepareException(error, run.logs.remaining(), message.maxOutputBytes);
        }
    }
    // Revoke first, then release the run slot, then clean up the managed handles
    // this run left behind: nothing the program armed may outlive its settlement.
    revokeLeases();
    active = undefined;
    for (let timerIndex = 0; timerIndex < run.timers.length; timerIndex++) {
        const timer = run.timers[timerIndex];
        try {
            timer.clear(timer.handle);
        }
        catch {
            // A handle the program already cleared itself.
        }
    }
    // Cancels the promise-based timers this run armed. Their rejections are
    // deliberately left unhandled: nobody within this run is awaiting them, and
    // the process-level handler above keeps that from being fatal.
    run.cancel.abort();
    // Calls the program fired without awaiting can never be answered now: the
    // host stops replying at settlement. Failing them keeps a program that
    // persisted one from hanging its next run on a promise nobody will settle.
    capturedReflectApply(capturedMapForEach, run.pending, [(call) => {
            call.reject('tool lease revoked: the run that issued this call has ended');
        }]);
    capturedReflectApply(capturedMapClear, run.pending, []);
    // The projection marker is the run's own nonce, which never reaches the
    // program: a completion the model built to look like an envelope travels the
    // ordinary path and arrives without it. Set only alongside a value — a chain
    // that ran out of budget ends in `output-limit`, which is not a projection.
    const projected = projectedCompletion && done.json !== undefined ? { projected: run.nonce } : {};
    post({ type: 'done', runId: run.id, nonce: run.nonce, ...done, ...projected, metrics: runMetrics });
}
port.on('message', (message) => {
    if (typeof message !== 'object' || message === null)
        return;
    if (message.type === 'run') {
        void startRun(message);
        return;
    }
    if (message.type !== 'reply')
        return;
    const run = active;
    if (run === undefined || run.id !== message.runId)
        return;
    const entry = capturedReflectApply(capturedMapGet, run.pending, [message.id]);
    if (!entry)
        return;
    capturedReflectApply(capturedMapDelete, run.pending, [message.id]);
    if (!message.ok) {
        entry.reject(message.message);
        return;
    }
    let value;
    try {
        value = capturedJsonParse(message.json);
    }
    catch {
        entry.reject('binding resolution must be lossless JSON');
        return;
    }
    if (typeof value === 'object' && value !== null && !capturedArrayIsArray(value)) {
        const envelope = value;
        if (envelope.$dshPrimeBinding === 'presentation-v1' && typeof envelope.presentation === 'string'
            && capturedObjectHasOwn(envelope, 'value')) {
            value = envelope.value;
            if (typeof value === 'object' && value !== null) {
                capturedReflectApply(capturedWeakMapSet, completionPresentations, [value, envelope.presentation]);
            }
        }
    }
    entry.resolve(value);
});
//# sourceMappingURL=realm-worker.js.map