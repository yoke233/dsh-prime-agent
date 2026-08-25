/**
 * The host plane's trusted persistent-Realm service, mounted under the
 * uniquely named `ctx.primeRealmRuntime` service — deliberately NOT the
 * official `ctx.codeRuntime` seam, which the host keeps for the shipped
 * one-shot runtime.
 *
 * The seam is trusted: the caller hands over the Realm identity it has
 * already resolved from a trusted Agent/Session execution context, and the
 * service admits the run to that Realm's pool under the cross-process lease,
 * budgets, cancellation, metrics, idle reclaim, namespace notices and disposal
 * below. There is no handshake to authenticate and no one-shot fallback to
 * degrade to: a request that names no Realm cannot be routed, and a session
 * that lost its trusted execution context fails closed at the caller.
 * @module dsh-prime-agent/realm/runtime
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime';
import type { RealmCompletionHistoryLimits, RealmCompletionOpaqueLimits, RealmCompletionProjectionLimits } from './protocol.js';
import type { RealmBudgets, RealmMetrics } from './realm.js';
/** Everything the runtime needs that is not a per-run input. */
export interface PrimeRealmRuntimeOptions {
    /**
     * The absolute state directory this deployment shares with the agent scope.
     * Both sides read the same `realm-identity/hmac.key`; a mismatch means the
     * host-trusted realm ids and the lease directory disagree and every claim
     * fails closed rather than routing anywhere.
     */
    stateDirectory: string;
    /** Per-run ceilings handed to every realm this runtime creates. */
    budgets: RealmBudgets;
    /**
     * Completion-history ceilings for every realm this runtime creates. Blank
     * fields take the plan defaults.
     */
    completionHistory?: Partial<RealmCompletionHistoryLimits>;
    /**
     * Opaque (non-JSON) history ceilings for every realm this runtime creates.
     * Blank fields take the plan defaults; the opaque store is an independent
     * budget from {@link completionHistory}.
     */
    completionOpaque?: Partial<RealmCompletionOpaqueLimits>;
    /**
     * Projection ceilings for every realm this runtime creates: the size past
     * which a completion is referenced rather than shown, and how much a reference
     * may itself cost. Blank fields take the plan defaults.
     */
    completionProjection?: Partial<RealmCompletionProjectionLimits>;
    /** Realms that may hold a worker at once; admission past it reclaims or refuses. */
    maxActiveRealms: number;
    /** How long a realm may sit idle before its worker is reclaimed. */
    maxIdleMs: number;
}
/**
 * The trusted `ctx.primeRealmRuntime`. See the module doc for the seam
 * contract; program, budget, abort and substrate failures RESOLVE with
 * `result.error` and only caller misuse — running a disposed runtime or
 * naming an unusable Realm identity — rejects.
 */
export declare class PrimeRealmRuntime extends Service {
    private readonly budgets;
    private readonly completionHistory;
    private readonly completionOpaque;
    private readonly completionProjection;
    /**
     * Counters inherited from realms this runtime has already retired, so the
     * totals describe the whole process rather than only the realms still pooled.
     * A retired realm holds nothing, so its history LEVELS are dropped here rather
     * than carried forward.
     */
    private readonly retiredMetrics;
    /** The deployment's full output cap, which a pre-worker failure may use whole. */
    private readonly outputBytes;
    private readonly maxActiveRealms;
    private readonly maxIdleMs;
    private readonly leaseDirectory;
    private readonly pool;
    /** Cross-process claims for Realms whose worker is live or still terminating. */
    private readonly realmLeases;
    private readonly retirements;
    /** Serializes the async claim + synchronous pool-admission decision. */
    private poolMutationTail;
    private disposed;
    constructor(ctx: Context, options: PrimeRealmRuntimeOptions);
    /**
     * Bounded completion counters across every realm this runtime has hosted
     * (plan §11).
     *
     * Exposed as a getter and nothing else: the numbers are for tests and for a
     * deployment that wants to check the mechanism is reducing tokens rather than
     * only relabelling failures. They never reach a logger, the Session, the wire
     * or the model, and they carry no content.
     */
    get metrics(): RealmMetrics;
    /**
     * Run one cell in the trusted Realm named by `realmId`.
     * @param realmId - the Realm identity the caller already resolved from a
     *   trusted Agent/Session execution context.
     * @param request - the program, its bindings, and the abort signal.
     * @returns the run's outcome per the seam contract; rejects only on caller
     *   misuse (disposed runtime, unusable Realm identity).
     */
    run(realmId: string, request: CodeRunRequest): Promise<CodeRunResult>;
    /** Admit the run into its realm and append a fresh-namespace notice when needed. */
    private execute;
    /**
     * Enqueue one run while its Realm cannot be reclaimed. Existing Realms take a
     * synchronous fast path; only first-use claim and pool-capacity changes enter
     * the async mutation queue.
     */
    private admit;
    /**
     * Free one admission slot by reclaiming the least recently used IDLE realm.
     * A realm with a run active or queued is never a candidate: reclaiming it
     * would kill a run that is already the caller's to abort.
     */
    private reclaimLeastRecentlyUsed;
    /** Reclaim every realm that has been idle past the ceiling. */
    private sweepIdle;
    /**
     * Drop one realm from the pool and destroy its worker. The admission slot is
     * released synchronously while termination completes in the background, so a
     * terminating worker can briefly overlap its replacement; the ceiling governs
     * admission, not the instantaneous thread count.
     */
    private reclaim;
    /**
     * Stop admission, settle any ownership claim already in flight, then retire
     * every Realm. Each claim releases only after its worker has fully stopped.
     */
    private teardown;
    /**
     * A pre-worker outcome. It goes through the same ledger every other path uses,
     * because a pre-worker diagnostic interpolates a message from the host's tool
     * pipeline and must not be the one result that ignores the output cap.
     */
    private failure;
    /** A fail-closed pre-worker outcome; never a rejection of `run()`. */
    private exception;
    /** The abort outcome, matching the shipped one-shot runtime's rendering. */
    private aborted;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        primeRealmRuntime: PrimeRealmRuntime;
    }
}
export default PrimeRealmRuntime;
//# sourceMappingURL=runtime.d.ts.map