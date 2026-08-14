/** Fixed bootstrap binding that issues the calling session's realm token. */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { decodeChallenge, RealmIdentityStore } from './identity.js'

/** Fixed, non-configurable binding name probed by the Prime code runtime. */
export const REALM_IDENTITY_TOOL_NAME = 'prime_realm_identity'

/** The only user-visible text this tool ever renders. */
export const REALM_HANDSHAKE_TEXT = 'Prime realm handshake completed'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    protocol: { type: 'integer', required: true, const: 1 },
    token: { type: 'string', required: true },
    proof: { type: 'string', required: true },
  },
} as const

/** Replace any non-`prime-realm-identity` failure, which may embed a storage path. */
function handshakeFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('prime-realm-identity: ')) return new Error(message)
  return new Error('prime-realm-identity: realm identity storage is unavailable')
}

/** Register the fixed realm handshake binding for the local owning agent. */
export function registerRealmIdentity(ctx: Context, options: { stateDirectory: string }): void {
  const store = new RealmIdentityStore({ directory: join(options.stateDirectory, 'realm-identity') })
  ctx.tools.register(defineTool({
    name: REALM_IDENTITY_TOOL_NAME,
    description: 'Runtime-internal Prime realm handshake. The Prime code runtime calls this binding once during bootstrap to route the persistent realm; model programs must never call it and it grants no additional capability.',
    parameters: {
      protocol: { type: 'integer', required: true, const: 1, description: 'Handshake protocol version; only 1 is supported.' },
      challenge: { type: 'string', required: true, description: 'Runtime challenge: exactly 32 random bytes, unpadded base64url.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: () => [{ type: 'text', text: REALM_HANDSHAKE_TEXT }],
      presentationMeta: () => ({ plugin: 'dsh-prime-agent', schemaVersion: 1, operation: 'realm-handshake' }),
    },
    async execute(args, exec) {
      if (args.protocol !== 1) throw new Error('prime-realm-identity: unsupported handshake protocol')
      if (exec.agent === undefined) {
        throw new Error('prime-realm-identity: the realm handshake requires an owning agent session')
      }
      const challenge = decodeChallenge(args.challenge)
      if (challenge === undefined) {
        throw new Error('prime-realm-identity: challenge must be exactly 32 bytes of unpadded base64url')
      }
      let issued: { token: string; proof: string }
      try {
        issued = await store.issue(String(exec.agent.id), challenge)
      } catch (error: unknown) {
        throw handshakeFailure(error)
      }
      return { protocol: 1 as const, token: issued.token, proof: issued.proof }
    },
  }))
}
