import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const parentFixture = fileURLToPath(new URL('./fixtures/orphan-host-parent.mjs', import.meta.url))
const childFixture = fileURLToPath(new URL('./fixtures/orphan-host-child.mjs', import.meta.url))

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

async function stopProcessTree(pid: number): Promise<void> {
  if (!processAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The child may settle between the liveness probe and signal delivery.
    }
  }
  await waitFor(() => !processAlive(pid), 2_000)
}

interface FixtureChild {
  pid: number
  readyPath: string
  disposedPath: string
  failurePath: string
}

function startChildFixture(root: string, stateDirectory: string, name: string, sessionOwner: string): FixtureChild {
  const readyPath = join(root, `${name}-ready`)
  const disposedPath = join(root, `${name}-disposed`)
  const failurePath = join(root, `${name}-failure`)
  const child = spawn(process.execPath, [childFixture, stateDirectory, readyPath, disposedPath, failurePath, sessionOwner], {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  })
  if (child.pid === undefined) throw new Error(`fixture ${name} did not receive a pid`)
  return { pid: child.pid, readyPath, disposedPath, failurePath }
}

async function childOutcome(child: FixtureChild): Promise<{ ready: boolean; failure: string }> {
  expect(await waitFor(async () => await exists(child.readyPath) || await exists(child.failurePath), 5_000)).toBe(true)
  return {
    ready: await exists(child.readyPath),
    failure: await exists(child.failurePath) ? await readFile(child.failurePath, 'utf8') : '',
  }
}

it('allows two live host processes to share one Prime state directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prime-multi-host-'))
  const stateDirectory = join(root, 'state')
  const childPids: number[] = []

  try {
    const children = ['first', 'second'].map(name => startChildFixture(root, stateDirectory, name, `session-${name}`))
    childPids.push(...children.map(child => child.pid))
    const outcomes = await Promise.all(children.map(child => childOutcome(child)))

    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.ready, outcome.failure).toBe(true)
      expect(processAlive(children[index]?.pid as number)).toBe(true)
    }
  } finally {
    for (const pid of childPids) await stopProcessTree(pid)
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('rejects a duplicate Session across processes and reclaims it after owner death', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prime-realm-takeover-'))
  const stateDirectory = join(root, 'state')
  const childPids: number[] = []

  const start = async (name: string): Promise<FixtureChild & { ready: boolean; failure: string }> => {
    const child = startChildFixture(root, stateDirectory, name, 'shared-session')
    childPids.push(child.pid)
    return { ...child, ...await childOutcome(child) }
  }

  try {
    const owner = await start('owner')
    expect(owner.ready, owner.failure).toBe(true)

    const conflict = await start('conflict')
    expect(conflict.ready).toBe(false)
    expect(conflict.failure).toContain('this Prime session is already active in another host process')

    await stopProcessTree(owner.pid)
    expect(await waitFor(() => !processAlive(owner.pid), 5_000)).toBe(true)

    const takeover = await start('takeover')
    expect(takeover.ready, takeover.failure).toBe(true)
  } finally {
    for (const pid of childPids) await stopProcessTree(pid)
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it('disposes the host and releases its Realm lease when its parent process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prime-orphan-host-'))
  const stateDirectory = join(root, 'state')
  const readyPath = join(root, 'ready')
  const disposedPath = join(root, 'disposed')
  const failurePath = join(root, 'failure')
  const releasePath = join(root, 'release-parent')
  let childPid: number | undefined
  let parentPid: number | undefined
  let survivorPid: number | undefined
  let takeoverPid: number | undefined

  try {
    const survivor = startChildFixture(root, stateDirectory, 'survivor', 'survivor-session')
    survivorPid = survivor.pid
    const survivorResult = await childOutcome(survivor)
    expect(survivorResult.ready, survivorResult.failure).toBe(true)

    const parent = spawn(process.execPath, [parentFixture, stateDirectory, readyPath, disposedPath, failurePath, releasePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    parentPid = parent.pid
    let stderr = ''
    parent.stderr.setEncoding('utf8')
    parent.stderr.on('data', chunk => { stderr += chunk })
    const parentExit = new Promise<number | null>((resolve, reject) => {
      parent.once('error', reject)
      parent.once('exit', code => { resolve(code) })
    })

    expect(await waitFor(async () => await exists(readyPath) || await exists(failurePath), 5_000)).toBe(true)
    if (await exists(failurePath)) stderr += await readFile(failurePath, 'utf8')
    expect(await exists(readyPath), stderr).toBe(true)
    childPid = Number((await readFile(readyPath, 'utf8')).trim())
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true)

    await writeFile(releasePath, 'release\n')
    expect(await parentExit, stderr).toBe(0)
    expect(await waitFor(() => !processAlive(childPid as number), 5_000)).toBe(true)
    expect(await waitFor(() => exists(disposedPath), 1_000)).toBe(true)
    expect(processAlive(survivorPid as number)).toBe(true)

    const takeover = startChildFixture(root, stateDirectory, 'normal-takeover', 'orphan-host-session')
    takeoverPid = takeover.pid
    const takeoverResult = await childOutcome(takeover)
    expect(takeoverResult.ready, takeoverResult.failure).toBe(true)
  } finally {
    if (parentPid !== undefined) await stopProcessTree(parentPid)
    if (childPid === undefined && await exists(`${readyPath}.spawned`)) {
      childPid = Number((await readFile(`${readyPath}.spawned`, 'utf8')).trim())
    }
    if (childPid !== undefined) await stopProcessTree(childPid)
    if (survivorPid !== undefined) await stopProcessTree(survivorPid)
    if (takeoverPid !== undefined) await stopProcessTree(takeoverPid)
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
