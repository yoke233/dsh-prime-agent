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
/**
 * Smallest output cap that still fits the fixed overflow diagnostic, so the
 * hard cap never has to truncate its own failure message.
 */
export const MIN_OUTPUT_BYTES = 256;
/**
 * Program-visible name of the runtime's completion-expiry rejection class. It is
 * installed as an immutable worker global, so no binding namespace or injected
 * error class may claim it; the host refuses such a declaration as caller misuse
 * rather than letting the worker fail to install its own intrinsic.
 */
export const COMPLETION_EXPIRED_ERROR = 'CompletionExpiredError';
/**
 * The two model-visible completion-history intrinsics, reserved on the same
 * terms. Neither currently survives the host's identifier test for a binding
 * global, but that is an accident of the character set rather than a decision:
 * naming them here is what actually reserves them.
 */
export const COMPLETION_HISTORY_GLOBAL = '$out';
export const LAST_RESULT_GLOBAL = '$_';
/**
 * The Phase 0 benchmark's decided defaults
 * (`docs/plan/phase0-bench-results.zh.md` §4.1). Restated in `realm-worker.ts`,
 * which cannot import this module at runtime.
 */
export const DEFAULT_COMPLETION_HISTORY_LIMITS = {
    maxCompletionHistoryEntries: 16,
    maxCompletionHistoryEstimatedBytes: 33_554_432,
    maxCompletionHistoryNodes: 1_000_000,
    maxCompletionHistoryEntryBytes: 8_388_608,
};
/**
 * The opaque store's decided defaults: a quarter of the JSON store's totals,
 * because opaque charges are classification-walk lower bounds and the same
 * absolute numbers would be a looser guarantee for values whose graphs are
 * never measured.
 */
export const DEFAULT_COMPLETION_OPAQUE_LIMITS = {
    maxCompletionOpaqueEntries: 8,
    maxCompletionOpaqueEstimatedBytes: 8_388_608,
    maxCompletionOpaqueNodes: 262_144,
};
/**
 * Decided in plan §5.2. `maxCompletionFullBytes` matches upstream IPython's
 * 65,536-character single-stream truncation, which is the prior the model was
 * trained against; the projection ceiling comes from the Phase 0 measurement of
 * real envelopes (rich 265-985 B, minimal reference 86-119 B).
 */
export const DEFAULT_COMPLETION_PROJECTION_LIMITS = {
    maxCompletionFullBytes: 65_536,
    maxCompletionProjectionBytes: 4_096,
};
/**
 * Byte ceiling on the smallest envelope the degradation chain can fall back to.
 *
 * It exists to be checked against the WORST legal configuration rather than the
 * default one: a realm may be configured down to {@link MIN_OUTPUT_BYTES}, which
 * leaves a completion roughly 254 bytes once the empty log array is paid for. A
 * minimal reference has to fit inside that with room to spare, or the last rung
 * of the chain is unreachable and an oversized completion still fails.
 */
export const MINIMAL_ENVELOPE_BYTES = 128;
/** Reject any ceiling that is not a positive safe integer. */
function assertPositiveIntegers(limits) {
    for (const [key, value] of Object.entries(limits)) {
        if (!(Number.isSafeInteger(value) && value > 0)) {
            throw new Error(`dsh-prime-agent: ${key} must be a positive safe integer, got ${String(value)}`);
        }
    }
}
/** Fill in whatever a caller left blank, then reject anything unusable. */
export function resolveCompletionHistoryLimits(overrides) {
    const limits = { ...DEFAULT_COMPLETION_HISTORY_LIMITS, ...overrides };
    assertPositiveIntegers(limits);
    return limits;
}
/**
 * Fill in whatever a caller left blank, then reject anything unusable.
 *
 * The two ceilings are validated independently: no rule ties the full-value
 * threshold to the projection budget, and a deployment that wants every
 * completion projected is free to set the first below the second.
 */
export function resolveCompletionProjectionLimits(overrides) {
    const limits = { ...DEFAULT_COMPLETION_PROJECTION_LIMITS, ...overrides };
    assertPositiveIntegers(limits);
    return limits;
}
/** Fill in whatever a caller left blank, then reject anything unusable. */
export function resolveCompletionOpaqueLimits(overrides) {
    const limits = { ...DEFAULT_COMPLETION_OPAQUE_LIMITS, ...overrides };
    assertPositiveIntegers(limits);
    return limits;
}
/** Exact serialized bytes of one string as a JSON string, quotes included. */
function jsonStringBytes(text) {
    return Buffer.byteLength(JSON.stringify(text), 'utf8');
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
    bytes = 2; // JSON serialization of the empty logs array: []
    entries = 0;
    maxBytes;
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
    }
    /** Admit one exact log entry, or report that the hard cap was crossed. */
    admit(text, sink) {
        const separatorBytes = this.entries > 0 ? 1 : 0;
        const cost = jsonStringBytes(text) + separatorBytes;
        if (this.bytes + cost > this.maxBytes)
            return false;
        this.bytes += cost;
        this.entries += 1;
        sink.push(text);
        return true;
    }
    /** Exact bytes still available for a completion value or failure message. */
    remaining() {
        return this.maxBytes - this.bytes;
    }
    /** Finalize a run that completed without producing a value. */
    success(logs) {
        return { logs };
    }
    /** Finalize a completion whose serialized size the worker already measured. */
    completion(logs, value, serializedBytes) {
        if (serializedBytes > this.remaining())
            return this.limit(logs);
        return { logs, value };
    }
    /** Finalize a failure diagnostic, with output-limit taking precedence when the combined bytes exceed the cap. */
    failure(logs, error) {
        if (jsonStringBytes(error.message) > this.remaining())
            return this.limit(logs);
        return { logs, error };
    }
    /**
     * Build the explicit output-limit failure, retaining the longest whole-entry
     * prefix of the logs that still fits beside the fixed diagnostic. Entries are
     * kept or dropped whole; the one-shot runtime additionally splits the first
     * oversized entry at a code-point boundary.
     */
    limit(logs) {
        const message = `outer output exceeded ${this.maxBytes} bytes`;
        const logBudget = this.maxBytes - jsonStringBytes(message);
        const retained = [];
        let retainedBytes = 2;
        for (const text of logs) {
            const separatorBytes = retained.length > 0 ? 1 : 0;
            const cost = jsonStringBytes(text) + separatorBytes;
            if (retainedBytes + cost > logBudget)
                break;
            retainedBytes += cost;
            retained.push(text);
        }
        return { logs: retained, error: { kind: 'output-limit', message } };
    }
}
//# sourceMappingURL=protocol.js.map