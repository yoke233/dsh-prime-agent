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
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { watchHostParent } from './realm/host-parent.js';
import { installPrimePreset } from './realm/preset-install.js';
export const name = 'prime-code-runtime';
/**
 * The packaged Prime preset directory: `<package root>/agent-presets/prime`,
 * reachable identically from `src/` and the built `lib/`.
 */
const PACKAGED_PRESET_DIR = fileURLToPath(new URL('../agent-presets/prime', import.meta.url));
/** Direct host owner captured before plugin startup can cross an asynchronous reparenting window. */
const HOST_PARENT_PID = process.ppid;
/** The harness user preset root under `$DSH_HOME` (`dsh-agent-presets`' `USER_PRESET_DIR`). */
const USER_PRESET_DIR = '.agent-presets';
/**
 * The official per-run budgets, restated because a realm needs a concrete value
 * even when the deployment leaves the field blank for the official fallback.
 * These MUST track `WorkerThreadCodeRuntime.Config`; a divergence would give the
 * two execution paths different budgets under one unset config.
 */
const OFFICIAL_DEFAULTS = {
    computeMs: 60_000,
    maxWallMs: 600_000,
    maxOutputBytes: 67_108_864,
    maxOldGenerationSizeMb: 512,
};
/** Fields passed to the official fallback verbatim, under its own names. */
const OFFICIAL_FIELDS = ['computeMs', 'maxWallMs', 'maxOutputBytes', 'maxOldGenerationSizeMb'];
/**
 * Completion-history ceilings, decided by the Phase 0 benchmark
 * (`docs/plan/phase0-bench-results.zh.md` §4.1) and restated here so the schema
 * can publish them. `DEFAULT_COMPLETION_HISTORY_LIMITS` in
 * `src/realm/protocol.ts` is the single source these must track.
 */
const COMPLETION_HISTORY_DEFAULTS = {
    maxCompletionHistoryEntries: 16,
    maxCompletionHistoryEstimatedBytes: 33_554_432,
    maxCompletionHistoryNodes: 1_000_000,
    maxCompletionHistoryEntryBytes: 8_388_608,
};
/** Config fields that make up one realm's completion-history limits. */
const COMPLETION_HISTORY_FIELDS = [
    'maxCompletionHistoryEntries',
    'maxCompletionHistoryEstimatedBytes',
    'maxCompletionHistoryNodes',
    'maxCompletionHistoryEntryBytes',
];
const DEFAULT_MAX_ACTIVE_REALMS = 8;
const DEFAULT_MAX_IDLE_MS = 600_000;
const DEFAULT_MAX_HOST_CALLS_PER_RUN = 200;
const DEFAULT_MAX_PARALLEL_HOST_CALLS_PER_RUN = 16;
export const Config = z.object({
    stateDirectory: z.string().required(),
    computeMs: z.number(),
    maxWallMs: z.number(),
    maxOutputBytes: z.number(),
    maxOldGenerationSizeMb: z.number(),
    maxActiveRealms: z.natural().min(1).default(DEFAULT_MAX_ACTIVE_REALMS),
    maxIdleMs: z.natural().min(1).default(DEFAULT_MAX_IDLE_MS),
    maxHostCallsPerRun: z.natural().min(1).default(DEFAULT_MAX_HOST_CALLS_PER_RUN),
    maxParallelHostCallsPerRun: z.natural().min(1).default(DEFAULT_MAX_PARALLEL_HOST_CALLS_PER_RUN),
    maxCompletionHistoryEntries: z.natural().min(1).default(COMPLETION_HISTORY_DEFAULTS.maxCompletionHistoryEntries),
    maxCompletionHistoryEstimatedBytes: z.natural().min(1).default(COMPLETION_HISTORY_DEFAULTS.maxCompletionHistoryEstimatedBytes),
    maxCompletionHistoryNodes: z.natural().min(1).default(COMPLETION_HISTORY_DEFAULTS.maxCompletionHistoryNodes),
    maxCompletionHistoryEntryBytes: z.natural().min(1).default(COMPLETION_HISTORY_DEFAULTS.maxCompletionHistoryEntryBytes),
});
/**
 * The official fallback's config: only fields the deployment actually set, so
 * the official schema keeps supplying its own defaults for the rest.
 */
function fallbackConfig(config) {
    const passthrough = {};
    for (const field of OFFICIAL_FIELDS) {
        const value = config[field];
        if (value !== undefined)
            passthrough[field] = value;
    }
    return passthrough;
}
/**
 * Resolve the Code Mode packages at APPLY time rather than at module load.
 *
 * `@deepseek-ai/dsh-code-runtime` and its worker-thread backend are OPTIONAL
 * peers, so a profile may legitimately be composed without them. A static import
 * would make that profile die during module resolution — before any plugin body
 * runs — taking the whole boot down with a bare `ERR_MODULE_NOT_FOUND` that
 * names a file rather than the decision the operator has to make. Deferring the
 * import turns it into one row failing to load, with a diagnostic that says what
 * to do about it.
 */
async function loadCodeMode() {
    try {
        const [worker, prime] = await Promise.all([
            import('@deepseek-ai/dsh-code-runtime-worker-thread'),
            // Pulls in `@deepseek-ai/dsh-code-runtime` transitively: the hybrid
            // runtime extends the official Service base class.
            import('./realm/runtime.js'),
        ]);
        return { WorkerThreadCodeRuntime: worker.default, PrimeCodeRuntime: prime.PrimeCodeRuntime };
    }
    catch (error) {
        throw new Error('dsh-prime-agent: the Prime code runtime needs the harness Code Mode packages '
            + '(@deepseek-ai/dsh-code-runtime and @deepseek-ai/dsh-code-runtime-worker-thread), '
            + 'which this profile does not provide; use a profile that includes Code Mode, or remove the prime-code-runtime row', { cause: error });
    }
}
/**
 * Place the packaged preset, reporting rather than raising on failure.
 *
 * This runs on the startup path of the host's ONLY `codeRuntime` provider, so a
 * `$DSH_HOME` that is a file, a read-only home, or a `dshHomePath` of an
 * unexpected shape must cost the deployment its preset entry in the picker — not
 * its ability to run code at all.
 */
async function placePresetOrWarn(ctx) {
    try {
        const dshHomePath = ctx.get('dshHomePath');
        // A composition without app-boot (tests, embedders) simply gets no
        // placement; a value of the wrong shape is treated the same way rather than
        // being called and throwing a TypeError.
        if (typeof dshHomePath !== 'function')
            return;
        const targetDir = dshHomePath(USER_PRESET_DIR, 'prime');
        await installPrimePreset({ sourceDir: PACKAGED_PRESET_DIR, targetDir });
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const warning = `dsh-prime-agent: could not place the packaged Prime preset (${detail}); `
            + 'the host is starting normally but Prime will not appear in the preset picker';
        const logger = ctx.get('logger');
        if (typeof logger === 'object' && logger !== null && typeof logger.warn === 'function') {
            ;
            logger.warn(warning);
        }
        else {
            console.warn(warning);
        }
    }
}
/** Per-run realm ceilings, matching the official budgets wherever they are shared. */
function realmBudgets(config) {
    return {
        computeMs: config.computeMs ?? OFFICIAL_DEFAULTS.computeMs,
        maxWallMs: config.maxWallMs ?? OFFICIAL_DEFAULTS.maxWallMs,
        maxOutputBytes: config.maxOutputBytes ?? OFFICIAL_DEFAULTS.maxOutputBytes,
        maxOldGenerationSizeMb: config.maxOldGenerationSizeMb ?? OFFICIAL_DEFAULTS.maxOldGenerationSizeMb,
        maxHostCallsPerRun: config.maxHostCallsPerRun ?? DEFAULT_MAX_HOST_CALLS_PER_RUN,
        maxParallelHostCallsPerRun: config.maxParallelHostCallsPerRun ?? DEFAULT_MAX_PARALLEL_HOST_CALLS_PER_RUN,
    };
}
/** One realm's completion-history ceilings, defaulted field by field. */
function completionHistoryLimits(config) {
    const limits = {};
    for (const field of COMPLETION_HISTORY_FIELDS) {
        limits[field] = config[field] ?? COMPLETION_HISTORY_DEFAULTS[field];
    }
    return limits;
}
/**
 * Monitor this host's owner, mount the official one-shot runtime privately, and
 * publish the hybrid runtime. Realm ownership is claimed lazily after an
 * authenticated Prime request identifies the specific Realm, so unrelated TUI
 * processes can share durable state without sharing a live namespace.
 * @param ctx - the host context this row is mounted on.
 * @param config - validated plugin config.
 */
export async function apply(ctx, config) {
    const stateDirectory = config.stateDirectory.trim();
    if (stateDirectory.length === 0)
        throw new Error('dsh-prime-agent: stateDirectory must not be empty');
    ctx.effect(() => watchHostParent(async () => { await ctx.root.fiber.dispose(); }, { parentPid: HOST_PARENT_PID }), 'prime host parent liveness');
    const { WorkerThreadCodeRuntime, PrimeCodeRuntime } = await loadCodeMode();
    // This row REPLACES the official `code-runtime` provider rather than joining
    // it; the shipped bundle patch disables the official row for exactly that
    // reason. Detecting the clash here names the patch, where cordis would only
    // report a duplicate service registration. Best effort: sibling fibers start
    // concurrently, so an official row that has not activated yet is invisible and
    // the duplicate surfaces as cordis's own error instead.
    if (ctx.get('codeRuntime') !== undefined) {
        throw new Error('dsh-prime-agent: ctx.codeRuntime is already provided; the Prime bundle patch must disable the '
            + 'official code-runtime row, and only one code runtime row may be enabled at a time');
    }
    // Place the packaged Prime preset into the user preset root, copy-if-absent
    // only — an existing directory (edited or not) is never touched. The roster
    // rescans its roots on every list, so the copy is visible immediately.
    await placePresetOrWarn(ctx);
    // A private service realm, so the official provider and this one never
    // contend for the host's single `codeRuntime` slot. `isolate` shadows the
    // name with a fresh symbol for the derived context only (cordis
    // `vendor/cordis/src/context.ts:121`), and the shipped plugin registers
    // itself against that symbol through `Service`'s `provide`.
    const fallbackScope = ctx.isolate('codeRuntime');
    // A service is only readable once its fiber is active, which happens strictly
    // after the plugin call returns (`vendor/cordis/src/reflect.ts:241`); the
    // plugin handle is thenable for exactly this wait
    // (`vendor/cordis/src/registry.ts:330`).
    await fallbackScope.plugin(WorkerThreadCodeRuntime, fallbackConfig(config));
    const fallback = fallbackScope.get('codeRuntime');
    if (fallback === undefined) {
        throw new Error('dsh-prime-agent: the official one-shot code runtime did not become available');
    }
    new PrimeCodeRuntime(ctx, {
        stateDirectory,
        fallback,
        budgets: realmBudgets(config),
        completionHistory: completionHistoryLimits(config),
        maxActiveRealms: config.maxActiveRealms ?? DEFAULT_MAX_ACTIVE_REALMS,
        maxIdleMs: config.maxIdleMs ?? DEFAULT_MAX_IDLE_MS,
    });
}
//# sourceMappingURL=runtime.js.map