/**
 * Long-lived realm worker: one V8 isolate per realm generation that owns a
 * `state` namespace surviving across runs, executes at most one program at a
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
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { workerData } from 'node:worker_threads';
const CapturedAbortController = AbortController;
const CapturedAbortSignal = AbortSignal;
const CapturedError = Error;
const CapturedMap = Map;
const CapturedSet = Set;
const capturedAbortSignalAny = AbortSignal.any;
const capturedArrayIsArray = Array.isArray;
const capturedBufferByteLength = Buffer.byteLength;
const capturedJsonParse = JSON.parse;
const capturedJsonStringify = JSON.stringify;
const capturedNumberIsFinite = Number.isFinite;
const capturedObjectCreate = Object.create;
const capturedObjectDefineProperty = Object.defineProperty;
const capturedObjectGetPrototypeOf = Object.getPrototypeOf;
const capturedObjectHasOwn = Object.hasOwn;
const capturedObjectIs = Object.is;
const capturedObjectPrototype = Object.prototype;
const capturedPropertyIsEnumerable = Object.prototype.propertyIsEnumerable;
const capturedReflectOwnKeys = Reflect.ownKeys;
const capturedStringSlice = String.prototype.slice;
const capturedSymbolToString = Symbol.prototype.toString;
/**
 * The async function constructor, reached through an instance because
 * `AsyncFunction` is not a global.
 */
/* c8 ignore next -- the arrow exists only to reach the AsyncFunction constructor; it is never invoked. */
const AsyncFunction = (async () => { }).constructor;
/**
 * Mirrors `HIDDEN_BINDING_MEMBER` in `./protocol.ts`, which this module cannot
 * import at runtime. Defense in depth: the host already filters the name out of
 * every namespace declaration it sends.
 */
const HIDDEN_BINDING_MEMBER = 'prime_realm_identity';
/**
 * Ceilings on the key census one settlement carries. They bound the WIRE, not
 * the notice: these names are model-chosen text, so the host clamps again when
 * it renders. Reporting more keys, or longer ones, than the host can ever show
 * would only cost a copy across the port.
 */
const MAX_REPORTED_STATE_KEYS = 24;
const MAX_REPORTED_KEY_CHARS = 64;
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
// The cross-run namespace, defined exactly once per generation. The local
// reference is what the entry-count check reads: the program cannot rebind the
// global, but reaching the namespace through it would still be a lookup model
// code participates in.
const state = capturedObjectCreate(null);
capturedObjectDefineProperty(globalThis, 'state', {
    value: state,
    writable: false,
    configurable: false,
});
const handles = new CapturedMap();
const errorClasses = new CapturedMap();
const runContext = new AsyncLocalStorage();
let active;
/** Post one control message, tolerating a host that already closed the port. */
function post(message) {
    try {
        capturedPostMessage.call(port, message);
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
    return runContext.getStore() === run.id ? run.id : undefined;
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
        const callback = [rest[0], rest[1]].find((arg) => typeof arg === 'function');
        if (callback)
            queueMicrotask(() => { callback(null); });
        return true;
    };
    stream._write = (chunk, _encoding, callback) => {
        emit(chunkText(chunk));
        callback(null);
    };
    stream._writev = (chunks, callback) => {
        for (const entry of chunks)
            emit(chunkText(entry.chunk));
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
        const handle = create(...args);
        const run = active;
        if (run !== undefined)
            run.timers.push({ clear, handle });
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
 * async work unsupported in v0.3 precisely because the set of ways an isolate
 * can schedule future work is not enumerable — `AbortSignal.timeout`,
 * `fs.watch`, sockets, and native addons all schedule outside anything patched
 * here. What the lease enforces unconditionally is the part that matters: a
 * continuation waking up late cannot call a tool or emit a log, whatever woke it.
 */
const promiseTimersModule = createRequire(import.meta.url)('node:timers/promises');
/** The current run's cancellation signal merged with whatever the caller passed. */
function runCancellation(supplied) {
    const run = active;
    const callerSignal = supplied instanceof CapturedAbortSignal ? supplied : undefined;
    if (run === undefined)
        return callerSignal;
    return callerSignal ? capturedAbortSignalAny([run.cancel.signal, callerSignal]) : run.cancel.signal;
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
            args.push(undefined);
        args[optionsIndex] = { ...options, ...signal ? { signal } : {} };
        return original(...args);
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
            return originalWait(...args);
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
 * constructor the program stored in `state` keeps its identity.
 */
function ensureErrorClass(descriptor) {
    // A JSON pair, not a delimiter-joined string: no member name can forge a
    // collision with a different class name.
    const cacheKey = capturedJsonStringify([descriptor.name, descriptor.memberNameProperty]);
    const cached = errorClasses.get(cacheKey);
    if (cached)
        return cached;
    const created = class BindingCallError extends CapturedError {
        constructor(memberName, message) {
            super(message);
            defineBindingErrorField(this, 'name', descriptor.name);
            defineBindingErrorField(this, descriptor.memberNameProperty, memberName);
        }
    };
    errorClasses.set(cacheKey, created);
    return created;
}
/** Build the namespace-specific rejection for one refused or failed binding call. */
function bindingFailure(handle, name, message) {
    const errorClass = handle.errorClass;
    return errorClass ? new errorClass(name, message) : new CapturedError(message);
}
/**
 * The stable wrapper for one member name: created once per namespace and reused
 * forever, so a function the program captured in `state` still resolves to the
 * CURRENT run's host implementation on a later run.
 */
function wrapperFor(handle, name) {
    const cached = handle.wrappers.get(name);
    if (cached)
        return cached;
    const wrapper = (args) => callBinding(handle, name, args);
    handle.wrappers.set(name, wrapper);
    return wrapper;
}
/** Validate the lease at CALL time, then bridge one call over the private port. */
function callBinding(handle, name, args) {
    const runId = leasedRunId();
    if (runId === undefined) {
        return Promise.reject(bindingFailure(handle, name, `tool lease revoked for ${handle.global}.${name}: it is not callable outside its own run`));
    }
    if (!handle.allowed.has(name)) {
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
        run.pending.set(id, {
            resolve,
            reject: (message) => { reject(bindingFailure(handle, name, message)); },
        });
        post({ type: 'call', runId, nonce: run.nonce, id, global: handle.global, name, json });
    });
}
/**
 * The cross-run proxy for one namespace global. Its identity never changes, so
 * a closure the program persisted keeps working; what changes each run is the
 * leased member set behind it.
 */
function ensureHandle(global) {
    const cached = handles.get(global);
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
        get: (_target, property) => typeof property === 'string' && handle.allowed.has(property) ? wrapperFor(handle, property) : undefined,
        has: (_target, property) => typeof property === 'string' && handle.allowed.has(property),
        ownKeys: () => [...handle.allowed],
        getOwnPropertyDescriptor: (_target, property) => typeof property === 'string' && handle.allowed.has(property)
            ? { value: wrapperFor(handle, property), enumerable: true, configurable: true, writable: false }
            : undefined,
        getPrototypeOf: () => null,
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
    });
    handles.set(global, handle);
    return handle;
}
/** Install exactly this run's lease across every namespace the realm has ever seen. */
function installNamespaces(specs) {
    for (const handle of handles.values()) {
        handle.allowed.clear();
        handle.errorClass = undefined;
    }
    for (const spec of specs) {
        const handle = ensureHandle(spec.global);
        for (const name of spec.names) {
            if (name === HIDDEN_BINDING_MEMBER)
                continue;
            handle.allowed.add(name);
        }
        handle.errorClass = spec.errorClass ? ensureErrorClass(spec.errorClass) : undefined;
    }
}
/** Revoke every lease. Called before a run's terminal message reaches the host. */
function revokeLeases() {
    for (const handle of handles.values())
        handle.allowed.clear();
}
/**
 * Validate and detach one boundary value as lossless JSON. Throws on anything
 * JSON would drop, coerce, or fail to round-trip: non-finite numbers, negative
 * zero, functions, symbols, bigints, exotic prototypes, sparse or
 * extra-propertied arrays, symbol/non-enumerable properties, and cycles.
 */
function snapshotJson(value) {
    return snapshotValue(value, new CapturedSet());
}
function snapshotValue(value, seen) {
    if (value === null)
        return null;
    const kind = typeof value;
    if (kind === 'boolean' || kind === 'string')
        return value;
    if (kind === 'number') {
        if (!capturedNumberIsFinite(value) || capturedObjectIs(value, -0))
            throw new CapturedError('value is not lossless JSON');
        return value;
    }
    if (kind !== 'object')
        throw new CapturedError('value is not lossless JSON');
    const source = value;
    if (seen.has(source))
        throw new CapturedError('value is not lossless JSON');
    seen.add(source);
    let snapshot;
    if (capturedArrayIsArray(source)) {
        const items = source;
        if (capturedReflectOwnKeys(items).length !== items.length + 1)
            throw new CapturedError('value is not lossless JSON');
        const target = [];
        for (let index = 0; index < items.length; index++) {
            if (!capturedObjectHasOwn(items, index))
                throw new CapturedError('value is not lossless JSON');
            target.push(snapshotValue(items[index], seen));
        }
        snapshot = target;
    }
    else {
        const prototype = capturedObjectGetPrototypeOf(source);
        if (prototype !== null && prototype !== capturedObjectPrototype)
            throw new CapturedError('value is not lossless JSON');
        const target = capturedObjectCreate(null);
        for (const key of capturedReflectOwnKeys(source)) {
            if (typeof key !== 'string' || !capturedPropertyIsEnumerable.call(source, key))
                throw new CapturedError('value is not lossless JSON');
            target[key] = snapshotValue(source[key], seen);
        }
        snapshot = target;
    }
    seen.delete(source);
    return snapshot;
}
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
/** Prepare the program's completion value; only lossless JSON within budget crosses. */
function prepareCompletion(value, remaining, maxOutputBytes) {
    if (value === undefined)
        return {};
    let json;
    try {
        json = capturedJsonStringify(snapshotJson(value));
    }
    catch {
        return boundedFailure('invalid-output', 'program completion must be lossless JSON', remaining, maxOutputBytes);
    }
    if (capturedBufferByteLength(json, 'utf8') > remaining)
        return outputLimit(maxOutputBytes);
    return { json };
}
/** Prepare a thrown program value without sending an unbounded stack across the port. */
function prepareException(error, remaining, maxOutputBytes) {
    let message;
    try {
        const detail = error instanceof CapturedError ? error.stack ?? error.message : error;
        message = typeof detail === 'string' ? detail : String(detail);
    }
    catch {
        message = 'program threw an unrenderable value';
    }
    return boundedFailure('exception', message, remaining, maxOutputBytes);
}
/**
 * Report `state` holding more own keys than the run was allowed, or `undefined`
 * when it is within budget. Checked at settlement rather than on write: the
 * heap is deliberately LEFT as the program built it, so the next run can prune
 * it instead of losing a generation.
 */
function stateOverflow(maxStateEntries) {
    if (maxStateEntries === undefined)
        return undefined;
    // Every own key, not just the enumerable string ones: a cap the program can
    // step around with `Object.defineProperty(state, k, { enumerable: false })`
    // or a symbol key would constrain nobody but a cooperative program.
    const entries = capturedReflectOwnKeys(state).length;
    if (entries <= maxStateEntries)
        return undefined;
    return `realm state holds ${entries} entries, over the cap of ${maxStateEntries}; delete entries from state before the next run`;
}
/**
 * The bounded census of `state` for the run notice, over the SAME own keys
 * {@link stateOverflow} counts, so what the model is shown is what the cap
 * governs. Names only; a value never crosses on this field.
 *
 * Total by construction — it runs after the program's own guard, where a throw
 * would leave the run without its terminal message: own-key enumeration invokes
 * no getter, and the symbol rendering goes through the captured intrinsic
 * rather than a `String` the program may have replaced.
 */
function stateKeys() {
    const own = capturedReflectOwnKeys(state);
    const names = [];
    for (const key of own) {
        if (names.length >= MAX_REPORTED_STATE_KEYS)
            break;
        const name = typeof key === 'string' ? key : capturedSymbolToString.call(key);
        names.push(capturedStringSlice.call(name, 0, MAX_REPORTED_KEY_CHARS));
    }
    return { names, omitted: own.length - names.length };
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
    // Everything from lease installation onwards is inside the guard: a run must
    // reach exactly one terminal message even if the SETUP fails, or the host
    // waits out its wall clock for a message that is never coming.
    let done;
    try {
        installNamespaces(message.namespaces);
        const parameterNames = [];
        const parameterValues = [];
        for (const spec of message.namespaces) {
            parameterNames.push(spec.global);
            parameterValues.push(ensureHandle(spec.global).proxy);
        }
        for (const spec of message.namespaces) {
            if (!spec.errorClass)
                continue;
            parameterNames.push(spec.errorClass.name);
            parameterValues.push(ensureErrorClass(spec.errorClass));
        }
        const program = new AsyncFunction(...parameterNames, 'console', `'use strict';\n${message.code}`);
        const value = await runContext.run(run.id, () => program(...parameterValues, consoleShim));
        done = prepareCompletion(value, run.logs.remaining(), message.maxOutputBytes);
    }
    catch (error) {
        done = prepareException(error, run.logs.remaining(), message.maxOutputBytes);
    }
    if (done.error === undefined) {
        // A run that already failed keeps its own diagnostic: the cap will bite
        // again on the next run, and replacing the program's error here would hide
        // the bug that produced it.
        const overflow = stateOverflow(message.maxStateEntries);
        if (overflow !== undefined)
            done = boundedFailure('exception', overflow, run.logs.remaining(), message.maxOutputBytes);
    }
    // Revoke first, then release the run slot, then clean up the managed handles
    // this run left behind: nothing the program armed may outlive its settlement.
    revokeLeases();
    active = undefined;
    for (const timer of run.timers) {
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
    for (const call of run.pending.values())
        call.reject('tool lease revoked: the run that issued this call has ended');
    run.pending.clear();
    // The census travels with every settlement, failed runs included: a failure
    // leaves the heap exactly as the program built it, so the names it holds are
    // still what the next run will inherit.
    post({ type: 'done', runId: run.id, nonce: run.nonce, state: stateKeys(), ...done });
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
    const entry = run.pending.get(message.id);
    if (!entry)
        return;
    run.pending.delete(message.id);
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
    entry.resolve(value);
});
//# sourceMappingURL=realm-worker.js.map