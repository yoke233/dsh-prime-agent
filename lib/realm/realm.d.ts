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
import type { CodeRunRequest } from '@deepseek-ai/dsh-code-runtime';
import type { PrimeRunResult, RealmCompletionProjectionLimits, RealmCompletionRetentionLimits } from './protocol.js';
export type { RealmCompletionProjectionLimits, RealmCompletionRetentionLimits, } from './protocol.js';
/**
 * Bounded counters for one realm's completion traffic.
 *
 * Deliberately content-free: sizes and counts, with nothing that could identify
 * a value, path, credential or session. The reduction ratio
 * `projectionBytes / captureBytes` is left to the reader rather than stored, so
 * the two numbers it comes from stay independently checkable.
 */
export interface RealmMetrics {
    /** Completions the model received verbatim. */
    completionsFull: number;
    /** Completions the model received as a bounded reference instead. */
    completionsProjected: number;
    /** Projections that had to degrade past the rich envelope to a minimal one. */
    completionsMinimal: number;
    /** Runs that ended in `output-limit`, whatever exhausted the budget. */
    outputLimits: number;
    /** Exact serialized bytes of every completion the capture walk measured. */
    captureBytes: number;
    /** Wire bytes the projections actually cost. */
    projectionBytes: number;
    completionsRetained: number;
    completionsRejected: number;
}
/** A zeroed counter set, and the shape every accumulator here starts from. */
export declare function emptyRealmMetrics(): RealmMetrics;
/** Fold one realm's counters into a running total. */
export declare function addRealmMetrics(total: RealmMetrics, part: RealmMetrics): RealmMetrics;
/** Per-run resource ceilings. Every field is an increment for ONE run, not a realm lifetime total. */
export interface RealmBudgets {
    /** Event-loop busy-time budget for one run, measured as the worker's ELU delta since that run started. */
    computeMs: number;
    /** Wall-clock ceiling for one run. */
    maxWallMs: number;
    /** Hard cap on one run's combined serialized logs plus completion value or failure message. */
    maxOutputBytes: number;
    /** The worker's max old-generation heap in MiB; overflow kills it, surfacing as `worker-exit`. */
    maxOldGenerationSizeMb: number;
    /**
     * Total host binding calls one run may issue. A call over the ceiling is
     * REFUSED, not fatal: the program sees a rejection it can catch and the realm
     * keeps its heap. Unbounded when absent.
     */
    maxHostCallsPerRun?: number;
    /**
     * Host binding calls one run may have in flight at once, refused the same way
     * as {@link maxHostCallsPerRun}. Unbounded when absent.
     */
    maxParallelHostCallsPerRun?: number;
}
/**
 * What a run saw when it actually began executing. Delivered at DISPATCH, not
 * at admission or settlement: a run can wait behind others in the queue, and
 * only the dispatch moment knows which worker generation the program will run
 * against and whether the heap it inherits is a fresh one.
 */
export interface RealmRunNotice {
    /**
     * Whether this is the FIRST run to dispatch on this worker, i.e. the program
     * starts from an empty live namespace. True for a brand-new realm and for the
     * replacement worker after a hard kill; false for every later run.
     */
    fresh: boolean;
    /** Whether a hard kill destroyed the previous live namespace. */
    namespaceLost: boolean;
}
/**
 * One realm: a lazily spawned worker, a strictly serial run queue, and the
 * lifecycle bookkeeping a caller needs to tell the model its live namespace is
 * gone.
 */
export declare class PersistentRealm {
    /** Opaque routing identity; never rendered into a result or diagnostic. */
    readonly realmId: string;
    private readonly budgets;
    private readonly completionRetention;
    private readonly completionProjection;
    private readonly counters;
    private readonly queue;
    private readonly inflight;
    private readonly terminations;
    private session;
    private activeRun;
    private runCounter;
    private generationValue;
    private generationBumpPending;
    private noticePending;
    private injectedGlobalSchema;
    private lastUsed;
    private disposed;
    constructor(options: {
        realmId: string;
        budgets: RealmBudgets;
        /** Single-slot completion retention ceilings; every blank field takes its runtime default. */
        completionRetention?: Partial<RealmCompletionRetentionLimits>;
        /** Projection ceilings; every blank field takes its runtime default. */
        completionProjection?: Partial<RealmCompletionProjectionLimits>;
    });
    /**
     * The current worker generation, counting from 1. A hard kill schedules the
     * increment; reading it (or starting the replacement worker) materializes it,
     * so repeated reads between two runs stay stable.
     */
    get generation(): number;
    /** This realm's bounded completion counters, as of the last settled run. */
    get metrics(): RealmMetrics;
    /** No run is active and none is waiting. */
    get idle(): boolean;
    /** Epoch milliseconds of the most recent admission or settlement, for pool LRU/TTL. */
    get lastUsedAt(): number;
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
    run(request: CodeRunRequest, onStart?: (notice: RealmRunNotice) => void): Promise<PrimeRunResult>;
    /**
     * Stop admission, terminate the worker, and await complete settlement: no
     * worker, timer, or unsettled run outlives this call.
     */
    dispose(): Promise<void>;
    /** Reject malformed binding globals or typed-error declarations as caller misuse. */
    private validateBindings;
    /**
     * Freeze structural globals on the first valid admission. Later runs may
     * omit and restore known namespaces or change their leased function members,
     * but cannot change globals already installed in the live namespace.
     */
    private validateInjectedGlobalSchema;
    /** A signal fired: cancel a queued run alone, or hard-kill the worker running an active one. */
    private onSignalAbort;
    /** Start the next queued run, if the realm is free to take one. */
    private pump;
    /** Type-strip the program, spawn or reuse the worker, and arm this run's budgets. */
    private dispatch;
    /** The live worker, spawning a new generation when the previous one is gone. */
    private ensureSession;
    /** Keep an admitted run alive when it reuses a Worker parked while idle. */
    private refSession;
    /** Let a live but idle generation survive without owning the host lifetime. */
    private unrefIdleSession;
    /** Post one control message, tolerating a session torn down underneath us. */
    private post;
    /** Route one inbound control message, escalating anything outside the protocol. */
    private onControlMessage;
    /** Release one accepted host call and consume a waiting normal terminal. */
    private onHostCallSettled;
    /** Settle one run after its worker terminal and accepted host calls are both complete. */
    private onDone;
    /** Fold one run's worker-side completion bookkeeping into this realm's counters. */
    private recordRunMetrics;
    /**
     * Charge one binding call against this run's host-call budgets, or report why
     * it is refused. Counting happens BEFORE the host function is reached, so a
     * refused call costs neither a dispatch nor a slot.
     */
    private admitHostCall;
    /** Bridge one binding call to the host function the CURRENT run declared. */
    private dispatchCall;
    /**
     * Native-level pipe output. It belongs to the run in flight; arriving while
     * the realm is idle it is out-of-protocol activity, and the worker loses its
     * heap rather than running alongside the next run.
     */
    private onStrayOutput;
    /** The worker died on its own (OOM, `process.exit`, an uncaught throw). */
    private onWorkerGone;
    /**
     * End one worker generation: terminate it, let its pipes drain, and only THEN
     * settle the run it was executing — once `run()` resolves, the isolate that
     * produced the result is gone and its trailing output is already in the
     * ledger. Idempotent, so two triggers in the same tick (a wall timer and an
     * abort, or a kill and the worker's own `exit`) still cost one generation.
     */
    private hardKill;
    /** Deliver one run's single outcome and release everything it held. */
    private settle;
}
export default PersistentRealm;
//# sourceMappingURL=realm.d.ts.map