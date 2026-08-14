import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RealmIdentityStore } from '../src/realm/identity.js'
import { REALM_HANDSHAKE_TEXT, REALM_IDENTITY_TOOL_NAME, registerRealmIdentity } from '../src/realm/identity-tool.js'

const IDENTITY_DIRECTORY = 'realm-identity'

function challengeOf(seed: number): Uint8Array {
  return Buffer.alloc(32, seed)
}

function wire(challenge: Uint8Array): string {
  return Buffer.from(challenge).toString('base64url')
}

function storeAt(root: string): RealmIdentityStore {
  return new RealmIdentityStore({ directory: join(root, IDENTITY_DIRECTORY) })
}

function flipByte(encoded: string, index: number): string {
  const bytes = Buffer.from(encoded, 'base64url')
  bytes[index] ^= 0x01
  return bytes.toString('base64url')
}

async function realmIdOf(store: RealmIdentityStore, owner: string, seed: number): Promise<string> {
  const challenge = challengeOf(seed)
  const { token, proof } = await store.issue(owner, challenge)
  const verified = await store.verify(token, proof, challenge)
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error(verified.reason)
  return verified.realmId
}

async function sessionFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, IDENTITY_DIRECTORY, 'sessions'))
  return entries.filter(entry => entry.endsWith('.json'))
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map(block => (block.type === 'text' ? block.text ?? '' : JSON.stringify(block))).join('\n')
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('RealmIdentityStore', () => {
  it('keeps one realm per session owner and issues a new realm for a forked session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)

    const first = await realmIdOf(store, 'session-a', 1)
    const resumed = await realmIdOf(store, 'session-a', 2)
    const forked = await realmIdOf(store, 'session-a-fork', 3)

    expect(resumed).toBe(first)
    expect(forked).not.toBe(first)
    expect(await sessionFiles(root)).toHaveLength(2)
  })

  it('binds a proof to exactly one challenge and rejects a replayed response', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)
    const challenge = challengeOf(7)
    const { token, proof } = await store.issue('session-a', challenge)

    expect(await store.verify(token, proof, challenge)).toMatchObject({ ok: true })
    const replayed = await store.verify(token, proof, challengeOf(8))
    expect(replayed).toMatchObject({ ok: false })
    if (replayed.ok) throw new Error('replay must not authenticate')
    expect(replayed.reason).toContain('challenge proof')
    expect(replayed.reason).not.toContain(token)
    expect(replayed.reason).not.toContain(proof)
    expect(replayed.reason).not.toContain('session-a')
    expect(replayed.reason).not.toContain(root)
  })

  it('rejects a tampered byte anywhere in the token or the proof', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)
    const challenge = challengeOf(9)
    const { token, proof } = await store.issue('session-a', challenge)

    for (const index of [0, 5, 40, 80, 96]) {
      expect(await store.verify(flipByte(token, index), proof, challenge)).toMatchObject({ ok: false })
    }
    for (const index of [0, 16, 31]) {
      expect(await store.verify(token, flipByte(proof, index), challenge)).toMatchObject({ ok: false })
    }
  })

  it('never throws on malformed token, proof, or challenge input', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)
    const challenge = challengeOf(11)
    const { token, proof } = await store.issue('session-a', challenge)

    const malformedTokens = [
      '',
      token.slice(0, 129),
      `${token}A`,
      `${token.slice(0, 129)}!`,
      `${token.slice(0, 128)}==`,
      token.replace(/.$/, '/'),
    ]
    for (const candidate of malformedTokens) {
      expect(await store.verify(candidate, proof, challenge)).toEqual({ ok: false, reason: 'token is not a well-formed realm token' })
    }
    expect(await store.verify(undefined as unknown as string, proof, challenge))
      .toEqual({ ok: false, reason: 'token is not a well-formed realm token' })
    expect(await store.verify(token, proof.slice(0, 42), challenge))
      .toEqual({ ok: false, reason: 'proof is not a well-formed challenge proof' })
    expect(await store.verify(token, undefined as unknown as string, challenge))
      .toEqual({ ok: false, reason: 'proof is not a well-formed challenge proof' })
    expect(await store.verify(token, proof, Buffer.alloc(31)))
      .toEqual({ ok: false, reason: 'challenge must be exactly 32 bytes' })
    expect(await store.verify(token, proof, 'not-bytes' as unknown as Uint8Array))
      .toEqual({ ok: false, reason: 'challenge must be exactly 32 bytes' })
  })

  it('shares one identity between the tool-side and runtime-side store instances', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const toolSide = storeAt(root)
    const runtimeSide = storeAt(root)
    const challenge = challengeOf(13)

    const { token, proof } = await toolSide.issue('session-a', challenge)
    const verified = await runtimeSide.verify(token, proof, challenge)
    expect(verified).toMatchObject({ ok: true })
    if (!verified.ok) throw new Error(verified.reason)
    expect(verified.realmId).toBe(await realmIdOf(toolSide, 'session-a', 14))
  })

  it('fails a handshake issued under a different deployment secret', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const other = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-other-'))
    try {
      const challenge = challengeOf(15)
      const { token, proof } = await storeAt(root).issue('session-a', challenge)
      expect(await storeAt(other).verify(token, proof, challenge))
        .toEqual({ ok: false, reason: 'token authentication failed' })
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('converges concurrent first issues on a single realm id', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const challenge = challengeOf(17)
    const stores = Array.from({ length: 6 }, () => storeAt(root))

    const issued = await Promise.all(stores.map(store => store.issue('concurrent-session', challenge)))
    const verified = await Promise.all(issued.map(({ token, proof }) => stores[0]!.verify(token, proof, challenge)))
    const realmIds = new Set(verified.map((result) => {
      if (!result.ok) throw new Error(result.reason)
      return result.realmId
    }))

    expect(realmIds.size).toBe(1)
    expect(await sessionFiles(root)).toHaveLength(1)
  })

  it('refuses to reset identity when the hmac key is corrupted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    await storeAt(root).issue('session-a', challengeOf(19))
    const keyFile = join(root, IDENTITY_DIRECTORY, 'hmac.key')
    const original = await readFile(keyFile, 'utf8')
    await writeFile(keyFile, 'not-a-valid-key\n')

    const corrupted = storeAt(root)
    await expect(corrupted.issue('session-a', challengeOf(19))).rejects.toThrow('hmac key is corrupted')
    await expect(corrupted.issue('session-a', challengeOf(19))).rejects.not.toThrow(root)

    await writeFile(keyFile, `${original.trimEnd().slice(0, 40)}\n`)
    await expect(storeAt(root).issue('session-a', challengeOf(19))).rejects.toThrow('hmac key is corrupted')
  })

  it('refuses to reset identity when a session record is corrupted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    await storeAt(root).issue('session-a', challengeOf(21))
    const [recordFile] = await sessionFiles(root)
    const recordPath = join(root, IDENTITY_DIRECTORY, 'sessions', recordFile!)

    await writeFile(recordPath, '{ not json')
    await expect(storeAt(root).issue('session-a', challengeOf(21))).rejects.toThrow('not valid JSON')

    await writeFile(recordPath, JSON.stringify({ schemaVersion: 2, realm: 'x'.repeat(43) }))
    await expect(storeAt(root).issue('session-a', challengeOf(21))).rejects.toThrow('session record is corrupted')

    await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, realm: 'too-short' }))
    await expect(storeAt(root).issue('session-a', challengeOf(21))).rejects.toThrow('realm id is corrupted')
  })

  it('keeps the raw session id out of stored paths and records', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const owner = 'sensitive-session-identifier'
    await storeAt(root).issue(owner, challengeOf(23))

    const [recordFile] = await sessionFiles(root)
    expect(recordFile).toMatch(/^[a-f0-9]{64}\.json$/)
    const record = await readFile(join(root, IDENTITY_DIRECTORY, 'sessions', recordFile!), 'utf8')
    expect(record).not.toContain(owner)
    expect(JSON.parse(record)).toMatchObject({ schemaVersion: 1 })
  })

  it('rejects out-of-bounds issue inputs', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-'))
    const store = storeAt(root)

    await expect(store.issue('', challengeOf(25))).rejects.toThrow('session owner must be 1 to 512 characters')
    await expect(store.issue('a'.repeat(513), challengeOf(25))).rejects.toThrow('session owner must be 1 to 512 characters')
    await expect(store.issue('lone-\uD800-surrogate', challengeOf(25))).rejects.toThrow('well-formed Unicode')
    await expect(store.issue('session-a', Buffer.alloc(31))).rejects.toThrow('challenge must be exactly 32 bytes')
  })
})

describe('prime_realm_identity bootstrap tool', () => {
  /** Register the tool the way the root plugin will: inside a fiber injecting `tools`. */
  async function toolRuntime(stateDirectory: string): Promise<Context['tools']> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    let tools: Context['tools'] | undefined
    await ctx.plugin({
      name: 'realm-identity-fixture',
      inject: ['tools'],
      apply: (fiber: Context) => {
        tools = fiber.tools
        registerRealmIdentity(fiber, { stateDirectory })
      },
    })
    if (tools === undefined) throw new Error('tool runtime fixture did not start')
    return tools
  }

  function ownerAgent(id: string): Agent {
    return { id, session: { append: () => {}, header: {} } } as unknown as Agent
  }

  it('issues a verifiable handshake while rendering only the fixed text', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-tool-'))
    const stateDirectory = join(root, 'state')
    const tools = await toolRuntime(stateDirectory)
    const challenge = challengeOf(31)

    const result = await tools.execute({
      callId: 'handshake-1' as never,
      name: REALM_IDENTITY_TOOL_NAME,
      arguments: { protocol: 1, challenge: wire(challenge) },
      signal: new AbortController().signal,
      agent: ownerAgent('tool-session-a'),
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error(result.error.message)
    const value = result.value as { protocol: number; token: string; proof: string }
    expect(value.protocol).toBe(1)

    const rendered = textOf(result.content)
    expect(rendered).toBe(REALM_HANDSHAKE_TEXT)
    expect(rendered).not.toContain(value.token)
    expect(rendered).not.toContain(value.proof)
    expect(JSON.stringify(result.meta ?? null)).not.toContain(value.token)

    const runtimeSide = storeAt(stateDirectory)
    expect(await runtimeSide.verify(value.token, value.proof, challenge)).toMatchObject({ ok: true })
  })

  it('binds the realm to the calling agent, not to the caller-supplied arguments', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-tool-'))
    const stateDirectory = join(root, 'state')
    const tools = await toolRuntime(stateDirectory)
    const challenge = challengeOf(33)
    const runtimeSide = storeAt(stateDirectory)

    async function realmFor(id: string): Promise<string> {
      const result = await tools.execute({
        callId: `handshake-${id}` as never,
        name: REALM_IDENTITY_TOOL_NAME,
        arguments: { protocol: 1, challenge: wire(challenge) },
        signal: new AbortController().signal,
        agent: ownerAgent(id),
      })
      if (result.isError) throw new Error(result.error.message)
      const { token, proof } = result.value as { token: string; proof: string }
      const verified = await runtimeSide.verify(token, proof, challenge)
      if (!verified.ok) throw new Error(verified.reason)
      return verified.realmId
    }

    expect(await realmFor('tool-session-a')).toBe(await realmFor('tool-session-a'))
    expect(await realmFor('tool-session-b')).not.toBe(await realmFor('tool-session-a'))
  })

  it('fails closed without an owning agent, on a bad protocol, and on a malformed challenge', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-tool-'))
    const tools = await toolRuntime(join(root, 'state'))
    const challenge = wire(challengeOf(35))

    const withoutAgent = await tools.execute({
      callId: 'handshake-no-agent' as never,
      name: REALM_IDENTITY_TOOL_NAME,
      arguments: { protocol: 1, challenge },
      signal: new AbortController().signal,
    })
    expect(withoutAgent.isError).toBe(true)
    expect(textOf(withoutAgent.content)).toContain('requires an owning agent session')

    const badProtocol = await tools.execute({
      callId: 'handshake-bad-protocol' as never,
      name: REALM_IDENTITY_TOOL_NAME,
      arguments: { protocol: 2, challenge },
      signal: new AbortController().signal,
      agent: ownerAgent('tool-session-a'),
    })
    expect(badProtocol.isError).toBe(true)
    expect(textOf(badProtocol.content)).toMatch(/protocol/i)

    for (const malformed of ['', 'not-base64url!!', wire(challengeOf(1)).slice(0, 42), `${wire(challengeOf(1))}A`]) {
      const badChallenge = await tools.execute({
        callId: 'handshake-bad-challenge' as never,
        name: REALM_IDENTITY_TOOL_NAME,
        arguments: { protocol: 1, challenge: malformed },
        signal: new AbortController().signal,
        agent: ownerAgent('tool-session-a'),
      })
      expect(badChallenge.isError).toBe(true)
      expect(textOf(badChallenge.content)).toContain('challenge must be exactly 32 bytes')
    }
  })

  it('reports a corrupted secret without leaking the storage path', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-tool-'))
    const stateDirectory = join(root, 'state')
    const tools = await toolRuntime(stateDirectory)
    await storeAt(stateDirectory).issue('tool-session-a', challengeOf(37))
    await writeFile(join(stateDirectory, IDENTITY_DIRECTORY, 'hmac.key'), 'corrupted\n')

    const result = await tools.execute({
      callId: 'handshake-corrupt' as never,
      name: REALM_IDENTITY_TOOL_NAME,
      arguments: { protocol: 1, challenge: wire(challengeOf(37)) },
      signal: new AbortController().signal,
      agent: ownerAgent('tool-session-a'),
    })

    expect(result.isError).toBe(true)
    const rendered = textOf(result.content)
    expect(rendered).toContain('hmac key is corrupted')
    expect(rendered).not.toContain(root)
    expect(rendered).not.toContain('tool-session-a')
  })
})
