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
 * Binding member hidden from every program lease, whatever namespace declares
 * it. The realm handshake tool is a runtime bootstrap call, never a member the
 * model's program may reach through a persistent `tools` proxy.
 */
export const HIDDEN_BINDING_MEMBER = 'prime_realm_identity';
/**
 * Smallest output cap that still fits the fixed overflow diagnostic, so the
 * hard cap never has to truncate its own failure message.
 */
export const MIN_OUTPUT_BYTES = 256;
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