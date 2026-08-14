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

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const LEASE_FILE = 'host.lease'
const NONCE_BYTES = 16
const NONCE_CHARS = 22

/** Refusals are fixed text: a startup diagnostic must not publish the storage path. */
const HELD = 'dsh-prime-agent: another live host process already owns this Prime realm state directory'
const CORRUPTED = 'dsh-prime-agent: the Prime realm host lease is unreadable; refusing to start without proving the previous owner is gone'
/**
 * The catch-all. It names the file RELATIVE to the configured state directory
 * rather than by absolute path, because an orphaned `host.lease.lock` — the
 * writer lock is never force-removed, by design — otherwise leaves an operator
 * with a permanent startup failure and nothing to act on.
 */
const UNAVAILABLE = 'dsh-prime-agent: the Prime realm host lease at realm-identity/host.lease could not be claimed; if no other host is running, remove that file and any host.lease.lock beside it'

/** What the lease file records about its owner. */
interface HostLease {
  pid: number
  startedAt: number
  nonce: string
}

async function readOptionalFile(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Parse a lease record, or `undefined` when it is not one this version wrote. */
function parseLease(text: string): HostLease | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { pid, startedAt, nonce } = record
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (typeof nonce !== 'string' || nonce.length !== NONCE_CHARS) return undefined
  return { pid: pid as number, startedAt, nonce }
}

/**
 * Whether the recorded owner still exists. Signal 0 performs the permission and
 * existence checks without delivering anything; `EPERM` means the process is
 * there but owned by somebody else, which counts as alive.
 *
 * Known residual risk: an operating system may reuse a pid after the owner
 * dies, so a stale lease can read as live and refuse an otherwise legitimate
 * start. Failing closed is the deliberate trade — the alternative failure is two
 * heaps for one realm id, which is silent and unrecoverable.
 */
function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

/** Keep our own refusals; replace anything else, which may carry a path. */
function leaseFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (message === HELD || message === CORRUPTED) return new Error(message)
  return new Error(UNAVAILABLE)
}

/**
 * Claim this state directory for the current process.
 * @param directory - the `realm-identity` directory the lease lives in.
 * @returns the release function, which removes only a lease still bearing this
 *   claim's nonce.
 * @throws when a live host already owns the directory, when the existing lease
 *   cannot be read, or when the claim cannot be written.
 */
export async function acquireHostLease(directory: string): Promise<() => Promise<void>> {
  const filename = join(directory, LEASE_FILE)
  const claim: HostLease = {
    pid: process.pid,
    startedAt: Date.now(),
    nonce: randomBytes(NONCE_BYTES).toString('base64url'),
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await withFileLock(filename, async () => {
      const existing = await readOptionalFile(filename)
      if (existing !== undefined) {
        const owner = parseLease(existing)
        if (owner === undefined) throw new Error(CORRUPTED)
        if (ownerAlive(owner.pid)) throw new Error(HELD)
      }
      await writeFileAtomic(filename, `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  } catch (error: unknown) {
    throw leaseFailure(error)
  }

  return async () => {
    try {
      await withFileLock(filename, async () => {
        const current = await readOptionalFile(filename)
        if (current === undefined) return
        // Only our own claim is ours to remove: a lease bearing a different
        // nonce belongs to whichever host reclaimed the directory after
        // deciding this process was gone.
        if (parseLease(current)?.nonce !== claim.nonce) return
        await rm(filename, { force: true })
      })
    } catch {
      // Teardown is not a place to fail: a directory that vanished underneath
      // us, or a lock we cannot take, leaves at worst a stale lease that the
      // next start reclaims by liveness check.
    }
  }
}
