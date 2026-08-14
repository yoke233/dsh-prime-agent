/**
 * Single-owner lease over one Prime state directory.
 *
 * Realm ids are derived from persistent session records, so two host processes
 * sharing a `stateDirectory` would hand the same realm id two independent heaps
 * and give one session two contradictory memories. The lease makes that a loud
 * startup failure instead. It is deliberately advisory-by-liveness: a lease
 * whose owner is provably gone is reclaimed, and one whose owner still exists
 * refuses the newcomer.
 * @module dsh-prime-agent/realm/host-lease
 */
/**
 * Claim this state directory for the current process.
 * @param directory - the `realm-identity` directory the lease lives in.
 * @returns the release function, which removes only a lease still bearing this
 *   claim's nonce.
 * @throws when a live host already owns the directory, when the existing lease
 *   cannot be read, or when the claim cannot be written.
 */
export declare function acquireHostLease(directory: string): Promise<() => Promise<void>>;
//# sourceMappingURL=host-lease.d.ts.map