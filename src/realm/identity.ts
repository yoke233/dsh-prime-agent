/** Realm identity secret, per-session realm records, tokens, and challenge proofs. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const SCHEMA_VERSION = 1
const TOKEN_VERSION = 1
const KEY_BYTES = 32
const REALM_BYTES = 32
const MAC_BYTES = 32
const CHALLENGE_BYTES = 32
const PREFIX_BYTES = 1 + REALM_BYTES + MAC_BYTES
const TOKEN_BYTES = PREFIX_BYTES + MAC_BYTES
const KEY_CHARS = 43
const REALM_CHARS = 43
const PROOF_CHARS = 43
const CHALLENGE_CHARS = 43
const TOKEN_CHARS = 130
const MAX_OWNER_CHARS = 512

const SESSION_BINDING_DOMAIN = 'session-binding/v1'
const TOKEN_MAC_DOMAIN = 'token-mac/v1'
const PROOF_DOMAIN = 'proof/v1'
const SESSION_PATH_DOMAIN = 'session-path/v1'

/** Result of authenticating one token and challenge proof. */
export type RealmVerification = { ok: true; realmId: string } | { ok: false; reason: string }

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

/** Decode a wire challenge into its exact 32 bytes, or `undefined` when malformed. */
export function decodeChallenge(value: unknown): Uint8Array | undefined {
  return decodeExact(value, CHALLENGE_CHARS, CHALLENGE_BYTES)
}

function assertOwner(sessionOwner: string): void {
  if (typeof sessionOwner !== 'string' || sessionOwner.length === 0 || sessionOwner.length > MAX_OWNER_CHARS) {
    throw new Error(`prime-realm-identity: session owner must be 1 to ${MAX_OWNER_CHARS} characters`)
  }
  if (/\p{Surrogate}/u.test(sessionOwner)) {
    throw new Error('prime-realm-identity: session owner must contain well-formed Unicode')
  }
}

function assertChallenge(challenge: Uint8Array): void {
  if (!(challenge instanceof Uint8Array) || challenge.byteLength !== CHALLENGE_BYTES) {
    throw new Error(`prime-realm-identity: challenge must be exactly ${CHALLENGE_BYTES} bytes`)
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
 * Persistent realm identity for one `stateDirectory`. The agent-scoped bootstrap
 * tool and the host runtime each construct their own instance over the same
 * directory; no process singleton is involved. Errors never carry a token,
 * proof, secret, session owner, or storage path.
 */
export class RealmIdentityStore {
  private readonly directory: string
  private key: Buffer | undefined

  constructor(options: RealmIdentityOptions) {
    const directory = options.directory.trim()
    if (directory.length === 0) throw new Error('prime-realm-identity: directory must not be empty')
    this.directory = directory
  }

  /** Issue the session's stable realm token plus a proof over this challenge. */
  async issue(sessionOwner: string, challenge: Uint8Array): Promise<{ token: string; proof: string }> {
    assertOwner(sessionOwner)
    assertChallenge(challenge)
    const key = await this.loadKey()
    const realm = await this.loadRealm(key, sessionOwner)
    const sessionBinding = mac(key, frame(SESSION_BINDING_DOMAIN, textBytes(sessionOwner)))
    const prefix = Buffer.concat([Buffer.of(TOKEN_VERSION), realm, sessionBinding])
    const token = Buffer.concat([prefix, mac(key, frame(TOKEN_MAC_DOMAIN, prefix))])
    return {
      token: encode(token),
      proof: encode(mac(key, frame(PROOF_DOMAIN, token, challenge))),
    }
  }

  /**
   * Authenticate one token and its challenge proof in constant time. Malformed
   * input resolves to a bounded reason; only corrupted storage throws.
   */
  async verify(token: string, proof: string, challenge: Uint8Array): Promise<RealmVerification> {
    if (!(challenge instanceof Uint8Array) || challenge.byteLength !== CHALLENGE_BYTES) {
      return { ok: false, reason: `challenge must be exactly ${CHALLENGE_BYTES} bytes` }
    }
    const tokenBytes = decodeExact(token, TOKEN_CHARS, TOKEN_BYTES)
    if (tokenBytes === undefined) return { ok: false, reason: 'token is not a well-formed realm token' }
    const proofBytes = decodeExact(proof, PROOF_CHARS, MAC_BYTES)
    if (proofBytes === undefined) return { ok: false, reason: 'proof is not a well-formed challenge proof' }
    if (tokenBytes[0] !== TOKEN_VERSION) return { ok: false, reason: 'token version is not supported' }
    const key = await this.loadKey()
    const prefix = tokenBytes.subarray(0, PREFIX_BYTES)
    if (!timingSafeEqual(tokenBytes.subarray(PREFIX_BYTES), mac(key, frame(TOKEN_MAC_DOMAIN, prefix)))) {
      return { ok: false, reason: 'token authentication failed' }
    }
    if (!timingSafeEqual(proofBytes, mac(key, frame(PROOF_DOMAIN, tokenBytes, challenge)))) {
      return { ok: false, reason: 'challenge proof does not match this token' }
    }
    return { ok: true, realmId: encode(tokenBytes.subarray(1, 1 + REALM_BYTES)) }
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

  private async loadRealm(key: Buffer, sessionOwner: string): Promise<Buffer> {
    const filename = this.sessionPath(key, sessionOwner)
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

  /** Keyed session path; the raw session owner never reaches the filesystem. */
  private sessionPath(key: Buffer, sessionOwner: string): string {
    const keyed = mac(key, frame(SESSION_PATH_DOMAIN, textBytes(sessionOwner))).toString('hex')
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
