/**
 * Cross-process ownership for one authenticated Prime Realm.
 *
 * Multiple host processes may share the durable Prime state directory. The
 * lease prevents only the unsafe case: two hosts giving the same persistent
 * Realm identity two independent live heaps. Claims are lazy, so hosts with
 * different Sessions never contend during startup.
 * @module dsh-prime-agent/realm/realm-lease
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
const NONCE_BYTES = 16;
const NONCE_CHARS = 22;
const REALM_ID = /^[A-Za-z0-9_-]{43}$/;
const LEASE_MESSAGES = {
    held: 'dsh-prime-agent: this Prime session is already active in another host process',
    corrupted: 'dsh-prime-agent: the Prime session ownership lease is unreadable; refusing to create a second live namespace',
    unavailable: 'dsh-prime-agent: Prime session ownership could not be claimed; if no host is using it, inspect stale *.lease.lock files under realm-identity/leases',
};
/** Bounded lease failure suitable for routing into a Prime run result. */
export class RealmLeaseError extends Error {
    code;
    constructor(code) {
        super(LEASE_MESSAGES[code]);
        this.name = 'RealmLeaseError';
        this.code = code;
    }
}
async function readOptionalFile(filename) {
    try {
        return await readFile(filename, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
/** Parse a lease record, or `undefined` when it is not one this version wrote. */
function parseLease(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const record = value;
    const { pid, startedAt, nonce } = record;
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return undefined;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt))
        return undefined;
    if (typeof nonce !== 'string' || nonce.length !== NONCE_CHARS)
        return undefined;
    return { pid: pid, startedAt, nonce };
}
/**
 * Signal 0 probes liveness without delivering a signal; `EPERM` also means
 * alive. PID reuse can conservatively retain a dead owner's lease until the
 * unrelated replacement process exits; failing closed preserves one live heap.
 */
function ownerAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error?.code === 'EPERM';
    }
}
/** Preserve bounded lease failures and hide every underlying filesystem detail. */
function leaseFailure(error) {
    return error instanceof RealmLeaseError ? new RealmLeaseError(error.code) : new RealmLeaseError('unavailable');
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
export async function acquireRealmLease(directory, realmId) {
    if (!REALM_ID.test(realmId))
        throw new Error('dsh-prime-agent: realm lease requires a verified Realm identity');
    const filename = join(directory, `${realmId}.lease`);
    const claim = {
        pid: process.pid,
        startedAt: Date.now(),
        nonce: randomBytes(NONCE_BYTES).toString('base64url'),
    };
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await withFileLock(filename, async () => {
            const existing = await readOptionalFile(filename);
            if (existing !== undefined) {
                const owner = parseLease(existing);
                if (owner === undefined)
                    throw new RealmLeaseError('corrupted');
                if (ownerAlive(owner.pid))
                    throw new RealmLeaseError('held');
            }
            await writeFileAtomic(filename, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
        });
    }
    catch (error) {
        throw leaseFailure(error);
    }
    return async () => {
        try {
            await withFileLock(filename, async () => {
                const current = await readOptionalFile(filename);
                if (current === undefined || parseLease(current)?.nonce !== claim.nonce)
                    return;
                await rm(filename, { force: true });
            });
        }
        catch {
            // Teardown never fails because of an already-vanished directory or lock.
            // A stale lease is reclaimed later after the recorded pid is proven dead.
        }
    };
}
//# sourceMappingURL=realm-lease.js.map