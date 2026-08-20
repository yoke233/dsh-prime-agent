/**
 * Parent-process ownership for the long-lived Prime host.
 *
 * Foreground dsh processes belong to the shell or terminal process that
 * launched them. Windows does not terminate a child when that parent is
 * force-killed, while POSIX may reparent the child without delivering a
 * signal. This watcher turns either condition into bounded Cordis teardown so
 * the host lease and Realm workers cannot survive as an orphan.
 * @module dsh-prime-agent/realm/host-parent
 */

/** Parent-liveness polling interval; short enough to make Windows PID reuse unlikely. */
export const HOST_PARENT_CHECK_INTERVAL_MS = 250

/** Maximum time allowed for the orphaned Cordis tree to reach quiescence. */
export const HOST_PARENT_SHUTDOWN_TIMEOUT_MS = 5_000

/** Injectable process operations for deterministic lifecycle tests. */
export interface HostParentWatchOptions {
  /** Parent pid captured when the Prime runtime mounts. */
  parentPid?: number
  /** Read the process's current parent pid; POSIX changes it after reparenting. */
  readParentPid?: () => number
  /** Probe whether the captured parent pid still names a live process. */
  parentAlive?: (pid: number) => boolean
  /** Terminate the orphan host after teardown or its deadline. */
  exit?: (code: number) => void
  /** Override the liveness interval. */
  checkIntervalMs?: number
  /** Override the graceful teardown deadline. */
  shutdownTimeoutMs?: number
}

/**
 * Probe process existence without delivering a signal.
 *
 * Only ESRCH proves absence. EPERM and unfamiliar platform errors fail open:
 * terminating a legitimate foreground host is worse than retaining an orphan
 * that the single-owner lease still prevents from being joined by another host.
 * @param pid - process id to probe.
 * @returns whether the process may still exist.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH'
  }
}

/**
 * Watch the direct parent of this Prime host and stop the process if ownership
 * disappears. The returned disposer only stops observation; when orphan
 * shutdown has started, its force-exit deadline remains armed until teardown
 * settles.
 * @param disposeRoot - dispose the complete Cordis root and await quiescence.
 * @param options - injectable process probes, timers, and exit operation.
 * @returns a disposer that stops parent observation during ordinary teardown.
 */
export function watchHostParent(
  disposeRoot: () => Promise<void>,
  options: HostParentWatchOptions = {},
): () => void {
  const parentPid = options.parentPid ?? process.ppid
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || parentPid === process.pid) return () => {}

  const readParentPid = options.readParentPid ?? (() => process.ppid)
  const parentAlive = options.parentAlive ?? processAlive
  const exit = options.exit ?? ((code: number) => { process.exit(code) })
  const checkIntervalMs = options.checkIntervalMs ?? HOST_PARENT_CHECK_INTERVAL_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? HOST_PARENT_SHUTDOWN_TIMEOUT_MS
  let monitoring = true
  let exited = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined

  const exitOnce = (code: number): void => {
    if (exited) return
    exited = true
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    exit(code)
  }

  const interval = setInterval(() => {
    if (!monitoring) return
    if (readParentPid() === parentPid && parentAlive(parentPid)) return

    monitoring = false
    clearInterval(interval)
    forceTimer = setTimeout(() => { exitOnce(1) }, shutdownTimeoutMs)
    void disposeRoot().then(
      () => { exitOnce(0) },
      () => { exitOnce(1) },
    )
  }, checkIntervalMs)
  interval.unref()

  return () => {
    if (!monitoring) return
    monitoring = false
    clearInterval(interval)
  }
}
