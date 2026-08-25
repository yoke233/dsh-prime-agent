import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { RealmIdentityStore } from '../../lib/realm/identity.js'
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
  // The trusted seam takes the Realm identity directly: there is no
  // handshake tool any more, so the fixture resolves its own session's
  // identity from the same store the plugin uses.
  const identity = new RealmIdentityStore({ directory: `${stateDirectory}/realm-identity` })
  const realmId = await identity.resolve(sessionOwner)
  const result = await ctx.primeRealmRuntime.run(realmId, {
    program: '"realm ready"',
    bindings: [],
  })
  if (result.error !== undefined) throw new Error(`fixture Realm failed: ${result.error.message}`)
  await writeFile(readyPath, `${process.pid}\n`)
} catch (error) {
  clearInterval(keepAlive)
  await writeFile(failurePath, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  await ctx.fiber.dispose()
  process.exit(1)
}