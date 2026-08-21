/**
 * Cross-process ownership for one authenticated Prime Realm.
 *
 * Multiple host processes may share the durable Prime state directory. The
 * lease prevents only the unsafe case: two hosts giving the same persistent
 * Realm identity two independent live heaps. Claims are lazy, so hosts with
 * different Sessions never contend during startup.
 * @module dsh-prime-agent/realm/realm-lease
 */
/** Stable failure classes; messages never publish a path or Realm identity. */
export type RealmLeaseErrorCode = 'held' | 'corrupted' | 'unavailable';
/** Bounded lease failure suitable for routing into a Prime run result. */
export declare class RealmLeaseError extends Error {
    readonly code: RealmLeaseErrorCode;
    constructor(code: RealmLeaseErrorCode);
}
/**
 * Claim one verified Realm identity for the current host process.
 *
 * @param directory - private directory holding per-Realm lease files.
 * @param realmId - authenticated unpadded base64url Realm identity.
 * @returns a nonce-guarded release function.
 * @throws {@link RealmLeaseError} when another live host owns the Realm or the
 *   claim cannot be proved safe.
 */
export declare function acquireRealmLease(directory: string, realmId: string): Promise<() => Promise<void>>;
//# sourceMappingURL=realm-lease.d.ts.map