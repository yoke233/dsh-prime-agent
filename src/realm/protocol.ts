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

import type { CodeJsonValue, CodeRunFailure, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/**
 * Smallest output cap that still fits the fixed overflow diagnostic, so the
 * hard cap never has to truncate its own failure message.
 */
export const MIN_OUTPUT_BYTES = 256

/**
 * Program-visible name of the runtime's completion-expiry rejection class. It is
 * installed as an immutable worker global, so no binding namespace or injected
 * error class may claim it; the host refuses such a declaration as caller misuse
 * rather than letting the worker fail to install its own intrinsic.
 */
export const COMPLETION_EXPIRED_ERROR = 'CompletionExpiredError'

/**
 * The two model-visible completion-history intrinsics, reserved on the same
 * terms. Neither currently survives the host's identifier test for a binding
 * global, but that is an accident of the character set rather than a decision:
 * naming them here is what actually reserves them.
 */
export const COMPLETION_HISTORY_GLOBAL = '$out'
export const LAST_RESULT_GLOBAL = '$_'

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
  maxCompletionHistoryEntries: number
  /** Combined capture-time serialized bytes across every retained completion. */
  maxCompletionHistoryEstimatedBytes: number
  /** Combined object-graph nodes across every retained completion. */
  maxCompletionHistoryNodes: number
  /** Capture-time serialized bytes one single completion may occupy. */
  maxCompletionHistoryEntryBytes: number
}

/**
 * Per-realm ceilings on the runtime-owned history of NON-JSON live values
 * (plan `docs/plan/upstream-python-node-gap-remediation.zh.md` §5 WP-C).
 *
 * This is an INDEPENDENT budget: a flood of Map/function/bigint/cyclic
 * completions may neither evict lossless-JSON slots nor be evicted by them.
 * Each class is charged against its own entries/nodes/bytes ceilings and
 * evicted FIFO within the class.
 */
export interface RealmCompletionOpaqueLimits {
  /** Retained NON-JSON completions one realm generation may hold at once. */
  maxCompletionOpaqueEntries: number
  /**
   * Combined capture-walk charge across every retained opaque completion.
   *
   * An opaque value is never serialized and its graph is deliberately never
   * walked for measurement (walking fires user getters), so the charge is what
   * the CLASSIFICATION walk accounted for before it threw: a lower bound on
   * the explored part of the value, bounded by the capture ceiling. Like the
   * JSON-side byte accounting it is an admission approximation, not a heap
   * guarantee; the worker's maxOldGenerationSizeMb stays the only hard
   * heap boundary.
   */
  maxCompletionOpaqueEstimatedBytes: number
  /** Combined capture-walk node charge across every retained opaque completion. */
  maxCompletionOpaqueNodes: number
}

/**
 * The Phase 0 benchmark's decided defaults
 * (`docs/plan/phase0-bench-results.zh.md` §4.1). Restated in `realm-worker.ts`,
 * which cannot import this module at runtime.
 */
export const DEFAULT_COMPLETION_HISTORY_LIMITS: RealmCompletionHistoryLimits = {
  maxCompletionHistoryEntries: 16,
  maxCompletionHistoryEstimatedBytes: 33_554_432,
  maxCompletionHistoryNodes: 1_000_000,
  maxCompletionHistoryEntryBytes: 8_388_608,
}

/**
 * The opaque store's decided defaults: a quarter of the JSON store's totals,
 * because opaque charges are classification-walk lower bounds and the same
 * absolute numbers would be a looser guarantee for values whose graphs are
 * never measured.
 */
export const DEFAULT_COMPLETION_OPAQUE_LIMITS: RealmCompletionOpaqueLimits = {
  maxCompletionOpaqueEntries: 8,
  maxCompletionOpaqueEstimatedBytes: 8_388_608,
  maxCompletionOpaqueNodes: 262_144,
}

/**
 * Per-realm ceilings on what a completion may put in FRONT OF THE MODEL, which
 * is a different budget from what the realm may retain.
 *
 * The two are deliberately separate knobs. Collapsing them into one number would
 * be self-consistent — a value no larger than a projection gains nothing from
 * being projected — but it would also push every 4-64 KiB result through the
 * projector, and a model that has to re-fetch a mid-sized result it could have
 * read directly makes more tool calls, not fewer (plan §5.2, acceptance #16).
 */
export interface RealmCompletionProjectionLimits {
  /**
   * Serialized bytes a completion may occupy and still cross VERBATIM. Above it
   * the model gets a bounded envelope instead, even when the wire budget could
   * have carried the whole value.
   */
  maxCompletionFullBytes: number
  /**
   * Serialized bytes one RICH envelope may occupy — the rung that carries a
   * projection of the value.
   *
   * It deliberately does not bound the minimal reference below it. That rung is
   * bounded by the wire budget alone, because a projection ceiling small enough
   * to reject a 45-byte handle would make the last rung of the chain
   * unreachable and put an oversized completion back to failing.
   */
  maxCompletionProjectionBytes: number
}

/**
 * Decided in plan §5.2. `maxCompletionFullBytes` matches upstream IPython's
 * 65,536-character single-stream truncation, which is the prior the model was
 * trained against; the projection ceiling comes from the Phase 0 measurement of
 * real envelopes (rich 265-985 B, minimal reference 86-119 B).
 */
export const DEFAULT_COMPLETION_PROJECTION_LIMITS: RealmCompletionProjectionLimits = {
  maxCompletionFullBytes: 65_536,
  maxCompletionProjectionBytes: 4_096,
}

/**
 * Byte ceiling on the smallest envelope the degradation chain can fall back to.
 *
 * It exists to be checked against the WORST legal configuration rather than the
 * default one: a realm may be configured down to {@link MIN_OUTPUT_BYTES}, which
 * leaves a completion roughly 254 bytes once the empty log array is paid for. A
 * minimal reference has to fit inside that with room to spare, or the last rung
 * of the chain is unreachable and an oversized completion still fails.
 */
export const MINIMAL_ENVELOPE_BYTES = 128

/** Reject any ceiling that is not a positive safe integer. */
function assertPositiveIntegers(limits: Record<string, number>): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new Error(`dsh-prime-agent: ${key} must be a positive safe integer, got ${String(value)}`)
    }
  }
}

/** Fill in whatever a caller left blank, then reject anything unusable. */
export function resolveCompletionHistoryLimits(
  overrides: Partial<RealmCompletionHistoryLimits> | undefined,
): RealmCompletionHistoryLimits {
  const limits = { ...DEFAULT_COMPLETION_HISTORY_LIMITS, ...overrides }
  assertPositiveIntegers(limits)
  return limits
}

/**
 * Fill in whatever a caller left blank, then reject anything unusable.
 *
 * The two ceilings are validated independently: no rule ties the full-value
 * threshold to the projection budget, and a deployment that wants every
 * completion projected is free to set the first below the second.
 */
export function resolveCompletionProjectionLimits(
  overrides: Partial<RealmCompletionProjectionLimits> | undefined,
): RealmCompletionProjectionLimits {
  const limits = { ...DEFAULT_COMPLETION_PROJECTION_LIMITS, ...overrides }
  assertPositiveIntegers(limits)
  return limits
}

/** Fill in whatever a caller left blank, then reject anything unusable. */
export function resolveCompletionOpaqueLimits(
  overrides: Partial<RealmCompletionOpaqueLimits> | undefined,
): RealmCompletionOpaqueLimits {
  const limits = { ...DEFAULT_COMPLETION_OPAQUE_LIMITS, ...overrides }
  assertPositiveIntegers(limits)
  return limits
}

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
  id: number
  limits: RealmCompletionHistoryLimits
  projection: RealmCompletionProjectionLimits
  opaque: RealmCompletionOpaqueLimits
}

/**
 * The bounded reference a large completion crosses as, instead of its value.
 *
 * Every field is optional except `truncated`, because the chain that produces it
 * degrades: a full envelope carries the handle, the capture size and a bounded
 * projection, and the last rung carries little more than the handle. What the
 * SHAPE never conveys is authenticity — a program can return an object of
 * exactly this form, and it travels as an ordinary completion. The `projected`
 * marker on the terminal message is the only discriminator (§7.2).
 */
export interface RealmCompletionEnvelope {
  /** The handle the value was retained under; absent when it was not retained. */
  $out?: number
  /** A copyable expression that reaches the value, e.g. `$out(17)`. */
  use?: string
  retained?: boolean
  /** `object`, `array`, `string`, `number`, `boolean` or `null`. */
  type?: string
  /** Exact serialized bytes, present only when the capture walk measured them. */
  serializedBytesAtCapture?: number
  /**
   * Set only on the fixed envelope of a NON-JSON completion: the value never
   * crossed the wire in any form, `$out(id)` is the only way back to it, and
   * nothing about its contents was read to render the envelope. Never set on
   * a projection of a lossless-JSON value.
   */
  opaque?: true
  /** The bounded projection of the value; absent on a minimal reference. */
  projection?: CodeJsonValue
  /** Why the value was not retained, present only alongside `retained: false`. */
  reason?: string
  truncated: true
}

/** Program-visible typed rejection contract for one namespace. */
export interface RealmErrorClassSpec {
  name: string
  memberNameProperty: string
}

/** One namespace as the worker installs it for a single run. */
export interface RealmNamespaceSpec {
  /** The program-visible global the stable proxy is bound to. */
  global: string
  /** Member names leased to the program for THIS run only. */
  names: string[]
  /** Optional rejection class injected as its own program global. */
  errorClass?: RealmErrorClassSpec
}

/**
 * Failures the worker itself can classify. Budgets, aborts and substrate death
 * are observed host-side and never travel on this wire.
 */
export interface RealmProgramFailure {
  kind: 'exception' | 'invalid-output' | 'output-limit'
  message: string
}

/** Host to worker, over the private port transferred at spawn. */
export type HostToRealm =
  | {
    type: 'run'
    runId: number
    nonce: string
    code: string
    namespaces: RealmNamespaceSpec[]
    maxOutputBytes: number
    completion: RealmCompletionPlan
  }
  | { type: 'reply'; runId: number; id: number; ok: true; json: string }
  | { type: 'reply'; runId: number; id: number; ok: false; message: string }

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
export type RealmToHost =
  | { type: 'call'; runId: number; nonce: string; id: number; global: string; name: string; json: string }
  | { type: 'log'; runId: number; nonce: string; text: string }
  | { type: 'output-limit'; runId: number; nonce: string }
  | {
    type: 'done'
    runId: number
    nonce: string
    json?: string
    error?: RealmProgramFailure
    /**
     * Set only when `json` is an envelope the PROJECTOR built, and set to the
     * run's own nonce.
     *
     * The marker and its proof are one field on purpose. Presence answers "is
     * this a projection", which the envelope's shape cannot: model code may
     * return an object with a `$out` key and a `use` string, and that value
     * travels the ordinary completion path with this field absent. The value
     * answers "did the worker say so", which matters because the field is the
     * only thing that makes the host treat a completion as runtime-authored
     * metadata rather than as the program's own result. Neither reaches the
     * program: the nonce never enters the isolate's model-visible world, and the
     * marker is stripped from the wire before the value is handed on.
     */
    projected?: string
    /**
     * This run's contribution to the realm's bounded metrics (plan §11). Absent
     * when the run had nothing to report, and NEVER carrying content: only
     * counts, sizes and the resulting history levels.
     */
    metrics?: RealmRunMetrics
  }

/**
 * One run's completion-history bookkeeping, reported once at settlement.
 *
 * Counts are per-run DELTAS rather than generation totals so the host can simply
 * add them: a hard kill takes the worker's counters with it, and a host that
 * accumulated snapshots would either lose a generation's activity or count it
 * twice. The two `history*` fields are the exception — they are levels, not
 * deltas, and describe the store as it stood when the run settled.
 */
export interface RealmRunMetrics {
  /** Exact serialized bytes of the completion, when the capture walk measured them. */
  captureBytes?: number
  /** Object-graph nodes the capture walk counted, when it ran to completion. */
  captureNodes?: number
  /** Whether the completion opened a slot or reused one by identity. */
  retained?: boolean
  /** Whether a completion was refused admission to the history. */
  rejected?: boolean
  /** Slots evicted to make room for this run's completion. */
  evicted?: number
  /** Opaque slots the history held when the run settled, a level not a delta. */
  historyOpaqueEntries?: number
  /** Opaque capture-bytes charge the history held when the run settled, a level. */
  historyOpaqueBytes?: number
  /** Handles this run asked for and did not get, because they had expired. */
  expired?: number
  /** History accesses refused for running outside their own cell. */
  refused?: number
  historyEntries?: number
  historyBytes?: number
}

/** Exact serialized bytes of one string as a JSON string, quotes included. */
function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8')
}

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
export class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0
  private readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const cost = jsonStringBytes(text) + separatorBytes
    if (this.bytes + cost > this.maxBytes) return false
    this.bytes += cost
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Exact bytes still available for a completion value or failure message. */
  remaining(): number {
    return this.maxBytes - this.bytes
  }

  /** Finalize a run that completed without producing a value. */
  success(logs: string[]): CodeRunResult {
    return { logs }
  }

  /** Finalize a completion whose serialized size the worker already measured. */
  completion(logs: string[], value: CodeJsonValue, serializedBytes: number): CodeRunResult {
    if (serializedBytes > this.remaining()) return this.limit(logs)
    return { logs, value }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when the combined bytes exceed the cap. */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    if (jsonStringBytes(error.message) > this.remaining()) return this.limit(logs)
    return { logs, error }
  }

  /**
   * Build the explicit output-limit failure, retaining the longest whole-entry
   * prefix of the logs that still fits beside the fixed diagnostic. Entries are
   * kept or dropped whole; the one-shot runtime additionally splits the first
   * oversized entry at a code-point boundary.
   */
  limit(logs: string[]): CodeRunResult {
    const message = `outer output exceeded ${this.maxBytes} bytes`
    const logBudget = this.maxBytes - jsonStringBytes(message)
    const retained: string[] = []
    let retainedBytes = 2
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      const cost = jsonStringBytes(text) + separatorBytes
      if (retainedBytes + cost > logBudget) break
      retainedBytes += cost
      retained.push(text)
    }
    return { logs: retained, error: { kind: 'output-limit', message } }
  }
}
