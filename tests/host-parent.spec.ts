import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PARENT_CHECK_INTERVAL_MS,
  HOST_PARENT_SHUTDOWN_TIMEOUT_MS,
  watchHostParent,
} from '../src/realm/host-parent.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('host parent watcher', () => {
  it('stays idle while the captured parent is live and stops with ordinary teardown', async () => {
    vi.useFakeTimers()
    const dispose = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    const stop = watchHostParent(dispose, {
      parentPid: 42,
      readParentPid: () => 42,
      parentAlive: () => true,
      exit,
    })

    await vi.advanceTimersByTimeAsync(HOST_PARENT_CHECK_INTERVAL_MS * 2)
    expect(dispose).not.toHaveBeenCalled()
    stop()
    await vi.advanceTimersByTimeAsync(HOST_PARENT_CHECK_INTERVAL_MS * 2)
    expect(dispose).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it.each([
    ['the process is reparented', () => 1, () => true],
    ['the original parent pid is gone', () => 42, () => false],
  ])('disposes and exits cleanly when %s', async (_label, readParentPid, parentAlive) => {
    vi.useFakeTimers()
    const dispose = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    watchHostParent(dispose, { parentPid: 42, readParentPid, parentAlive, exit })

    await vi.advanceTimersByTimeAsync(HOST_PARENT_CHECK_INTERVAL_MS)
    expect(dispose).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('exits nonzero when orphan teardown rejects or exceeds its deadline', async () => {
    vi.useFakeTimers()
    const rejectedExit = vi.fn()
    watchHostParent(() => Promise.reject(new Error('dispose failed')), {
      parentPid: 42,
      readParentPid: () => 1,
      exit: rejectedExit,
    })
    await vi.advanceTimersByTimeAsync(HOST_PARENT_CHECK_INTERVAL_MS)
    expect(rejectedExit).toHaveBeenCalledExactlyOnceWith(1)

    const pending = deferred()
    const timedExit = vi.fn()
    watchHostParent(() => pending.promise, {
      parentPid: 43,
      readParentPid: () => 1,
      exit: timedExit,
    })
    await vi.advanceTimersByTimeAsync(HOST_PARENT_CHECK_INTERVAL_MS + HOST_PARENT_SHUTDOWN_TIMEOUT_MS)
    expect(timedExit).toHaveBeenCalledExactlyOnceWith(1)

    pending.resolve()
    await Promise.resolve()
    expect(timedExit).toHaveBeenCalledOnce()
  })

  it('does not watch an init parent or the current process', async () => {
    vi.useFakeTimers()
    const dispose = vi.fn(() => Promise.resolve())
    const exit = vi.fn()
    watchHostParent(dispose, { parentPid: 1, exit })
    watchHostParent(dispose, { parentPid: process.pid, exit })

    await vi.runAllTimersAsync()
    expect(dispose).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})
