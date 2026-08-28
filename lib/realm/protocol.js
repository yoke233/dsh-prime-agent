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
/** Model-visible automatic last-completion intrinsic reserved by the runtime. */
export const LAST_RESULT_GLOBAL = '$_';
/**
 * Benchmark-backed defaults, restated in `realm-worker.ts`, which cannot import
 * this module at runtime.
 */
export const DEFAULT_COMPLETION_RETENTION_LIMITS = {
    maxCompletionRetainedBytes: 8_388_608,
    maxCompletionRetainedNodes: 1_000_000,
    maxCompletionOpaqueBytes: 8_388_608,
    maxCompletionOpaqueNodes: 262_144,
};
/**
 * `maxCompletionFullBytes` matches upstream IPython's 65,536-character
 * single-stream truncation, which is the prior the model was trained against;
 * the projection ceiling is grounded in the checked-in rich-envelope
 * measurements under `bench/results/`.
 */
export const DEFAULT_COMPLETION_PROJECTION_LIMITS = {
    maxCompletionFullBytes: 65_536,
    maxCompletionProjectionBytes: 4_096,
};
/**
 * Exact byte ceiling for the largest legal minimal envelope.
 *
 * The worst case is an unretained opaque `function`. At 67 bytes it fits
 * comfortably in the completion space left by {@link MIN_OUTPUT_BYTES},
 * including the two bytes charged for empty logs.
 */
export const MINIMAL_ENVELOPE_BYTES = 67;
/** Reject any ceiling that is not a positive safe integer. */
function assertPositiveIntegers(limits) {
    for (const [key, value] of Object.entries(limits)) {
        if (!(Number.isSafeInteger(value) && value > 0)) {
            throw new Error(`dsh-prime-agent: ${key} must be a positive safe integer, got ${String(value)}`);
        }
    }
}
/** Fill in whatever a caller left blank, then reject anything unusable. */
export function resolveCompletionRetentionLimits(overrides) {
    const limits = { ...DEFAULT_COMPLETION_RETENTION_LIMITS, ...overrides };
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