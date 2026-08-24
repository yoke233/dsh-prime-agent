/**
 * The host plane's single `ctx.codeRuntime` provider: one runtime that answers
 * both kinds of request without letting either see the other's semantics.
 *
 * A request whose bindings carry the fixed `prime_realm_identity` bootstrap is a
 * Prime request. The runtime authenticates it — CSPRNG challenge, token, proof —
 * and routes the program to the persistent realm the token names. Every other
 * request is handed to the official one-shot runtime UNCHANGED. What is
 * deliberately impossible is the third path: a Prime request whose handshake
 * fails never falls back to one-shot, because a session that silently changed
 * persistence semantics mid-conversation is worse than a session that fails loudly.
 * @module dsh-prime-agent/realm/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime';
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime';
import type { RealmCompletionHistoryLimits, RealmCompletionProjectionLimits } from './protocol.js';
import type { RealmBudgets, RealmMetrics } from './realm.js';
/** Everything the runtime needs that is not a per-run input. */
export interface PrimeCodeRuntimeOptions {
    /**
     * The absolute state directory this deployment shares with the agent-scoped
     * handshake tool. Both sides read the same `realm-identity/hmac.key`; a
     * mismatch makes every handshake fail closed rather than route anywhere.
     */
    stateDirectory: string;
    /** The official one-shot runtime every non-Prime request is delegated to, verbatim. */
    fallback: CodeRuntime;
    /** Per-run ceilings handed to every realm this runtime creates. */
    budgets: RealmBudgets;
    /**
     * Completion-history ceilings for every realm this runtime creates. Blank
     * fields take the plan defaults; the history exists only on this authenticated
     * Prime path, so the one-shot fallback keeps the official semantics exactly.
     */
    completionHistory?: Partial<RealmCompletionHistoryLimits>;
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
 * The hybrid `ctx.codeRuntime`. See the module doc for the routing contract; the
 * Service Definition's contract is unchanged, so program, budget, abort and
 * substrate failures RESOLVE with `result.error` and only a disposed runtime or
 * an unusable binding declaration rejects.
 */
export declare class PrimeCodeRuntime extends CodeRuntime {
    readonly language = "typescript";
    readonly isolation = "worker-thread";
    private readonly fallback;
    private readonly identity;
    private readonly budgets;
    private readonly completionHistory;
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
    private admissionTail;
    private releaseAdmissionStop;
    private readonly admissionStopped;
    private disposed;
    constructor(ctx: Context, options: PrimeCodeRuntimeOptions);
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
     * Route one request. A non-Prime request is delegated verbatim; a Prime
     * request is authenticated first and never degrades to the one-shot path.
     * @param request - the program, its bindings, and the abort signal.
     * @returns the run's outcome per the seam contract.
     */
    run(request: CodeRunRequest): Promise<CodeRunResult>;
    /** Reserve call order before authentication reveals which realm owns it. */
    private reserveAdmission;
    /**
     * Start one authenticated outcome in call order, then immediately release the
     * next admission. `action()` synchronously enqueues a valid cell before it
     * returns its settlement promise, so this never serializes different realms.
     */
    private finishAdmission;
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
     * because a handshake diagnostic interpolates a message from the host's tool
     * pipeline and must not be the one result that ignores the output cap.
     */
    private failure;
    /** A fail-closed handshake outcome; never a rejection of `run()`. */
    private exception;
    /** The abort outcome, matching the shipped one-shot runtime's rendering. */
    private aborted;
}
export default PrimeCodeRuntime;
//# sourceMappingURL=runtime.d.ts.map