/** Realm identity secret, per-session realm records, tokens, and challenge proofs. */
/** Result of authenticating one token and challenge proof. */
export type RealmVerification = {
    ok: true;
    realmId: string;
} | {
    ok: false;
    reason: string;
};
/** Deployment configuration; the directory is `<stateDirectory>/realm-identity`. */
export interface RealmIdentityOptions {
    directory: string;
}
/** Decode a wire challenge into its exact 32 bytes, or `undefined` when malformed. */
export declare function decodeChallenge(value: unknown): Uint8Array | undefined;
/**
 * Persistent realm identity for one `stateDirectory`. The agent-scoped bootstrap
 * tool and the host runtime each construct their own instance over the same
 * directory; no process singleton is involved. Errors never carry a token,
 * proof, secret, session owner, or storage path.
 */
export declare class RealmIdentityStore {
    private readonly directory;
    private key;
    constructor(options: RealmIdentityOptions);
    /** Issue the session's stable realm token plus a proof over this challenge. */
    issue(sessionOwner: string, challenge: Uint8Array): Promise<{
        token: string;
        proof: string;
    }>;
    /**
     * Authenticate one token and its challenge proof in constant time. Malformed
     * input resolves to a bounded reason; only corrupted storage throws.
     */
    verify(token: string, proof: string, challenge: Uint8Array): Promise<RealmVerification>;
    private loadKey;
    private readKeyFile;
    private loadRealm;
    private readRealmFile;
    /** Keyed session path; the raw session owner never reaches the filesystem. */
    private sessionPath;
}
//# sourceMappingURL=identity.d.ts.map