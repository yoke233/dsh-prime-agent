import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { decodeChallenge, RealmIdentityStore } from '../../lib/realm/identity.js'
import * as primeRuntime from '../../lib/runtime.js'

const [stateDirectory, readyPath, disposedPath, failurePath, sessionOwner = 'orphan-host-session'] = process.argv.slice(2)
if (!stateDirectory || !readyPath || !disposedPath || !failurePath) {
  throw new Error('orphan host child requires state, ready, disposed, and failure paths')
}

const keepAlive = setInterval(() => {}, 60_000)
const ctx = new Context()
ctx.effect(() => async () => {
  await writeFile(disposedPath, 'disposed\n')
}, 'orphan host fixture disposal marker')

try {
  await ctx.plugin(primeRuntime, { stateDirectory })
  const identity = new RealmIdentityStore({ directory: `${stateDirectory}/realm-identity` })
  const handshake = async (args) => {
    const challenge = decodeChallenge(args?.challenge)
    if (challenge === undefined) throw new Error('fixture received an invalid challenge')
    const issued = await identity.issue(sessionOwner, challenge)
    return { protocol: 1, ...issued }
  }
  const result = await ctx.codeRuntime.run({
    program: '"realm ready"',
    bindings: [{ global: 'tools', functions: { prime_realm_identity: handshake } }],
  })
  if (result.error !== undefined) throw new Error(`fixture Realm failed: ${result.error.message}`)
  await writeFile(readyPath, `${process.pid}\n`)
} catch (error) {
  clearInterval(keepAlive)
  await writeFile(failurePath, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  await ctx.fiber.dispose()
  process.exit(1)
}
