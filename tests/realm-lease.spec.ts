import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireRealmLease, RealmLeaseError } from '../src/realm/realm-lease.js'

let root: string | undefined
const releases: Array<() => Promise<void>> = []

const realmA = 'A'.repeat(43)
const realmB = 'B'.repeat(43)

function leaseDirectory(): string {
  if (root === undefined) throw new Error('test root was not created')
  return join(root, 'leases')
}

afterEach(async () => {
  await Promise.all(releases.splice(0).map(release => release()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('per-Realm process lease', () => {
  it('allows different Realms and rejects a second live owner for the same Realm', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-lease-'))
    releases.push(await acquireRealmLease(leaseDirectory(), realmA))
    releases.push(await acquireRealmLease(leaseDirectory(), realmB))

    await expect(acquireRealmLease(leaseDirectory(), realmA)).rejects.toMatchObject<RealmLeaseError>({
      name: 'RealmLeaseError',
      code: 'held',
    })
  })

  it('releases only its own nonce-guarded claim', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-release-'))
    const release = await acquireRealmLease(leaseDirectory(), realmA)
    const filename = join(leaseDirectory(), `${realmA}.lease`)
    const replacement = { pid: process.pid, startedAt: Date.now(), nonce: 'Z'.repeat(22) }
    await writeFile(filename, `${JSON.stringify(replacement)}\n`)

    await release()

    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(replacement)
  })

  it('hides filesystem details when ownership storage is unavailable', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-unavailable-'))
    const blocked = leaseDirectory()
    await writeFile(blocked, 'not a directory')

    const result = acquireRealmLease(blocked, realmA)
    await expect(result).rejects.toMatchObject<RealmLeaseError>({
      name: 'RealmLeaseError',
      code: 'unavailable',
      message: 'dsh-prime-agent: Prime session ownership could not be claimed; if no host is using it, inspect stale *.lease.lock files under realm-identity/leases',
    })
    await expect(result).rejects.not.toThrow(blocked)
  })

  it('reclaims a dead owner and refuses a corrupted claim', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-stale-'))
    await mkdir(leaseDirectory(), { recursive: true })
    const filename = join(leaseDirectory(), `${realmA}.lease`)
    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(exited.pid).toBeGreaterThan(0)
    await writeFile(filename, JSON.stringify({ pid: exited.pid, startedAt: Date.now(), nonce: 'A'.repeat(22) }))

    const release = await acquireRealmLease(leaseDirectory(), realmA)
    releases.push(release)
    expect(JSON.parse(await readFile(filename, 'utf8')).pid).toBe(process.pid)
    await release()
    releases.splice(releases.indexOf(release), 1)

    await writeFile(filename, 'not a lease record')
    await expect(acquireRealmLease(leaseDirectory(), realmA)).rejects.toMatchObject<RealmLeaseError>({
      name: 'RealmLeaseError',
      code: 'corrupted',
    })
  })
})
