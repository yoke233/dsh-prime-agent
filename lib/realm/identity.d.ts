/**
 * Trusted Session-to-Realm identity.
 *
 * Maps a trusted session id to a stable opaque Realm id under one deployment
 * directory. Persistence is keyed: the session id itself never reaches the
 * filesystem, the storage key is deployment-random, and first resolution
 * converges through an atomic file lock so concurrent processes agree on one
 * Realm per session. Any corruption of the key or a session record fails
 * closed instead of silently resetting identity.
 */
/** Deployment configuration; the directory is `<stateDirectory>/realm-identity`. */
export interface RealmIdentityOptions {
    directory: string;
}
/**
 * Persistent Realm identity for one `stateDirectory`. The agent-scoped entry
 * constructs its own instance over the directory; no process singleton is
 * involved. Errors never carry a secret, the session id, or a storage path.
 */
export declare class RealmIdentityStore {
    private readonly directory;
    private key;
    constructor(options: RealmIdentityOptions);
    /** Resolve a trusted session id to its stable opaque Realm id. */
    resolve(sessionId: string): Promise<string>;
    private loadKey;
    private readKeyFile;
    private loadRealm;
    private readRealmFile;
    /** Keyed session path; the raw session id never reaches the filesystem. */
    private sessionPath;
}
//# sourceMappingURL=identity.d.ts.map