import { writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as primeRuntime from '../../lib/runtime.js'

const [stateDirectory, readyPath, disposedPath, failurePath] = process.argv.slice(2)
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
  await writeFile(readyPath, `${process.pid}\n`)
} catch (error) {
  clearInterval(keepAlive)
  await writeFile(failurePath, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  await ctx.fiber.dispose()
  process.exit(1)
}
