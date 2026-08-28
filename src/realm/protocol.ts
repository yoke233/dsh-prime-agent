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
 * Trusted, content-free metadata describing how a Realm completion should be
 * presented. It is derived only from a nonce-authenticated worker envelope;
 * the envelope itself remains the canonical `value`.
 */
export type ReplPresentation =
  | { kind: 'full' }
  | {
    kind: 'retained-preview'
    valueType: string
    serializedBytes?: number
  }
  | {
    kind: 'unretained-preview'
    valueType: string
    serializedBytes?: number
    /** Absent on the projector's minimal unretained envelope. */
    reason?: string
  }
  | {
    kind: 'opaque-reference'
    valueType: string
  }

/** Realm run result plus optional trusted presentation metadata. */
export interface PrimeRunResult extends CodeRunResult {
  presentation?: ReplPresentation
}

/**
 * Smallest output cap that still fits the fixed overflow diagnostic, so the
 * hard cap never has to truncate its own failure message.
 */
export const MIN_OUTPUT_BYTES = 256

/** Model-visible automatic last-completion intrinsic reserved by the runtime. */
export const LAST_RESULT_GLOBAL = '$_'

/**
 * Per-realm ceilings on the one runtime-owned retained completion.
 *
 * JSON and opaque values use independent admission ceilings because their
 * capture measurements have different meanings. A lossless-JSON completion is
 * charged its exact serialized bytes and completed object-graph walk. An opaque
 * completion is never serialized or walked again after classification (doing so
 * could invoke program code), so it is charged only what the bounded
 * classification walk accounted before refusing the JSON path.
 *
 * These are admission approximations, not heap guarantees. The retained value
 * is the program's original object, so later in-place mutation can drift every
 * capture-time measurement. The worker's `maxOldGenerationSizeMb` remains the
 * only hard heap boundary.
 */
export interface RealmCompletionRetentionLimits {
  /** Exact serialized bytes one lossless-JSON completion may occupy. */
  maxCompletionRetainedBytes: number
  /** Object-graph nodes one lossless-JSON completion may occupy. */
  maxCompletionRetainedNodes: number
  /** Classification-walk byte charge one opaque completion may occupy. */
  maxCompletionOpaqueBytes: number
  /** Classification-walk nodes one opaque completion may occupy. */
  maxCompletionOpaqueNodes: number
}

/**
 * Benchmark-backed defaults, restated in `realm-worker.ts`, which cannot import
 * this module at runtime.
 */
export const DEFAULT_COMPLETION_RETENTION_LIMITS: RealmCompletionRetentionLimits = {
  maxCompletionRetainedBytes: 8_388_608,
  maxCompletionRetainedNodes: 1_000_000,
  maxCompletionOpaqueBytes: 8_388_608,
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
 * read directly makes more tool calls, not fewer.
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
   * It deliberately does not bound the minimal preview below it. That rung is
   * bounded by the wire budget alone, because a projection ceiling small enough
   * to reject the typed minimal preview would make the last rung of the chain
   * unreachable and put an oversized completion back to failing.
   */
  maxCompletionProjectionBytes: number
}

/**
 * `maxCompletionFullBytes` matches upstream IPython's 65,536-character
 * single-stream truncation, which is the prior the model was trained against;
 * the projection ceiling is grounded in the checked-in rich-envelope
 * measurements under `bench/results/`.
 */
export const DEFAULT_COMPLETION_PROJECTION_LIMITS: RealmCompletionProjectionLimits = {
  maxCompletionFullBytes: 65_536,
  maxCompletionProjectionBytes: 4_096,
}

/**
 * Exact byte ceiling for the largest legal minimal envelope.
 *
 * The worst case is an unretained opaque `function`. At 67 bytes it fits
 * comfortably in the completion space left by {@link MIN_OUTPUT_BYTES},
 * including the two bytes charged for empty logs.
 */
export const MINIMAL_ENVELOPE_BYTES = 67

/** Reject any ceiling that is not a positive safe integer. */
function assertPositiveIntegers(limits: Record<string, number>): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!(Number.isSafeInteger(value) && value > 0)) {
      throw new Error(`dsh-prime-agent: ${key} must be a positive safe integer, got ${String(value)}`)
    }
  }
}

/** Fill in whatever a caller left blank, then reject anything unusable. */
export function resolveCompletionRetentionLimits(
  overrides: Partial<RealmCompletionRetentionLimits> | undefined,
): RealmCompletionRetentionLimits {
  const limits = { ...DEFAULT_COMPLETION_RETENTION_LIMITS, ...overrides }
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

/** What one run may spend on retaining and presenting its completion. */
export interface RealmCompletionPlan {
  retention: RealmCompletionRetentionLimits
  projection: RealmCompletionProjectionLimits
}

/**
 * The bounded preview a large completion crosses as, instead of its value.
 *
 * The safe completion type and `truncated` marker are always retained when the
 * chain reaches its minimal rung. Rich envelopes additionally carry retention
 * state, capture size, a bounded projection, or a refusal reason. The SHAPE
 * never conveys authenticity — a program can return an object of exactly this
 * form, and it travels as an ordinary completion. The `projected` marker on the
 * terminal message is the only discriminator.
 */
export interface RealmCompletionEnvelope {
  /** Whether the original value remains reachable as `$_`. */
  retained: boolean
  /** Safe completion classification such as `object`, `array` or `function`. */
  type: string
  /** Exact serialized bytes, present only when the capture walk measured them. */
  serializedBytesAtCapture?: number
  /**
   * Set only on the fixed envelope of a NON-JSON completion: the value never
   * crossed the wire in any form. Never set on a projection of a lossless-JSON
   * value.
   */
  opaque?: true
  /** The bounded projection of the value; absent on a minimal preview. */
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
     * return an object with `retained` and `truncated` fields, and that value
     * travels the ordinary completion path with this field absent. The value
     * answers "did the worker say so", which matters because the field is the
     * only thing that makes the host treat a completion as runtime-authored
     * metadata rather than as the program's own result. Neither reaches the
     * program: the nonce never enters the isolate's model-visible world, and the
     * marker is stripped from the wire before the value is handed on.
     */
    projected?: string
    /** This run's content-free completion capture and admission metrics. */
    metrics?: RealmRunMetrics
  }

/** One run's completion capture and single-slot admission bookkeeping. */
export interface RealmRunMetrics {
  /** Exact serialized bytes of the completion, when the capture walk measured them. */
  captureBytes?: number
  /** Object-graph nodes the capture walk counted, when it ran to completion. */
  captureNodes?: number
  /** Whether the non-undefined completion replaced the retained slot. */
  retained?: boolean
  /** Whether retention refused a non-undefined completion. */
  rejected?: boolean
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
  success(logs: string[]): PrimeRunResult {
    return { logs }
  }

  /** Finalize a completion whose serialized size the worker already measured. */
  completion(logs: string[], value: CodeJsonValue, serializedBytes: number): PrimeRunResult {
    if (serializedBytes > this.remaining()) return this.limit(logs)
    return { logs, value }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence when the combined bytes exceed the cap. */
  failure(logs: string[], error: CodeRunFailure): PrimeRunResult {
    if (jsonStringBytes(error.message) > this.remaining()) return this.limit(logs)
    return { logs, error }
  }

  /**
   * Build the explicit output-limit failure, retaining the longest whole-entry
   * prefix of the logs that still fits beside the fixed diagnostic. Entries are
   * kept or dropped whole; the one-shot runtime additionally splits the first
   * oversized entry at a code-point boundary.
   */
  limit(logs: string[]): PrimeRunResult {
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
