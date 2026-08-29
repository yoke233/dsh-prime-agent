/**
 * Host runtime row for Prime: the plugin body behind `dsh-prime-agent/runtime`.
 *
 * It is mounted by the bundle patch as a pure INSERT beside the official
 * `code-runtime` row, and its whole job is composition — monitor its owning
 * parent, place the packaged Prime preset, and mount the trusted
 * `primeRealmRuntime` service. The official `ctx.codeRuntime` is left to
 * the host: this row neither disables it nor replaces it, so non-Prime
 * sessions keep the official one-shot semantics from the shipped runtime.
 * @module dsh-prime-agent/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "prime-code-runtime";
/** Plugin config: the official budgets passed through, plus realm-pool governance. */
export interface Config {
    /**
     * Absolute Prime state directory. It MUST be the same value the packaged
     * preset gives the agent-scoped identity tool row, or the two sides read
     * different HMAC keys and host-trusted realm ids diverge.
     */
    stateDirectory: string;
    /** Busy-time budget for one run; blank passes through to the official default. */
    computeMs?: number;
    /** Wall-clock ceiling for one run; blank passes through to the official default. */
    maxWallMs?: number;
    /** Combined outer-output cap for one run; blank passes through to the official default. */
    maxOutputBytes?: number;
    /** Worker max old-generation heap in MiB; blank uses the Prime default. */
    maxOldGenerationSizeMb?: number;
    /** Realms that may hold a worker at once. */
    maxActiveRealms?: number;
    /** How long a realm may sit idle before its worker is reclaimed. */
    maxIdleMs?: number;
    /** Total host binding calls one run may issue before further calls are refused. */
    maxHostCallsPerRun?: number;
    /** Host binding calls one run may have in flight at once. */
    maxParallelHostCallsPerRun?: number;
    /** Exact serialized bytes the latest lossless-JSON completion may occupy. */
    maxCompletionRetainedBytes?: number;
    /** Object-graph nodes the latest lossless-JSON completion may occupy. */
    maxCompletionRetainedNodes?: number;
    /** Classification-walk byte charge the latest opaque completion may occupy. */
    maxCompletionOpaqueBytes?: number;
    /** Classification-walk nodes the latest opaque completion may occupy. */
    maxCompletionOpaqueNodes?: number;
    /** Serialized bytes a completion may occupy and still reach the model verbatim. */
    maxCompletionFullBytes?: number;
    /** Serialized bytes one bounded completion envelope may occupy. */
    maxCompletionProjectionBytes?: number;
}
export declare const Config: z<Config>;
/**
 * Monitor this host's owner, place the packaged preset, and mount the trusted
 * `primeRealmRuntime` service. The official `codeRuntime` provider is
 * deliberately untouched: Realm ownership is claimed lazily per requested
 * Realm id, so unrelated host processes can share durable state without
 * sharing a live namespace.
 * @param ctx - the host context this row is mounted on.
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
export type { PrimeRealmRuntime, PrimeRealmRuntimeOptions } from './realm/runtime.js';
//# sourceMappingURL=runtime.d.ts.map