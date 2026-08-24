// Shared measurement helpers: forced GC, settled heap readings, GC-event
// accounting around a synchronous section.

import { PerformanceObserver, constants } from 'node:perf_hooks'

export function forceGc() {
  if (typeof globalThis.gc !== 'function') throw new Error('run node with --expose-gc')
  globalThis.gc()
  globalThis.gc()
}

export function heapUsed() {
  return process.memoryUsage().heapUsed
}

/** Settled heap: GC twice, then read. Reflects what is actually retained. */
export function settledHeap() {
  forceGc()
  return heapUsed()
}

export function bytesToMib(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 1000) / 1000
}

/** Count GC events and total pause time across a synchronous section. */
export function startGcAccounting() {
  const events = { count: 0, pauseMs: 0, majorCount: 0, majorPauseMs: 0 }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      events.count += 1
      events.pauseMs += entry.duration
      if (entry.detail && entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
        events.majorCount += 1
        events.majorPauseMs += entry.duration
      }
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  return {
    stop() {
      observer.disconnect()
      return {
        count: events.count,
        pauseMs: Math.round(events.pauseMs * 100) / 100,
        majorCount: events.majorCount,
        majorPauseMs: Math.round(events.majorPauseMs * 100) / 100,
      }
    },
  }
}

export function ms(value) {
  return Math.round(value * 1000) / 1000
}
