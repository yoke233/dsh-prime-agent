/**
 * Host runtime row for Prime: the plugin body behind `dsh-prime-agent/runtime`.
 *
 * It is mounted in place of the official `code-runtime` row, and its whole job
 * is composition — claim the state directory, mount the SHIPPED one-shot runtime
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
    /** Own keys `state` may hold when a run settles. */
    maxStateEntries?: number;
}
export declare const Config: z<Config>;
/**
 * Claim the state directory, mount the official one-shot runtime privately, and
 * publish the hybrid runtime.
 *
 * Asynchronous by necessity: the lease is a locked filesystem claim and the
 * official runtime's service only becomes readable once its fiber reaches the
 * active state. Cordis awaits a plugin body's promise before the fiber goes
 * active, so a refused lease or a fallback that never appears fails the load.
 * @param ctx - the host context this row is mounted on.
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
export type { PrimeCodeRuntime, PrimeCodeRuntimeOptions } from './realm/runtime.js';
//# sourceMappingURL=runtime.d.ts.map