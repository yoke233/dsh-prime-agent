/**
 * Host runtime row for Prime: the plugin body behind `dsh-prime-agent/runtime`.
 *
 * It is mounted in place of the official `code-runtime` row, and its whole job
 * is composition — monitor its owning parent, mount the SHIPPED one-shot runtime
 * in a private service realm, and publish the hybrid runtime as the host's
 * `ctx.codeRuntime`. The official implementation is reused rather than copied,
 * so config validation, TypeScript stripping, budgets, abort, output limits and
 * disposal for non-Prime requests stay byte-for-byte the shipped behaviour.
 * @module dsh-prime-agent/runtime
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "prime-code-runtime";
/** Plugin config: the official budgets passed through, plus realm-pool governance. */
export interface Config {
    /**
     * Absolute Prime state directory. It MUST be the same value the packaged
     * preset gives the agent-scoped `prime_realm_identity` tool row, or the two
     * sides read different HMAC keys and every handshake fails closed.
     */
    stateDirectory: string;
    /** Busy-time budget for one run; blank passes through to the official default. */
    computeMs?: number;
    /** Wall-clock ceiling for one run; blank passes through to the official default. */
    maxWallMs?: number;
    /** Combined outer-output cap for one run; blank passes through to the official default. */
    maxOutputBytes?: number;
    /** Worker max old-generation heap in MiB; blank passes through to the official default. */
    maxOldGenerationSizeMb?: number;
    /** Realms that may hold a worker at once. */
    maxActiveRealms?: number;
    /** How long a realm may sit idle before its worker is reclaimed. */
    maxIdleMs?: number;
    /** Total host binding calls one run may issue before further calls are refused. */
    maxHostCallsPerRun?: number;
    /** Host binding calls one run may have in flight at once. */
    maxParallelHostCallsPerRun?: number;
    /** Retained completions one Prime realm generation may hold at once. */
    maxCompletionHistoryEntries?: number;
    /** Combined capture-time serialized bytes across a realm's retained completions. */
    maxCompletionHistoryEstimatedBytes?: number;
    /** Combined object-graph nodes across a realm's retained completions. */
    maxCompletionHistoryNodes?: number;
    /** Capture-time serialized bytes one single retained completion may occupy. */
    maxCompletionHistoryEntryBytes?: number;
}
export declare const Config: z<Config>;
/**
 * Monitor this host's owner, mount the official one-shot runtime privately, and
 * publish the hybrid runtime. Realm ownership is claimed lazily after an
 * authenticated Prime request identifies the specific Realm, so unrelated TUI
 * processes can share durable state without sharing a live namespace.
 * @param ctx - the host context this row is mounted on.
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
export type { PrimeCodeRuntime, PrimeCodeRuntimeOptions } from './realm/runtime.js';
//# sourceMappingURL=runtime.d.ts.map