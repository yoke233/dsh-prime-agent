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
 * state semantics mid-conversation is worse than a session that fails loudly.
 * @module dsh-prime-agent/realm/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime';
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime';
import type { RealmBudgets } from './realm.js';
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
    /** The deployment's full output cap, which a pre-worker failure may use whole. */
    private readonly outputBytes;
    private readonly maxActiveRealms;
    private readonly maxIdleMs;
    private readonly pool;
    /**
     * Realm ids whose heap this runtime destroyed, mapped to the generation count
     * they had reached. Presence means "the next run for this id must be told its
     * live-only state is gone"; the record is consumed by that run. One small
     * record per reclaimed realm id survives, which is what makes a reclamation
     * distinguishable from a first-ever run.
     *
     * Deliberately PROCESS-LOCAL, and correct without durable state: realm ids
     * persist, but a restarted host presents every realm as a fresh worker, and a
     * fresh worker never reports `retained`. What a restart loses is only the
     * continuity of the generation NUMBER, not the truthfulness of the claim.
     */
    private readonly lostHeaps;
    private readonly disposals;
    private disposed;
    constructor(ctx: Context, options: PrimeCodeRuntimeOptions);
    /**
     * Route one request. A non-Prime request is delegated verbatim; a Prime
     * request is authenticated first and never degrades to the one-shot path.
     * @param request - the program, its bindings, and the abort signal.
     * @returns the run's outcome per the seam contract.
     */
    run(request: CodeRunRequest): Promise<CodeRunResult>;
    /** Admit the run into its realm and append the state notice the model needs. */
    private execute;
    /** The realm for one id, creating or reclaiming as the pool ceiling allows. */
    private acquire;
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
     * Stop admission, then terminate every realm and await complete settlement, so
     * no worker or in-flight binding call outlives the fiber.
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