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

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { acquireHostLease } from './realm/host-lease.js'
import { installPrimePreset } from './realm/preset-install.js'
import type { RealmBudgets } from './realm/realm.js'

export const name = 'prime-code-runtime'

/**
 * The packaged Prime preset directory: `<package root>/agent-presets/prime`,
 * reachable identically from `src/` and the built `lib/`.
 */
const PACKAGED_PRESET_DIR = fileURLToPath(new URL('../agent-presets/prime', import.meta.url))

/** The harness user preset root under `$DSH_HOME` (`dsh-agent-presets`' `USER_PRESET_DIR`). */
const USER_PRESET_DIR = '.agent-presets'

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
} as const

/** Fields passed to the official fallback verbatim, under its own names. */
const OFFICIAL_FIELDS = ['computeMs', 'maxWallMs', 'maxOutputBytes', 'maxOldGenerationSizeMb'] as const

const DEFAULT_MAX_ACTIVE_REALMS = 8
const DEFAULT_MAX_IDLE_MS = 600_000
const DEFAULT_MAX_HOST_CALLS_PER_RUN = 200
const DEFAULT_MAX_PARALLEL_HOST_CALLS_PER_RUN = 16
const DEFAULT_MAX_STATE_ENTRIES = 256

/** Plugin config: the official budgets passed through, plus realm-pool governance. */
export interface Config {
  /**
   * Absolute Prime state directory. It MUST be the same value the packaged
   * preset gives the agent-scoped `prime_realm_identity` tool row, or the two
   * sides read different HMAC keys and every handshake fails closed.
   */
  stateDirectory: string
  /** Busy-time budget for one run; blank passes through to the official default. */
  computeMs?: number
  /** Wall-clock ceiling for one run; blank passes through to the official default. */
  maxWallMs?: number
  /** Combined outer-output cap for one run; blank passes through to the official default. */
  maxOutputBytes?: number
  /** Worker max old-generation heap in MiB; blank passes through to the official default. */
  maxOldGenerationSizeMb?: number
  /** Realms that may hold a worker at once. */
  maxActiveRealms?: number
  /** How long a realm may sit idle before its worker is reclaimed. */
  maxIdleMs?: number
  /** Total host binding calls one run may issue before further calls are refused. */
  maxHostCallsPerRun?: number
  /** Host binding calls one run may have in flight at once. */
  maxParallelHostCallsPerRun?: number
  /** Own keys `state` may hold when a run settles. */
  maxStateEntries?: number
}

export const Config: z<Config> = z.object({
  stateDirectory: z.string().required(),
  computeMs: z.number(),
  maxWallMs: z.number(),
  maxOutputBytes: z.number(),
  maxOldGenerationSizeMb: z.number(),
  maxActiveRealms: z.natural().min(1).default(DEFAULT_MAX_ACTIVE_REALMS),
  maxIdleMs: z.natural().min(1).default(DEFAULT_MAX_IDLE_MS),
  maxHostCallsPerRun: z.natural().min(1).default(DEFAULT_MAX_HOST_CALLS_PER_RUN),
  maxParallelHostCallsPerRun: z.natural().min(1).default(DEFAULT_MAX_PARALLEL_HOST_CALLS_PER_RUN),
  maxStateEntries: z.natural().min(1).default(DEFAULT_MAX_STATE_ENTRIES),
}) as unknown as z<Config>

/**
 * The official fallback's config: only fields the deployment actually set, so
 * the official schema keeps supplying its own defaults for the rest.
 */
function fallbackConfig(config: Config): Record<string, number> {
  const passthrough: Record<string, number> = {}
  for (const field of OFFICIAL_FIELDS) {
    const value = config[field]
    if (value !== undefined) passthrough[field] = value
  }
  return passthrough
}

/** The two modules that exist only when the deployment ships Code Mode. */
interface CodeModeModules {
  WorkerThreadCodeRuntime: (typeof import('@deepseek-ai/dsh-code-runtime-worker-thread'))['default']
  PrimeCodeRuntime: (typeof import('./realm/runtime.js'))['PrimeCodeRuntime']
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
async function loadCodeMode(): Promise<CodeModeModules> {
  try {
    const [worker, prime] = await Promise.all([
      import('@deepseek-ai/dsh-code-runtime-worker-thread'),
      // Pulls in `@deepseek-ai/dsh-code-runtime` transitively: the hybrid
      // runtime extends the official Service base class.
      import('./realm/runtime.js'),
    ])
    return { WorkerThreadCodeRuntime: worker.default, PrimeCodeRuntime: prime.PrimeCodeRuntime }
  } catch (error: unknown) {
    throw new Error(
      'dsh-prime-agent: the Prime code runtime needs the harness Code Mode packages '
      + '(@deepseek-ai/dsh-code-runtime and @deepseek-ai/dsh-code-runtime-worker-thread), '
      + 'which this profile does not provide; use a profile that includes Code Mode, or remove the prime-code-runtime row',
      { cause: error },
    )
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
async function placePresetOrWarn(ctx: Context): Promise<void> {
  try {
    const dshHomePath: unknown = ctx.get('dshHomePath')
    // A composition without app-boot (tests, embedders) simply gets no
    // placement; a value of the wrong shape is treated the same way rather than
    // being called and throwing a TypeError.
    if (typeof dshHomePath !== 'function') return
    const targetDir = (dshHomePath as (...segments: string[]) => string)(USER_PRESET_DIR, 'prime')
    await installPrimePreset({ sourceDir: PACKAGED_PRESET_DIR, targetDir })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    const warning = `dsh-prime-agent: could not place the packaged Prime preset (${detail}); `
      + 'the host is starting normally but Prime will not appear in the preset picker'
    const logger: unknown = ctx.get('logger')
    if (typeof logger === 'object' && logger !== null && typeof (logger as { warn?: unknown }).warn === 'function') {
      ;(logger as { warn: (message: string) => void }).warn(warning)
    } else {
      console.warn(warning)
    }
  }
}

/** Per-run realm ceilings, matching the official budgets wherever they are shared. */
function realmBudgets(config: Config): RealmBudgets {
  return {
    computeMs: config.computeMs ?? OFFICIAL_DEFAULTS.computeMs,
    maxWallMs: config.maxWallMs ?? OFFICIAL_DEFAULTS.maxWallMs,
    maxOutputBytes: config.maxOutputBytes ?? OFFICIAL_DEFAULTS.maxOutputBytes,
    maxOldGenerationSizeMb: config.maxOldGenerationSizeMb ?? OFFICIAL_DEFAULTS.maxOldGenerationSizeMb,
    maxHostCallsPerRun: config.maxHostCallsPerRun ?? DEFAULT_MAX_HOST_CALLS_PER_RUN,
    maxParallelHostCallsPerRun: config.maxParallelHostCallsPerRun ?? DEFAULT_MAX_PARALLEL_HOST_CALLS_PER_RUN,
    maxStateEntries: config.maxStateEntries ?? DEFAULT_MAX_STATE_ENTRIES,
  }
}

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
export async function apply(ctx: Context, config: Config): Promise<void> {
  const stateDirectory = config.stateDirectory.trim()
  if (stateDirectory.length === 0) throw new Error('dsh-prime-agent: stateDirectory must not be empty')

  const release = await acquireHostLease(join(stateDirectory, 'realm-identity'))
  try {
    ctx.effect(() => () => release(), 'prime realm host lease')
  } catch (error: unknown) {
    // The fiber was torn down while the claim was being written. Releasing here
    // is what keeps that race from leaving a lease nobody will ever remove.
    await release()
    throw error
  }

  const { WorkerThreadCodeRuntime, PrimeCodeRuntime } = await loadCodeMode()

  // This row REPLACES the official `code-runtime` provider rather than joining
  // it; the shipped bundle patch disables the official row for exactly that
  // reason. Detecting the clash here names the patch, where cordis would only
  // report a duplicate service registration. Best effort: sibling fibers start
  // concurrently, so an official row that has not activated yet is invisible and
  // the duplicate surfaces as cordis's own error instead.
  if (ctx.get('codeRuntime') !== undefined) {
    throw new Error(
      'dsh-prime-agent: ctx.codeRuntime is already provided; the Prime bundle patch must disable the '
      + 'official code-runtime row, and only one code runtime row may be enabled at a time',
    )
  }

  // Place the packaged Prime preset into the user preset root, copy-if-absent
  // only — an existing directory (edited or not) is never touched. The roster
  // rescans its roots on every list, so the copy is visible immediately.
  await placePresetOrWarn(ctx)

  // A private service realm, so the official provider and this one never
  // contend for the host's single `codeRuntime` slot. `isolate` shadows the
  // name with a fresh symbol for the derived context only (cordis
  // `vendor/cordis/src/context.ts:121`), and the shipped plugin registers
  // itself against that symbol through `Service`'s `provide`.
  const fallbackScope = ctx.isolate('codeRuntime')
  // A service is only readable once its fiber is active, which happens strictly
  // after the plugin call returns (`vendor/cordis/src/reflect.ts:241`); the
  // plugin handle is thenable for exactly this wait
  // (`vendor/cordis/src/registry.ts:330`).
  await fallbackScope.plugin(WorkerThreadCodeRuntime, fallbackConfig(config))
  const fallback = fallbackScope.get('codeRuntime')
  if (fallback === undefined) {
    throw new Error('dsh-prime-agent: the official one-shot code runtime did not become available')
  }

  new PrimeCodeRuntime(ctx, {
    stateDirectory,
    fallback,
    budgets: realmBudgets(config),
    maxActiveRealms: config.maxActiveRealms ?? DEFAULT_MAX_ACTIVE_REALMS,
    maxIdleMs: config.maxIdleMs ?? DEFAULT_MAX_IDLE_MS,
  })
}

// Types only: a value re-export would statically pull the optional Code Mode
// peers back into this module's graph, defeating the deferred import above.
export type { PrimeCodeRuntime, PrimeCodeRuntimeOptions } from './realm/runtime.js'
