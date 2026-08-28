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
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { PrimeRealmRuntime } from './realm/runtime.js';
import { watchHostParent } from './realm/host-parent.js';
import { installPrimePreset } from './realm/preset-install.js';
import { DEFAULT_COMPLETION_RETENTION_LIMITS } from './realm/protocol.js';
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
 * even when the deployment leaves the field blank. These MUST track
 * `WorkerThreadCodeRuntime.Config`; a divergence would give realm runs
 * different budgets from the official one-shot runtime under one unset config.
 */
const OFFICIAL_DEFAULTS = {
    computeMs: 60_000,
    maxWallMs: 600_000,
    maxOutputBytes: 67_108_864,
    maxOldGenerationSizeMb: 512,
};
/**
 * Single-slot completion retention fields, whose defaults come directly from
 * `src/realm/protocol.ts`.
 */
const COMPLETION_RETENTION_FIELDS = [
    'maxCompletionRetainedBytes',
    'maxCompletionRetainedNodes',
    'maxCompletionOpaqueBytes',
    'maxCompletionOpaqueNodes',
];
/**
 * Completion projection ceilings, restated here so the host schema can publish
 * the defaults from `DEFAULT_COMPLETION_PROJECTION_LIMITS` in
 * `src/realm/protocol.ts`.
 */
const COMPLETION_PROJECTION_DEFAULTS = {
    maxCompletionFullBytes: 65_536,
    maxCompletionProjectionBytes: 4_096,
};
const COMPLETION_PROJECTION_FIELDS = [
    'maxCompletionFullBytes',
    'maxCompletionProjectionBytes',
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
    maxCompletionRetainedBytes: z.natural().min(1).default(DEFAULT_COMPLETION_RETENTION_LIMITS.maxCompletionRetainedBytes),
    maxCompletionRetainedNodes: z.natural().min(1).default(DEFAULT_COMPLETION_RETENTION_LIMITS.maxCompletionRetainedNodes),
    maxCompletionOpaqueBytes: z.natural().min(1).default(DEFAULT_COMPLETION_RETENTION_LIMITS.maxCompletionOpaqueBytes),
    maxCompletionOpaqueNodes: z.natural().min(1).default(DEFAULT_COMPLETION_RETENTION_LIMITS.maxCompletionOpaqueNodes),
    maxCompletionFullBytes: z.natural().min(1).default(COMPLETION_PROJECTION_DEFAULTS.maxCompletionFullBytes),
    maxCompletionProjectionBytes: z.natural().min(1).default(COMPLETION_PROJECTION_DEFAULTS.maxCompletionProjectionBytes),
});
/**
 * Place the packaged preset, reporting rather than raising on failure.
 *
 * This runs on the startup path of the Prime host row, so a `$DSH_HOME` that
 * is a file, a read-only home, or a `dshHomePath` of an unexpected shape must
 * cost the deployment its preset entry in the picker — not its ability to run
 * the realm service at all.
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
/** One realm's latest-completion retention ceilings, defaulted field by field. */
function completionRetentionLimits(config) {
    const limits = {};
    for (const field of COMPLETION_RETENTION_FIELDS) {
        limits[field] = config[field] ?? DEFAULT_COMPLETION_RETENTION_LIMITS[field];
    }
    return limits;
}
/** One realm's projection ceilings, defaulted field by field. */
function completionProjectionLimits(config) {
    const limits = {};
    for (const field of COMPLETION_PROJECTION_FIELDS) {
        limits[field] = config[field] ?? COMPLETION_PROJECTION_DEFAULTS[field];
    }
    return limits;
}
/**
 * Monitor this host's owner, place the packaged preset, and mount the trusted
 * `primeRealmRuntime` service. The official `codeRuntime` provider is
 * deliberately untouched: Realm ownership is claimed lazily per requested
 * Realm id, so unrelated host processes can share durable state without
 * sharing a live namespace.
 * @param ctx - the host context this row is mounted on.
 * @param config - validated plugin config.
 */
export async function apply(ctx, config) {
    const stateDirectory = config.stateDirectory.trim();
    if (stateDirectory.length === 0)
        throw new Error('dsh-prime-agent: stateDirectory must not be empty');
    ctx.effect(() => watchHostParent(async () => { await ctx.root.fiber.dispose(); }, { parentPid: HOST_PARENT_PID }), 'prime host parent liveness');
    // Place the packaged Prime preset into the user preset root, copy-if-absent
    // only — an existing directory (edited or not) is never touched. The roster
    // rescans its roots on every list, so the copy is visible immediately.
    await placePresetOrWarn(ctx);
    new PrimeRealmRuntime(ctx, {
        stateDirectory,
        budgets: realmBudgets(config),
        completionRetention: completionRetentionLimits(config),
        completionProjection: completionProjectionLimits(config),
        maxActiveRealms: config.maxActiveRealms ?? DEFAULT_MAX_ACTIVE_REALMS,
        maxIdleMs: config.maxIdleMs ?? DEFAULT_MAX_IDLE_MS,
    });
}
//# sourceMappingURL=runtime.js.map