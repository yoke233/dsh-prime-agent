import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RealmIdentityStore } from '../src/realm/identity.js'

const IDENTITY_DIRECTORY = 'realm-identity'
const REALM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

function storeAt(root: string): RealmIdentityStore {
  return new RealmIdentityStore({ directory: join(root, IDENTITY_DIRECTORY) })
}

async function sessionFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, IDENTITY_DIRECTORY, 'sessions'))
  return entries.filter(entry => entry.endsWith('.json'))
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('RealmIdentityStore.resolve', () => {
  it('keeps one stable realm per session id across calls and store instances', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const first = await storeAt(root).resolve('session-a')
    const resumed = await storeAt(root).resolve('session-a')

    expect(first).toMatch(REALM_ID_PATTERN)
    expect(resumed).toBe(first)
    expect(await sessionFiles(root)).toHaveLength(1)
  })

  it('isolates different sessions and forked sessions', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)

    const sessionA = await store.resolve('session-a')
    const sessionB = await store.resolve('session-b')
    const forked = await store.resolve('session-a-fork')

    expect(sessionB).not.toBe(sessionA)
    expect(forked).not.toBe(sessionA)
    expect(await sessionFiles(root)).toHaveLength(3)
  })

  it('converges concurrent first resolutions on a single realm id', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const stores = Array.from({ length: 8 }, () => storeAt(root))

    const realms = await Promise.all(stores.map(store => store.resolve('concurrent-session')))

    expect(new Set(realms).size).toBe(1)
    expect(await sessionFiles(root)).toHaveLength(1)
  })

  it('isolates deployments by storage key', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const other = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-other-'))
    try {
      expect(await storeAt(other).resolve('session-a')).not.toBe(await storeAt(root).resolve('session-a'))
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('keys session records so the raw session id never reaches storage', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const owner = 'sensitive-session-identifier'
    await storeAt(root).resolve(owner)

    const [recordFile] = await sessionFiles(root)
    expect(recordFile).toMatch(/^[a-f0-9]{64}\.json$/)
    const record = await readFile(join(root, IDENTITY_DIRECTORY, 'sessions', recordFile!), 'utf8')
    expect(record).not.toContain(owner)
    expect(JSON.parse(record)).toMatchObject({ schemaVersion: 1 })
  })

  it('refuses to reset identity when the hmac key is corrupted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    await storeAt(root).resolve('session-a')
    const keyFile = join(root, IDENTITY_DIRECTORY, 'hmac.key')
    const original = await readFile(keyFile, 'utf8')
    await writeFile(keyFile, 'not-a-valid-key\n')

    const corrupted = storeAt(root)
    await expect(corrupted.resolve('session-a')).rejects.toThrow('hmac key is corrupted')
    await expect(corrupted.resolve('session-a')).rejects.not.toThrow(root)
    await expect(corrupted.resolve('session-a')).rejects.not.toThrow('session-a')

    await writeFile(keyFile, `${original.trimEnd().slice(0, 40)}\n`)
    await expect(storeAt(root).resolve('session-a')).rejects.toThrow('hmac key is corrupted')
  })

  it('refuses to reset identity when a session record is corrupted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    await storeAt(root).resolve('session-a')
    const [recordFile] = await sessionFiles(root)
    const recordPath = join(root, IDENTITY_DIRECTORY, 'sessions', recordFile!)

    await writeFile(recordPath, '{ not json')
    await expect(storeAt(root).resolve('session-a')).rejects.toThrow('not valid JSON')

    await writeFile(recordPath, '[]')
    await expect(storeAt(root).resolve('session-a')).rejects.toThrow('session record is corrupted')

    await writeFile(recordPath, JSON.stringify({ schemaVersion: 2, realm: 'x'.repeat(43) }))
    await expect(storeAt(root).resolve('session-a')).rejects.toThrow('session record is corrupted')

    await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, realm: 'too-short' }))
    await expect(storeAt(root).resolve('session-a')).rejects.toThrow('realm id is corrupted')

    // 43 characters of canonical-looking base64url that is not canonical.
    await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, realm: `${'A'.repeat(42)}B` }))
    await expect(storeAt(root).resolve('session-a')).rejects.toThrow('realm id is corrupted')
    await expect(storeAt(root).resolve('session-a')).rejects.not.toThrow(root)
  })

  it('bounds session id validation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)

    await expect(store.resolve('')).rejects.toThrow('session id must be 1 to 512 characters')
    await expect(store.resolve('a'.repeat(513))).rejects.toThrow('session id must be 1 to 512 characters')
    await expect(store.resolve(undefined as unknown as string)).rejects.toThrow('session id must be 1 to 512 characters')
    await expect(store.resolve('lone-\uD800-surrogate')).rejects.toThrow('well-formed Unicode')

    expect(await store.resolve('session-a')).toMatch(REALM_ID_PATTERN)
    expect(await sessionFiles(root)).toHaveLength(1)
  })
})
