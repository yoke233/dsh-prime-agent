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
    maxStateEntries?: number;
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