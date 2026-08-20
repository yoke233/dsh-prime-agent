import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const [stateDirectory, readyPath, disposedPath, failurePath] = process.argv.slice(2)
if (!stateDirectory || !readyPath || !disposedPath || !failurePath) {
  throw new Error('orphan host parent requires state, ready, disposed, and failure paths')
}

const childFixture = fileURLToPath(new URL('./orphan-host-child.mjs', import.meta.url))
const child = spawn(process.execPath, [childFixture, stateDirectory, readyPath, disposedPath, failurePath], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()

const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  try {
    await access(readyPath)
    process.exit(0)
  } catch {
    // The child has not completed plugin startup yet.
  }
  try {
    const failure = await readFile(failurePath, 'utf8')
    process.stderr.write(failure)
    process.exit(1)
  } catch {
    // No child failure has been recorded.
  }
  await new Promise(resolve => setTimeout(resolve, 25))
}

process.stderr.write('orphan host child did not become ready\n')
process.exit(1)
