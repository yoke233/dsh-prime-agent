/**
 * Private control protocol between the persistent realm host and its long-lived
 * worker, plus the outer-output accounting the host applies to every run.
 *
 * The worker imports everything here TYPE-ONLY. It boots as a bare Node worker
 * (no bundler, no path aliases, `execArgv: []`), so a runtime import from this
 * module would not resolve inside it; the few shared literals are restated
 * there with a pointer back to this file.
 * @module dsh-prime-agent/realm/protocol
 */
import type { CodeJsonValue, CodeRunFailure, CodeRunResult } from '@deepseek-ai/dsh-code-runtime';
/**
 * Binding member hidden from every program lease, whatever namespace declares
 * it. The realm handshake tool is a runtime bootstrap call, never a member the
 * model's program may reach through a persistent `tools` proxy.
 */
export declare const HIDDEN_BINDING_MEMBER = "prime_realm_identity";
/**
 * Smallest output cap that still fits the fixed overflow diagnostic, so the
 * hard cap never has to truncate its own failure message.
 */
export declare const MIN_OUTPUT_BYTES = 256;
/**
 * Program-visible name of the runtime's completion-expiry rejection class. It is
 * installed as an immutable worker global, so no binding namespace or injected
 * error class may claim it; the host refuses such a declaration as caller misuse
 * rather than letting the worker fail to install its own intrinsic.
 */
export declare const COMPLETION_EXPIRED_ERROR = "CompletionExpiredError";
/**
 * The two model-visible completion-history intrinsics, reserved on the same
 * terms. Neither currently survives the host's identifier test for a binding
 * global, but that is an accident of the character set rather than a decision:
 * naming them here is what actually reserves them.
 */
export declare const COMPLETION_HISTORY_GLOBAL = "$out";
export declare const LAST_RESULT_GLOBAL = "$_";
/**
 * Per-realm ceilings on the runtime-owned completion history.
 *
 * Both `Bytes` fields and the node budget are ADMISSION APPROXIMATIONS taken
 * when a value was captured, not heap guarantees. The history retains the
 * program's own object, so later in-place mutation drifts the accounting — the
 * Phase 0 benchmark measured drift up to 11.8x upward and down to zero
 * (`docs/plan/phase0-bench-results.zh.md` §3.4), and 16 MiB of legal JSON can
 * correspond to a 341 MiB live object graph (§3.5). The only hard heap boundary
 * is still the worker's `maxOldGenerationSizeMb`, which is why these defaults
 * sit far below it.
 */
export interface RealmCompletionHistoryLimits {
    /** Retained completions one realm generation may hold at once. */
    maxCompletionHistoryEntries: number;
    /** Combined capture-time serialized bytes across every retained completion. */
    maxCompletionHistoryEstimatedBytes: number;
    /** Combined object-graph nodes across every retained completion. */
    maxCompletionHistoryNodes: number;
    /** Capture-time serialized bytes one single completion may occupy. */
    maxCompletionHistoryEntryBytes: number;
}
/**
 * The Phase 0 benchmark's decided defaults
 * (`docs/plan/phase0-bench-results.zh.md` §4.1). Restated in `realm-worker.ts`,
 * which cannot import this module at runtime.
 */
export declare const DEFAULT_COMPLETION_HISTORY_LIMITS: RealmCompletionHistoryLimits;
/** Fill in whatever a caller left blank, then reject anything unusable. */
export declare function resolveCompletionHistoryLimits(overrides: Partial<RealmCompletionHistoryLimits> | undefined): RealmCompletionHistoryLimits;
/**
 * What one run may spend on the completion history.
 *
 * The handle is allocated HOST-side, one per dispatched run, from a counter that
 * is monotonic for the whole runtime process. A run produces at most one
 * completion, so one candidate handle per run is sufficient, and the worker
 * simply leaves it unspent when the value it completed with is already retained.
 * Allocating host-side is what makes the identifier unforgeable across worker
 * generations: a hard-killed generation cannot have consumed a number the next
 * one will hand out, so a handle the model saw before a restart is guaranteed to
 * be ABSENT from the new store rather than to name a different value.
 */
export interface RealmCompletionPlan {
    /** The handle this run may consume if its completion opens a new slot. */
    id: number;
    limits: RealmCompletionHistoryLimits;
}
/** Program-visible typed rejection contract for one namespace. */
export interface RealmErrorClassSpec {
    name: string;
    memberNameProperty: string;
}
/** One namespace as the worker installs it for a single run. */
export interface RealmNamespaceSpec {
    /** The program-visible global the stable proxy is bound to. */
    global: string;
    /** Member names leased to the program for THIS run only. */
    names: string[];
    /** Optional rejection class injected as its own program global. */
    errorClass?: RealmErrorClassSpec;
}
/**
 * Failures the worker itself can classify. Budgets, aborts and substrate death
 * are observed host-side and never travel on this wire.
 */
export interface RealmProgramFailure {
    kind: 'exception' | 'invalid-output' | 'output-limit';
    message: string;
}
/** Host to worker, over the private port transferred at spawn. */
export type HostToRealm = {
    type: 'run';
    runId: number;
    nonce: string;
    code: string;
    namespaces: RealmNamespaceSpec[];
    maxOutputBytes: number;
    completion: RealmCompletionPlan;
} | {
    type: 'reply';
    runId: number;
    id: number;
    ok: true;
    json: string;
} | {
    type: 'reply';
    runId: number;
    id: number;
    ok: false;
    message: string;
};
/**
 * Worker to host. Every message carries its `runId`: the worker outlives a
 * single run, so a terminal or call message that names the wrong run is a
 * protocol violation rather than a stale straggler to ignore.
 *
 * Every message ALSO carries the run's `nonce`. The worker executes model code,
 * which must never be able to speak on the control channel; the worker keeps the
 * private port out of the program's reach, and this single-use secret is the
 * second lock — traffic that cannot quote it is not the worker's bookkeeping,
 * whatever else it claims, so a forged `call` cannot reach a binding and a
 * forged `done` cannot settle a run early.
 */
export type RealmToHost = {
    type: 'call';
    runId: number;
    nonce: string;
    id: number;
    global: string;
    name: string;
    json: string;
} | {
    type: 'log';
    runId: number;
    nonce: string;
    text: string;
} | {
    type: 'output-limit';
    runId: number;
    nonce: string;
} | {
    type: 'done';
    runId: number;
    nonce: string;
    json?: string;
    error?: RealmProgramFailure;
};
/**
 * One run's combined outer-output ledger: the serialized log array plus the
 * completion value or failure diagnostic, against a hard per-run cap. Binding
 * arguments and resolutions never enter it.
 *
 * This restates the shipped one-shot runtime's `OutputLedger` semantics — hard
 * cap, explicit `output-limit` failure, no silent truncation of a completion
 * value — over exact `JSON.stringify` byte measurement rather than that
 * implementation's incremental character accounting.
 */
export declare class OutputLedger {
    private bytes;
    private entries;
    private readonly maxBytes;
    constructor(maxBytes: number);
    /** Admit one exact log entry, or report that the hard cap was crossed. */
    admit(text: string, sink: string[]): boolean;
    /** Exact bytes still available for a completion value or failure message. */
    remaining(): number;
    /** Finalize a run that completed without producing a value. */
    success(logs: string[]): CodeRunResult;
    /** Finalize a completion whose serialized size the worker already measured. */
    completion(logs: string[], value: CodeJsonValue, serializedBytes: number): CodeRunResult;
    /** Finalize a failure diagnostic, with output-limit taking precedence when the combined bytes exceed the cap. */
    failure(logs: string[], error: CodeRunFailure): CodeRunResult;
    /**
     * Build the explicit output-limit failure, retaining the longest whole-entry
     * prefix of the logs that still fits beside the fixed diagnostic. Entries are
     * kept or dropped whole; the one-shot runtime additionally splits the first
     * oversized entry at a code-point boundary.
     */
    limit(logs: string[]): CodeRunResult;
}
//# sourceMappingURL=protocol.d.ts.map