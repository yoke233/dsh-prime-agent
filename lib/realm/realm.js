/**
 * Host side of one Persistent Realm: a long-lived worker thread that keeps its
 * live namespace across runs, executes runs strictly one at a time, and leases
 * binding members only for the run that declared them.
 *
 * The seam contract is unchanged from the shipped one-shot runtime: a program
 * failure, budget expiry, abort, or substrate death RESOLVES with
 * `result.error`, and only caller misuse (running a disposed realm, declaring
 * an unusable namespace) rejects. What is new is that a normal run leaves the
 * worker alive; abort, timeout, log overflow, substrate death and protocol
 * violations hard-kill it and start a new generation.
 * @module dsh-prime-agent/realm/realm
 */
import { randomBytes } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MessageChannel, MessagePort, Worker } from 'node:worker_threads';
import { snapshotJsonValue } from '@deepseek-ai/dsh-session';
import { LAST_RESULT_GLOBAL, MIN_OUTPUT_BYTES, OutputLedger, resolveCompletionProjectionLimits, resolveCompletionRetentionLimits, } from './protocol.js';
/** A zeroed counter set, and the shape every accumulator here starts from. */
export function emptyRealmMetrics() {
    return {
        completionsFull: 0,
        completionsProjected: 0,
        completionsMinimal: 0,
        outputLimits: 0,
        captureBytes: 0,
        projectionBytes: 0,
        completionsRetained: 0,
        completionsRejected: 0,
    };
}
/** Fold one realm's counters into a running total. */
export function addRealmMetrics(total, part) {
    for (const key of Object.keys(total))
        total[key] += part[key];
    return total;
}
/**
 * How often the host samples the worker's event-loop utilization. An internal
 * cadence, not config: its only effect is budget-expiry granularity.
 */
const ELU_POLL_INTERVAL_MS = 25;
/** Node clamps a longer `setTimeout` delay to 1 ms, which would expire the run immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Width of the per-run control-channel nonce; see `RealmToHost` for what it defends. */
const NONCE_BYTES = 16;
/** The seam's language-portable identifier subset for binding globals. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Backend-owned program globals, mirroring `RESERVED_BINDING_GLOBALS` in
 * `@deepseek-ai/dsh-code-runtime`. The seam package is imported type-only here
 * so the realm never pulls it into the plugin's runtime dependency graph.
 */
const RESERVED_BINDING_GLOBALS = new Set([
    'console', '__dsh_main__', '__builtins__', '__name__', '__debug__',
]);
/** Mirrors `RESERVED_ERROR_MEMBERS` in `@deepseek-ai/dsh-code-runtime`. */
const RESERVED_ERROR_MEMBERS = new Set([
    'name', 'message', 'stack', 'args', 'with_traceback', 'add_note',
]);
/** Mirrors `DUNDER_MEMBER` in `@deepseek-ai/dsh-code-runtime`. */
const DUNDER_MEMBER = /^__.+__$/;
/** Mirrors `PORTABLE_RESERVED_WORDS` in `@deepseek-ai/dsh-code-runtime` (ECMAScript union Python). */
const PORTABLE_RESERVED_WORDS = new Set([
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
    'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
    'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package',
    'private', 'protected', 'public', 'arguments', 'eval',
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'def', 'del', 'elif', 'except', 'from',
    'global', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'match', 'type', '_',
]);
/**
 * The shell a program is wrapped in for the type-strip, matching the async
 * function body it executes as. Strip mode is position-preserving, so the
 * wrapper survives byte-identical and the body slices back out with the
 * model's own line/column positions intact.
 */
const STRIP_WRAP = { prefix: 'async function __dsh_program__() {\n', suffix: '\n}' };
/**
 * The worker entry path: TypeScript source when this module runs unbuilt (Node
 * strips the types natively), the emitted sibling ESM module otherwise. The URL
 * PATHNAME decides, because dev-time module runners may append a query string
 * to `import.meta.url`.
 */
/* c8 ignore next -- the built-lib arm is unreachable when running from source. */
const WORKER_PATH = fileURLToPath(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './realm-worker.ts' : './realm-worker.js', import.meta.url));
/** The realm's answer to any traffic the worker had no business sending. */
const PROTOCOL_VIOLATION = {
    kind: 'worker-exit',
    message: 'realm worker violated the control protocol and was terminated',
};
/**
 * Render an unknown thrown value as a message, `Error` or not. A hostile value
 * whose `message` getter or `toString` throws must not turn a `catch` block
 * into a second throw: every caller here is already on a failure path.
 */
function messageOf(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    }
    catch {
        return 'unrenderable error value';
    }
}
/**
 * Render an abort reason the way the shipped one-shot runtime does, without
 * letting a hostile `toString` throw. This runs inside an `abort` listener,
 * where a throw would reach the host's event loop rather than any caller.
 */
function renderReason(reason) {
    try {
        return String(reason);
    }
    catch {
        /* c8 ignore next -- only a reason whose own `toString` throws reaches this. */
        return 'aborted';
    }
}
/**
 * A Node error's stable `code`. It names the failure class — `ERR_MODULE_NOT_FOUND`,
 * `EMFILE` — without carrying the absolute path its `message` would, which is
 * what makes it safe to put in a model-visible substrate diagnostic.
 */
function errorCode(error) {
    const code = error?.code;
    return typeof code === 'string' && code.length > 0 ? code : 'no error code';
}
/** Resolve after a worker pipe emits all queued data, or closes/errors during termination. */
function waitForPipeDrain(stream) {
    if (stream.readableEnded || stream.destroyed)
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            stream.off('end', done);
            stream.off('close', done);
            stream.off('error', done);
            resolve();
        };
        stream.once('end', done);
        stream.once('close', done);
        stream.once('error', done);
        /* c8 ignore next -- closes the race between the state check above and listener registration. */
        if (stream.readableEnded || stream.destroyed)
            done();
    });
}
/**
 * Node's public Worker API cannot unref the shared MessagePort that backs
 * `worker.stdout` and `worker.stderr` once either stream starts reading. Find
 * that port by value rather than by Node's private symbol name, so an idle realm
 * can release every port reference while keeping the pipes reusable for the next run.
 */
function workerStdioPorts(worker) {
    const ports = new Set();
    for (const stream of [worker.stdout, worker.stderr]) {
        const record = stream;
        for (const symbol of Object.getOwnPropertySymbols(stream)) {
            const value = record[symbol];
            if (value instanceof MessagePort)
                ports.add(value);
        }
    }
    return [...ports];
}
/**
 * Runtime shape gate for inbound control traffic. The worker runs MODEL CODE,
 * so the compile-time type means nothing here: every message is re-validated
 * and REBUILT field by field. Junk returns `undefined` and is dropped, because
 * a throw in the host's `message` listener would crash the host process; a
 * WELL-FORMED message naming the wrong run is a different matter and is
 * escalated by the caller.
 */
/**
 * Rebuild one run's metrics report, keeping only fields of the right primitive
 * type. Metrics are bookkeeping, so a junk field is dropped rather than escalated
 * — losing a counter is not worth a generation.
 */
function parseRunMetrics(raw) {
    if (typeof raw !== 'object' || raw === null)
        return {};
    const source = raw;
    const metrics = {};
    for (const key of ['captureBytes', 'captureNodes']) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value))
            metrics[key] = value;
    }
    for (const key of ['retained', 'rejected']) {
        if (typeof source[key] === 'boolean')
            metrics[key] = source[key];
    }
    return metrics;
}
/**
 * Validate and translate one nonce-authenticated completion envelope into
 * content-free presentation metadata. Shape alone never reaches this function:
 * `onDone` first proves that the worker quoted this run's private nonce.
 */
function parseCompletionPresentation(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const envelope = value;
    if (envelope.truncated !== true)
        return undefined;
    if (envelope.retained !== undefined && typeof envelope.retained !== 'boolean')
        return undefined;
    if (typeof envelope.type !== 'string')
        return undefined;
    if (envelope.serializedBytesAtCapture !== undefined
        && (typeof envelope.serializedBytesAtCapture !== 'number'
            || !Number.isSafeInteger(envelope.serializedBytesAtCapture)
            || envelope.serializedBytesAtCapture < 0))
        return undefined;
    if (envelope.reason !== undefined && typeof envelope.reason !== 'string')
        return undefined;
    if (envelope.opaque !== undefined && envelope.opaque !== true)
        return undefined;
    if (envelope.retained === true) {
        if (envelope.reason !== undefined)
            return undefined;
        if (envelope.opaque === true) {
            return { kind: 'opaque-reference', valueType: envelope.type };
        }
        return {
            kind: 'retained-preview',
            valueType: envelope.type,
            ...typeof envelope.serializedBytesAtCapture === 'number'
                ? { serializedBytes: envelope.serializedBytesAtCapture }
                : {},
        };
    }
    if (envelope.retained !== false)
        return undefined;
    return {
        kind: 'unretained-preview',
        valueType: envelope.type,
        ...typeof envelope.serializedBytesAtCapture === 'number'
            ? { serializedBytes: envelope.serializedBytesAtCapture }
            : {},
        ...typeof envelope.reason === 'string' ? { reason: envelope.reason } : {},
    };
}
function parseWorkerMessage(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const message = raw;
    if (typeof message.runId !== 'number' || typeof message.nonce !== 'string')
        return undefined;
    const runId = message.runId;
    const nonce = message.nonce;
    switch (message.type) {
        case 'call': {
            if (typeof message.id !== 'number' || typeof message.global !== 'string')
                return undefined;
            if (typeof message.name !== 'string' || typeof message.json !== 'string')
                return undefined;
            return { type: 'call', runId, nonce, id: message.id, global: message.global, name: message.name, json: message.json };
        }
        case 'log': {
            if (typeof message.text !== 'string')
                return undefined;
            return { type: 'log', runId, nonce, text: message.text };
        }
        case 'output-limit': return { type: 'output-limit', runId, nonce };
        case 'done': {
            const metrics = parseRunMetrics(message.metrics);
            if (message.error !== undefined) {
                if (typeof message.error !== 'object' || message.error === null)
                    return undefined;
                const { kind, message: detail } = message.error;
                if (kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit')
                    return undefined;
                if (typeof detail !== 'string')
                    return undefined;
                return { type: 'done', runId, nonce, error: { kind, message: detail }, metrics };
            }
            if (message.json === undefined)
                return { type: 'done', runId, nonce, metrics };
            if (typeof message.json !== 'string')
                return undefined;
            // A non-string marker is not a marker. It is dropped rather than escalated:
            // the completion is still a perfectly good value, and treating it as
            // unprojected costs only a metric.
            const projected = typeof message.projected === 'string' ? message.projected : undefined;
            return { type: 'done', runId, nonce, json: message.json, metrics, ...projected !== undefined ? { projected } : {} };
        }
        default: return undefined;
    }
}
/**
 * One realm: a lazily spawned worker, a strictly serial run queue, and the
 * lifecycle bookkeeping a caller needs to tell the model its live namespace is
 * gone.
 */
export class PersistentRealm {
    /** Opaque routing identity; never rendered into a result or diagnostic. */
    realmId;
    budgets;
    completionRetention;
    completionProjection;
    counters = emptyRealmMetrics();
    queue = [];
    inflight = new Set();
    terminations = new Set();
    session;
    activeRun;
    runCounter = 0;
    generationValue = 1;
    generationBumpPending = false;
    noticePending = false;
    injectedGlobalSchema;
    lastUsed = Date.now();
    disposed = false;
    constructor(options) {
        if (options.realmId.length === 0)
            throw new Error('dsh-prime-agent: realm id must not be empty');
        this.realmId = options.realmId;
        this.completionRetention = resolveCompletionRetentionLimits(options.completionRetention);
        this.completionProjection = resolveCompletionProjectionLimits(options.completionProjection);
        this.budgets = { ...options.budgets };
        for (const [key, value] of Object.entries(this.budgets)) {
            if (!(Number.isFinite(value) && value > 0)) {
                throw new Error(`dsh-prime-agent: realm budget ${key} must be a positive number, got ${String(value)}`);
            }
        }
        if (!Number.isSafeInteger(this.budgets.maxOutputBytes) || this.budgets.maxOutputBytes < MIN_OUTPUT_BYTES) {
            throw new Error(`dsh-prime-agent: realm budget maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}`);
        }
        if (this.budgets.maxWallMs > MAX_TIMER_DELAY_MS) {
            throw new Error(`dsh-prime-agent: realm budget maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms)`);
        }
    }
    /**
     * The current worker generation, counting from 1. A hard kill schedules the
     * increment; reading it (or starting the replacement worker) materializes it,
     * so repeated reads between two runs stay stable.
     */
    get generation() {
        if (this.generationBumpPending) {
            this.generationBumpPending = false;
            this.generationValue += 1;
        }
        return this.generationValue;
    }
    /** This realm's bounded completion counters, as of the last settled run. */
    get metrics() {
        return { ...this.counters };
    }
    /** No run is active and none is waiting. */
    get idle() {
        return this.activeRun === undefined && this.queue.length === 0;
    }
    /** Epoch milliseconds of the most recent admission or settlement, for pool LRU/TTL. */
    get lastUsedAt() {
        return this.lastUsed;
    }
    /**
     * Admit one run. Runs execute in admission order, one at a time; a run still
     * queued when its signal fires cancels only itself.
     * @param request - the program, its bindings, and the abort signal.
     * @param onStart - called once if and when the run reaches a worker. A run
     *   that never dispatches (cancelled
     *   while queued, rejected by the type-strip, or unable to start a worker)
     *   never calls it, so a pending namespace-loss report survives for the run that
     *   actually inherits the new heap.
     * @returns the run's outcome; rejects only on caller misuse.
     */
    run(request, onStart) {
        if (this.disposed)
            return Promise.reject(new Error('dsh-prime-agent: realm run() after disposal'));
        let bindings;
        try {
            bindings = this.validateBindings(request);
            this.validateInjectedGlobalSchema(bindings);
        }
        catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.lastUsed = Date.now();
        let resolve;
        const settled = new Promise((done) => { resolve = done; });
        let finish;
        const finished = new Promise((done) => { finish = done; });
        const entry = {
            request,
            bindings,
            onStart,
            resolve,
            finished,
            finish,
            settled: false,
            detachAbort: undefined,
            session: undefined,
            runId: 0,
            nonce: '',
            ledger: new OutputLedger(this.budgets.maxOutputBytes),
            logs: [],
            answered: new Set(),
            hostCalls: 0,
            hostCallsInFlight: 0,
            pendingDone: undefined,
            eluBaseline: undefined,
            eluTimer: undefined,
            wallTimer: undefined,
        };
        this.inflight.add(finished);
        void finished.finally(() => { this.inflight.delete(finished); });
        const signal = request.signal;
        if (signal) {
            const onAbort = () => { this.onSignalAbort(entry); };
            entry.detachAbort = () => { signal.removeEventListener('abort', onAbort); };
            if (signal.aborted) {
                this.settle(entry, entry.ledger.failure([], { kind: 'abort', message: renderReason(signal.reason) }));
                return settled;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        this.queue.push(entry);
        this.pump();
        return settled;
    }
    /**
     * Stop admission, terminate the worker, and await complete settlement: no
     * worker, timer, or unsettled run outlives this call.
     */
    async dispose() {
        this.disposed = true;
        const abort = { kind: 'abort', message: 'realm disposed' };
        for (const entry of this.queue.splice(0))
            this.settle(entry, entry.ledger.failure([], abort));
        const session = this.session;
        const active = this.activeRun;
        if (session) {
            this.hardKill(session, entry => entry.ledger.failure(entry.logs, abort));
        }
        else if (active && active.session?.dead !== true) {
            // A run whose session is already dead belongs to a hard kill still in
            // flight: it owns the outcome and terminates the worker first, so
            // settling it here would both lose its reason and resolve `run()` while
            // the isolate is still alive.
            this.settle(active, active.ledger.failure(active.logs, abort));
        }
        await Promise.all([...this.terminations, ...this.inflight]);
    }
    /** Reject malformed binding globals or typed-error declarations as caller misuse. */
    validateBindings(request) {
        const bindings = new Map();
        for (const namespace of request.bindings) {
            // Ahead of the identifier test on purpose: a realm-owned name must be
            // refused BECAUSE it is reserved, not incidentally because of the
            // characters in it.
            if (namespace.global === LAST_RESULT_GLOBAL) {
                throw new Error(`dsh-prime-agent: reserved binding global ${JSON.stringify(namespace.global)}`);
            }
            if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
                throw new Error(`dsh-prime-agent: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`);
            }
            if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
                throw new Error(`dsh-prime-agent: reserved binding global ${JSON.stringify(namespace.global)}`);
            }
            if (bindings.has(namespace.global)) {
                throw new Error(`dsh-prime-agent: duplicate binding global ${JSON.stringify(namespace.global)}`);
            }
            const functions = namespace.functions;
            if (typeof functions !== 'object' || functions === null) {
                throw new Error(`dsh-prime-agent: binding namespace ${JSON.stringify(namespace.global)} must declare a functions record`);
            }
            bindings.set(namespace.global, namespace);
        }
        const errorClassNames = new Set();
        for (const namespace of request.bindings) {
            const descriptor = namespace.errorClass;
            if (!descriptor)
                continue;
            if (descriptor.name === LAST_RESULT_GLOBAL) {
                throw new Error(`dsh-prime-agent: reserved binding global ${JSON.stringify(descriptor.name)}`);
            }
            if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
                throw new Error(`dsh-prime-agent: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`);
            }
            if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
                throw new Error(`dsh-prime-agent: duplicate injected global ${JSON.stringify(descriptor.name)}`);
            }
            const member = descriptor.memberNameProperty;
            if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
                throw new Error(`dsh-prime-agent: binding error member property ${JSON.stringify(member)} is not usable`);
            }
            errorClassNames.add(descriptor.name);
        }
        return bindings;
    }
    /**
     * Freeze structural globals on the first valid admission. Later runs may
     * omit and restore known namespaces or change their leased function members,
     * but cannot change globals already installed in the live namespace.
     */
    validateInjectedGlobalSchema(bindings) {
        const candidate = new Map();
        for (const [global, namespace] of bindings) {
            const descriptor = namespace.errorClass;
            candidate.set(global, descriptor
                ? { name: descriptor.name, memberNameProperty: descriptor.memberNameProperty }
                : null);
        }
        const frozen = this.injectedGlobalSchema;
        if (frozen === undefined) {
            this.injectedGlobalSchema = candidate;
            return;
        }
        for (const [global, descriptor] of candidate) {
            if (!frozen.has(global)) {
                throw new Error(`dsh-prime-agent: binding namespace ${JSON.stringify(global)} was not declared by this Realm's first Prime run`);
            }
            const expected = frozen.get(global);
            const same = expected === null
                ? descriptor === null
                : descriptor !== null
                    && expected.name === descriptor.name
                    && expected.memberNameProperty === descriptor.memberNameProperty;
            if (!same) {
                throw new Error(`dsh-prime-agent: binding namespace ${JSON.stringify(global)} changed its frozen error class descriptor`);
            }
        }
    }
    /** A signal fired: cancel a queued run alone, or hard-kill the worker running an active one. */
    onSignalAbort(entry) {
        if (entry.settled)
            return;
        const reason = renderReason(entry.request.signal?.reason);
        if (this.activeRun !== entry) {
            const index = this.queue.indexOf(entry);
            if (index >= 0)
                this.queue.splice(index, 1);
            this.settle(entry, entry.ledger.failure(entry.logs, { kind: 'abort', message: reason }));
            return;
        }
        const session = entry.session;
        /* c8 ignore next -- an active entry always owns a session before it can be aborted. */
        if (!session)
            return;
        this.hardKill(session, run => run.ledger.failure(run.logs, { kind: 'abort', message: reason }));
    }
    /** Start the next queued run, if the realm is free to take one. */
    pump() {
        if (this.activeRun !== undefined || this.disposed)
            return;
        const entry = this.queue.shift();
        if (!entry)
            return;
        this.activeRun = entry;
        try {
            this.dispatch(entry);
        }
        catch (error) {
            /* c8 ignore next 2 -- dispatch is total; this is the last guard keeping a host listener from throwing. */
            this.settle(entry, entry.ledger.failure([], { kind: 'worker-exit', message: `realm dispatch failed: ${messageOf(error)}` }));
        }
        void entry.finished.then(() => { this.pump(); });
    }
    /** Type-strip the program, spawn or reuse the worker, and arm this run's budgets. */
    dispatch(entry) {
        let code;
        try {
            const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + entry.request.program + STRIP_WRAP.suffix);
            code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);
        }
        catch (error) {
            // A program that does not survive the type-strip never reaches the
            // worker, so it can neither disturb the live namespace nor cost a generation.
            this.settle(entry, entry.ledger.failure([], {
                kind: 'exception',
                message: `TypeScript parse failed before execution: ${messageOf(error)}. Correct the syntax and retry the cell.`,
            }));
            return;
        }
        // Everything derived from the request is computed before a worker or a
        // timer exists, so a malformed declaration cannot strand an armed run.
        const namespaces = [...entry.bindings].map(([global, namespace]) => ({
            global,
            names: Object.keys(namespace.functions),
            ...namespace.errorClass ? { errorClass: namespace.errorClass } : {},
        }));
        let session;
        try {
            session = this.ensureSession();
            this.refSession(session);
        }
        catch (error) {
            // The substrate refused to start; that is a failed run, not caller misuse.
            // The diagnostic is this module's own text plus Node's stable error code:
            // the underlying message would carry the worker entry's absolute path.
            this.settle(entry, entry.ledger.failure([], { kind: 'worker-exit', message: `realm worker failed to start (${errorCode(error)})` }));
            return;
        }
        entry.session = session;
        entry.runId = ++this.runCounter;
        entry.nonce = randomBytes(NONCE_BYTES).toString('base64url');
        // This run owns the worker's native pipes until it settles.
        session.strayOwner = entry;
        if (entry.onStart) {
            // Consuming the loss here — rather than when the caller admitted the run —
            // keeps it attached to the run that actually inherits the fresh heap.
            const namespaceLost = this.noticePending;
            this.noticePending = false;
            const fresh = !session.dispatched;
            try {
                entry.onStart({ fresh, namespaceLost });
            }
            catch {
                // Bookkeeping for the caller's benefit; a throw there is not the run's
                // problem and must not strand an armed dispatch.
            }
        }
        session.dispatched = true;
        entry.eluBaseline = session.worker.performance.eventLoopUtilization();
        entry.eluTimer = setInterval(() => {
            /* c8 ignore next -- the interval is cleared at settlement, so the baseline is always present here. */
            if (!entry.eluBaseline)
                return;
            const elapsed = session.worker.performance.eventLoopUtilization(entry.eluBaseline).active;
            if (elapsed > this.budgets.computeMs) {
                this.hardKill(session, run => run.ledger.failure(run.logs, {
                    kind: 'timeout',
                    message: `compute budget exhausted (${this.budgets.computeMs}ms busy)`,
                }));
            }
        }, ELU_POLL_INTERVAL_MS);
        entry.wallTimer = setTimeout(() => {
            this.hardKill(session, run => run.ledger.failure(run.logs, {
                kind: 'timeout',
                message: `wall-clock ceiling reached (${this.budgets.maxWallMs}ms)`,
            }));
        }, this.budgets.maxWallMs);
        this.post(session, {
            type: 'run',
            runId: entry.runId,
            nonce: entry.nonce,
            code,
            namespaces,
            maxOutputBytes: this.budgets.maxOutputBytes,
            completion: {
                retention: this.completionRetention,
                projection: this.completionProjection,
            },
        });
    }
    /** The live worker, spawning a new generation when the previous one is gone. */
    ensureSession() {
        const existing = this.session;
        if (existing && !existing.dead)
            return existing;
        const channel = new MessageChannel();
        let worker;
        try {
            worker = new Worker(WORKER_PATH, {
                workerData: { port: channel.port2 },
                transferList: [channel.port2],
                // Model code gets NO ambient environment, and no inherited loader flags
                // a bare isolate could not satisfy.
                env: {},
                execArgv: [],
                resourceLimits: { maxOldGenerationSizeMb: this.budgets.maxOldGenerationSizeMb },
                // Backstop capture: the worker patches JS-level writes into its own
                // ordered buffer, so these pipes normally stay silent.
                stdout: true,
                stderr: true,
            });
        }
        catch (error) {
            // Nothing was transferred, so both ends are still ours to close. The
            // generation is deliberately untouched: no isolate ever existed.
            channel.port1.close();
            channel.port2.close();
            throw error;
        }
        // Materialize a pending increment now that the worker it names exists, so
        // the generation number a caller reads cannot disagree with the heap.
        void this.generation;
        const session = {
            worker,
            port: channel.port1,
            stdioPorts: workerStdioPorts(worker),
            dead: false,
            strayOwner: undefined,
            draining: false,
            dispatched: false,
        };
        this.session = session;
        channel.port1.on('message', (raw) => { this.onControlMessage(session, raw); });
        // The program's own exceptions never arrive here — the worker catches those
        // and reports them over the control channel — so an `error` event is always
        // substrate failure, whose message would carry a host path. The exit code
        // below is Node's own and stays verbatim, matching the shipped one-shot.
        worker.on('error', (error) => { this.onWorkerGone(session, `realm worker failed outside the program (${errorCode(error)})`); });
        worker.on('exit', (code) => { this.onWorkerGone(session, `worker exited with code ${code} before completing`); });
        worker.stdout.on('data', (chunk) => { this.onStrayOutput(session, chunk); });
        worker.stderr.on('data', (chunk) => { this.onStrayOutput(session, chunk); });
        return session;
    }
    /** Keep an admitted run alive when it reuses a Worker parked while idle. */
    refSession(session) {
        if (session.dead)
            return;
        session.worker.ref();
        session.port.ref();
        for (const port of session.stdioPorts)
            port.ref();
    }
    /** Let a live but idle generation survive without owning the host lifetime. */
    unrefIdleSession(session) {
        if (!session || session.dead || this.session !== session || !this.idle)
            return;
        session.port.unref();
        for (const port of session.stdioPorts)
            port.unref();
        session.worker.unref();
    }
    /** Post one control message, tolerating a session torn down underneath us. */
    post(session, message) {
        if (session.dead)
            return;
        try {
            session.port.postMessage(message);
        }
        catch {
            // The port closed as the session died; the kill path owns the outcome.
        }
    }
    /** Route one inbound control message, escalating anything outside the protocol. */
    onControlMessage(session, raw) {
        if (session.dead)
            return;
        const active = this.activeRun;
        // A terminal closes the worker-to-host side of the run immediately. The
        // host may still be waiting for calls it already accepted, but the worker
        // has no legitimate log, call, limit, or second terminal left to send.
        if (active && !active.settled && active.session === session && active.pendingDone !== undefined) {
            this.hardKill(session, run => run.ledger.failure(run.logs, PROTOCOL_VIOLATION));
            return;
        }
        const message = parseWorkerMessage(raw);
        if (!message)
            return;
        // The nonce is the part model code cannot supply: it never reaches the
        // program, so traffic quoting it is the worker's own bookkeeping rather
        // than something forged over a stolen port.
        const owned = active !== undefined && !active.settled && active.session === session
            && active.runId === message.runId && message.nonce === active.nonce;
        if (message.type === 'log') {
            // The worker already drops output whose lease was revoked, so a stale log
            // is nothing to act on; an over-budget one ends the run.
            if (!owned || !active)
                return;
            if (!active.ledger.admit(message.text, active.logs)) {
                this.hardKill(session, run => run.ledger.limit([...run.logs, message.text]));
            }
            return;
        }
        if (message.type === 'output-limit') {
            if (!owned || !active)
                return;
            this.hardKill(session, run => run.ledger.limit(run.logs));
            return;
        }
        if (!owned || !active) {
            // A call or terminal message naming a run that is not the live one means
            // the worker is out of protocol; it does not get to keep its heap.
            this.hardKill(session, run => run.ledger.failure(run.logs, PROTOCOL_VIOLATION));
            return;
        }
        if (message.type === 'call') {
            if (active.answered.has(message.id))
                return;
            const refusal = this.admitHostCall(active);
            if (refusal !== undefined) {
                // A budget refusal is the program's to handle, so it travels as an
                // ordinary failed reply rather than costing the realm its heap. It is
                // deliberately NOT recorded in `answered`: refusal is synchronous and
                // idempotent, and retaining an id for every refused call would let a
                // program past its own call budget grow HOST memory without bound.
                this.post(session, { type: 'reply', runId: message.runId, id: message.id, ok: false, message: refusal });
                return;
            }
            active.answered.add(message.id);
            active.hostCallsInFlight += 1;
            void this.dispatchCall(session, active, message).catch(() => {
                /* c8 ignore next 2 -- dispatchCall answers every call itself; this keeps a stray throw off the host's unhandled-rejection path. */
                this.post(session, { type: 'reply', runId: message.runId, id: message.id, ok: false, message: 'binding call failed' });
            }).finally(() => { this.onHostCallSettled(active); });
            return;
        }
        active.pendingDone = message;
        if (active.hostCallsInFlight === 0)
            this.onDone(active, message);
    }
    /** Release one accepted host call and consume a waiting normal terminal. */
    onHostCallSettled(entry) {
        entry.hostCallsInFlight -= 1;
        if (entry.hostCallsInFlight !== 0 || entry.settled || entry.session?.dead === true)
            return;
        const pendingDone = entry.pendingDone;
        if (pendingDone !== undefined)
            this.onDone(entry, pendingDone);
    }
    /** Settle one run after its worker terminal and accepted host calls are both complete. */
    onDone(entry, message) {
        this.recordRunMetrics(message.metrics);
        if (message.error) {
            // A completion that overflowed the cap is reported by a worker that has
            // already finished the program, so the realm keeps its heap.
            this.settle(entry, entry.ledger.failure(entry.logs, message.error));
            return;
        }
        if (message.json === undefined) {
            this.settle(entry, entry.ledger.success(entry.logs));
            return;
        }
        let value;
        try {
            value = JSON.parse(message.json);
        }
        catch {
            this.settle(entry, entry.ledger.failure(entry.logs, { kind: 'invalid-output', message: 'program completion must be lossless JSON' }));
            return;
        }
        const bytes = Buffer.byteLength(message.json, 'utf8');
        let presentation;
        if (message.projected !== undefined) {
            // The marker quotes this run's nonce, which the program cannot read, and
            // names a shape the host is about to account for as runtime metadata. A
            // marker that fails either test is not bookkeeping this worker is entitled
            // to send.
            if (message.projected !== entry.nonce) {
                const session = entry.session;
                /* c8 ignore next -- a run with a terminal message always still owns its session. */
                if (session)
                    this.hardKill(session, run => run.ledger.failure(run.logs, PROTOCOL_VIOLATION));
                return;
            }
            presentation = parseCompletionPresentation(value);
            if (presentation === undefined) {
                const session = entry.session;
                /* c8 ignore next -- a run with a terminal message always still owns its session. */
                if (session)
                    this.hardKill(session, run => run.ledger.failure(run.logs, PROTOCOL_VIOLATION));
                return;
            }
            this.counters.completionsProjected += 1;
            this.counters.projectionBytes += bytes;
            if (value.projection === undefined)
                this.counters.completionsMinimal += 1;
        }
        else {
            this.counters.completionsFull += 1;
        }
        const result = entry.ledger.completion(entry.logs, value, bytes);
        this.settle(entry, presentation === undefined || result.error !== undefined
            ? result
            : { ...result, presentation });
    }
    /** Fold one run's worker-side completion bookkeeping into this realm's counters. */
    recordRunMetrics(metrics = {}) {
        this.counters.captureBytes += metrics.captureBytes ?? 0;
        if (metrics.retained === true)
            this.counters.completionsRetained += 1;
        if (metrics.rejected === true)
            this.counters.completionsRejected += 1;
    }
    /**
     * Charge one binding call against this run's host-call budgets, or report why
     * it is refused. Counting happens BEFORE the host function is reached, so a
     * refused call costs neither a dispatch nor a slot.
     */
    admitHostCall(entry) {
        const total = this.budgets.maxHostCallsPerRun;
        if (total !== undefined && entry.hostCalls >= total) {
            return `host call budget exhausted (${total} binding calls per run)`;
        }
        const parallel = this.budgets.maxParallelHostCallsPerRun;
        if (parallel !== undefined && entry.hostCallsInFlight >= parallel) {
            return `parallel host call budget exhausted (${parallel} binding calls in flight)`;
        }
        entry.hostCalls += 1;
        return undefined;
    }
    /** Bridge one binding call to the host function the CURRENT run declared. */
    async dispatchCall(session, entry, message) {
        const reply = (payload) => {
            if (entry.settled)
                return;
            this.post(session, payload);
        };
        const record = entry.bindings.get(message.global)?.functions;
        // Own-property lookup only: a forged name like 'constructor' must not walk
        // the record's prototype chain and reach a callable nobody declared.
        const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined;
        if (typeof fn !== 'function') {
            reply({ type: 'reply', runId: message.runId, id: message.id, ok: false, message: `unknown binding ${JSON.stringify(`${message.global}.${message.name}`)}` });
            return;
        }
        let args;
        try {
            args = JSON.parse(message.json);
        }
        catch {
            reply({ type: 'reply', runId: message.runId, id: message.id, ok: false, message: 'binding arguments must be lossless JSON' });
            return;
        }
        let resolved;
        try {
            resolved = await fn(args);
        }
        catch (error) {
            // `messageOf` cannot throw, so a hostile rejection value ends as one
            // program-visible rejection rather than an unanswered call.
            reply({ type: 'reply', runId: message.runId, id: message.id, ok: false, message: messageOf(error) });
            return;
        }
        let value;
        try {
            value = snapshotJsonValue(resolved);
        }
        catch {
            value = undefined;
        }
        if (value === undefined) {
            reply({ type: 'reply', runId: message.runId, id: message.id, ok: false, message: 'binding resolution must be lossless JSON' });
            return;
        }
        reply({ type: 'reply', runId: message.runId, id: message.id, ok: true, json: JSON.stringify(value) });
    }
    /**
     * Native-level pipe output. It belongs to the run in flight; arriving while
     * the realm is idle it is out-of-protocol activity, and the worker loses its
     * heap rather than running alongside the next run.
     */
    onStrayOutput(session, chunk) {
        if (session.dead)
            return;
        const owner = session.strayOwner;
        if (owner === undefined || owner.settled || session.draining) {
            // Bytes queued by a run that has already ended. They are not the next
            // run's output and they are not proof of live background work, so they are
            // dropped rather than charged to a run that did not write them.
            return;
        }
        const text = chunk.toString('utf8');
        // Over-budget native output is DROPPED, never fatal. These bytes bypassed
        // the worker's own capture, so the host cannot prove which run wrote them;
        // letting them end a run would hand a program a way to destroy a later run's
        // heap with writes it issued earlier.
        owner.ledger.admit(text, owner.logs);
    }
    /** The worker died on its own (OOM, `process.exit`, an uncaught throw). */
    onWorkerGone(session, detail) {
        this.hardKill(session, entry => entry.ledger.failure(entry.logs, { kind: 'worker-exit', message: detail }));
    }
    /**
     * End one worker generation: terminate it, let its pipes drain, and only THEN
     * settle the run it was executing — once `run()` resolves, the isolate that
     * produced the result is gone and its trailing output is already in the
     * ledger. Idempotent, so two triggers in the same tick (a wall timer and an
     * abort, or a kill and the worker's own `exit`) still cost one generation.
     */
    hardKill(session, finalize) {
        if (session.dead)
            return;
        session.dead = true;
        if (this.session === session)
            this.session = undefined;
        this.generationBumpPending = true;
        this.noticePending = true;
        // Close the host end too: a live port keeps the host event loop referenced
        // long after the worker that owned the other end is gone.
        session.port.close();
        const active = this.activeRun;
        const termination = (async () => {
            await Promise.all([
                session.worker.terminate(),
                waitForPipeDrain(session.worker.stdout),
                waitForPipeDrain(session.worker.stderr),
            ]);
            if (active && !active.settled && active.session === session)
                this.settle(active, finalize(active));
        })();
        this.terminations.add(termination);
        void termination.finally(() => { this.terminations.delete(termination); });
    }
    /** Deliver one run's single outcome and release everything it held. */
    settle(entry, result) {
        if (entry.settled)
            return;
        entry.settled = true;
        // Counted here rather than on the worker terminal: a run can reach
        // `output-limit` without the worker ever saying so, when the host's own log
        // accounting crosses the cap first.
        if (result.error?.kind === 'output-limit')
            this.counters.outputLimits += 1;
        entry.pendingDone = undefined;
        if (entry.eluTimer)
            clearInterval(entry.eluTimer);
        if (entry.wallTimer)
            clearTimeout(entry.wallTimer);
        entry.detachAbort?.();
        // Release the native pipes and open a drain window: anything they deliver
        // from here on was queued by a run that is already answered, so it is
        // discarded rather than charged to whichever run comes next. The window
        // spans a full poll phase, which is where a pipe hands over the bytes it had
        // already buffered when the control channel reported the run done.
        const session = entry.session;
        if (session?.strayOwner === entry) {
            session.strayOwner = undefined;
            session.draining = true;
            setImmediate(() => { session.draining = false; }).unref();
        }
        // Release the run slot before the caller observes the result, so a realm
        // that just answered reads as idle. Anything the worker sends for this run
        // from here on is out of protocol.
        if (this.activeRun === entry)
            this.activeRun = undefined;
        this.lastUsed = Date.now();
        this.unrefIdleSession(session);
        entry.resolve(result);
        entry.finish();
    }
}
export default PersistentRealm;
//# sourceMappingURL=realm.js.map