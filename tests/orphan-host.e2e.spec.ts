import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const parentFixture = fileURLToPath(new URL('./fixtures/orphan-host-parent.mjs', import.meta.url))

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return check()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function stopProcessTree(pid: number): void {
  if (!processAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The child may settle between the liveness probe and signal delivery.
  }
}

it('disposes the host and releases its lease when its parent process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prime-orphan-host-'))
  const stateDirectory = join(root, 'state')
  const readyPath = join(root, 'ready')
  const disposedPath = join(root, 'disposed')
  const failurePath = join(root, 'failure')
  const leasePath = join(stateDirectory, 'realm-identity', 'host.lease')
  let childPid: number | undefined

  try {
    const parent = spawn(process.execPath, [parentFixture, stateDirectory, readyPath, disposedPath, failurePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    parent.stderr.setEncoding('utf8')
    parent.stderr.on('data', chunk => { stderr += chunk })
    const parentExit = await new Promise<number | null>((resolve, reject) => {
      parent.once('error', reject)
      parent.once('exit', code => { resolve(code) })
    })
    if (await exists(failurePath)) stderr += await readFile(failurePath, 'utf8')
    expect(parentExit, stderr).toBe(0)

    childPid = Number((await readFile(readyPath, 'utf8')).trim())
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true)
    expect(await exists(leasePath)).toBe(true)

    expect(await waitFor(() => !processAlive(childPid as number), 5_000)).toBe(true)
    expect(await waitFor(() => exists(disposedPath), 1_000)).toBe(true)
    expect(await exists(leasePath)).toBe(false)
  } finally {
    if (childPid !== undefined) stopProcessTree(childPid)
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
