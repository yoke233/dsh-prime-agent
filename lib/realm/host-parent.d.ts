/**
 * Parent-process ownership for the long-lived Prime host.
 *
 * Foreground dsh processes belong to the shell or terminal process that
 * launched them. Windows does not terminate a child when that parent is
 * force-killed, while POSIX may reparent the child without delivering a
 * signal. This watcher turns either condition into bounded Cordis teardown so
 * Realm ownership claims and workers cannot survive as orphans.
 * @module dsh-prime-agent/realm/host-parent
 */
/** Parent-liveness polling interval; short enough to make Windows PID reuse unlikely. */
export declare const HOST_PARENT_CHECK_INTERVAL_MS = 250;
/** Maximum time allowed for the orphaned Cordis tree to reach quiescence. */
export declare const HOST_PARENT_SHUTDOWN_TIMEOUT_MS = 5000;
/** Injectable process operations for deterministic lifecycle tests. */
export interface HostParentWatchOptions {
    /** Parent pid captured when the Prime runtime mounts. */
    parentPid?: number;
    /** Read the process's current parent pid; POSIX changes it after reparenting. */
    readParentPid?: () => number;
    /** Probe whether the captured parent pid still names a live process. */
    parentAlive?: (pid: number) => boolean;
    /** Terminate the orphan host after teardown or its deadline. */
    exit?: (code: number) => void;
    /** Override the liveness interval. */
    checkIntervalMs?: number;
    /** Override the graceful teardown deadline. */
    shutdownTimeoutMs?: number;
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
export declare function watchHostParent(disposeRoot: () => Promise<void>, options?: HostParentWatchOptions): () => void;
//# sourceMappingURL=host-parent.d.ts.map