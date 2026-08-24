// Process-wide RSS peak sampler.
//
// snapshotValue + JSON.stringify are synchronous, so the main thread cannot
// sample its own peak. `process.memoryUsage.rss()` is process-wide, and a
// worker thread keeps its own event loop while the main thread is blocked, so
// the worker can poll the true peak of the synchronous section.

import { Worker } from 'node:worker_threads'

const WORKER_SOURCE = `
import { workerData, parentPort } from 'node:worker_threads'
const view = new Float64Array(workerData.buffer)
const rss = process.memoryUsage.rss
setInterval(() => {
  const value = rss()
  if (value > view[0]) view[0] = value
  view[1] = value
}, workerData.intervalMs)
parentPort.on('message', (message) => { if (message === 'stop') process.exit(0) })
parentPort.postMessage('ready')
`

export async function startRssSampler(intervalMs = 2) {
  const buffer = new SharedArrayBuffer(16)
  const view = new Float64Array(buffer)
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { buffer, intervalMs },
    execArgv: ['--input-type=module'],
  })
  await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  return {
    reset() { view[0] = process.memoryUsage.rss() },
    peak() { return view[0] },
    current() { return view[1] },
    async stop() {
      worker.postMessage('stop')
      await new Promise((resolve) => worker.once('exit', resolve))
    },
  }
}
