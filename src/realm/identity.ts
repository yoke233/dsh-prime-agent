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

import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const SCHEMA_VERSION = 1
const KEY_BYTES = 32
const REALM_BYTES = 32
const KEY_CHARS = 43
const REALM_CHARS = 43
const MAX_SESSION_ID_CHARS = 512

const SESSION_PATH_DOMAIN = 'session-path/v1'

/** Deployment configuration; the directory is `<stateDirectory>/realm-identity`. */
export interface RealmIdentityOptions {
  directory: string
}

function textBytes(value: string): Uint8Array {
  return Buffer.from(value, 'utf8')
}

/** Concatenate a domain and its parts with 4-byte big-endian length prefixes. */
function frame(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const part of [textBytes(domain), ...parts]) {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(part.byteLength)
    chunks.push(header, part)
  }
  return Buffer.concat(chunks)
}

function mac(key: Buffer, framed: Uint8Array): Buffer {
  return createHmac('sha256', key).update(framed).digest()
}

function encode(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64url')
}

/** Decode canonical unpadded base64url of an exact length, or `undefined`. */
function decodeExact(value: unknown, chars: number, bytes: number): Buffer | undefined {
  if (typeof value !== 'string' || value.length !== chars || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) return undefined
  return decoded
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS) {
    throw new Error(`prime-realm-identity: session id must be 1 to ${MAX_SESSION_ID_CHARS} characters`)
  }
  if (/\p{Surrogate}/u.test(sessionId)) {
    throw new Error('prime-realm-identity: session id must contain well-formed Unicode')
  }
}

function parseRealmRecord(text: string): Buffer {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('prime-realm-identity: session record is not valid JSON; refusing to reset realm identity')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('prime-realm-identity: session record is corrupted; refusing to reset realm identity')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('realm')
    || record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('prime-realm-identity: session record is corrupted; refusing to reset realm identity')
  }
  const realm = decodeExact(record.realm, REALM_CHARS, REALM_BYTES)
  if (realm === undefined) {
    throw new Error('prime-realm-identity: session record realm id is corrupted; refusing to reset realm identity')
  }
  return realm
}

/**
 * Persistent Realm identity for one `stateDirectory`. The agent-scoped entry
 * constructs its own instance over the directory; no process singleton is
 * involved. Errors never carry a secret, the session id, or a storage path.
 */
export class RealmIdentityStore {
  private readonly directory: string
  private key: Buffer | undefined

  constructor(options: RealmIdentityOptions) {
    const directory = options.directory.trim()
    if (directory.length === 0) throw new Error('prime-realm-identity: directory must not be empty')
    this.directory = directory
  }

  /** Resolve a trusted session id to its stable opaque Realm id. */
  async resolve(sessionId: string): Promise<string> {
    assertSessionId(sessionId)
    const key = await this.loadKey()
    return encode(await this.loadRealm(key, sessionId))
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key !== undefined) return this.key
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const filename = join(this.directory, 'hmac.key')
    const key = await this.readKeyFile(filename) ?? await withFileLock(filename, async () => {
      const current = await this.readKeyFile(filename)
      if (current !== undefined) return current
      const created = randomBytes(KEY_BYTES)
      await writeFileAtomic(filename, `${created.toString('base64url')}\n`, { mode: 0o600, dirMode: 0o700 })
      return created
    })
    this.key = key
    return key
  }

  private async readKeyFile(filename: string): Promise<Buffer | undefined> {
    const text = await readOptionalFile(filename)
    if (text === undefined) return undefined
    const key = decodeExact(text.trimEnd(), KEY_CHARS, KEY_BYTES)
    if (key === undefined) {
      throw new Error('prime-realm-identity: hmac key is corrupted; refusing to reset realm identity')
    }
    return key
  }

  private async loadRealm(key: Buffer, sessionId: string): Promise<Buffer> {
    const filename = this.sessionPath(key, sessionId)
    const existing = await this.readRealmFile(filename)
    if (existing !== undefined) return existing
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    return withFileLock(filename, async () => {
      const current = await this.readRealmFile(filename)
      if (current !== undefined) return current
      const realm = randomBytes(REALM_BYTES)
      const record = { schemaVersion: SCHEMA_VERSION, realm: realm.toString('base64url') }
      await writeFileAtomic(filename, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return realm
    })
  }

  private async readRealmFile(filename: string): Promise<Buffer | undefined> {
    const text = await readOptionalFile(filename)
    return text === undefined ? undefined : parseRealmRecord(text)
  }

  /** Keyed session path; the raw session id never reaches the filesystem. */
  private sessionPath(key: Buffer, sessionId: string): string {
    const keyed = mac(key, frame(SESSION_PATH_DOMAIN, textBytes(sessionId))).toString('hex')
    return join(this.directory, 'sessions', `${keyed}.json`)
  }
}

async function readOptionalFile(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}
