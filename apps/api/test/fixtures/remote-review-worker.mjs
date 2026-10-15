/* global process, setInterval, clearInterval */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stateDirectory = process.argv[2]
const releaseDirectory = process.argv[3]
const worker = await import(pathToFileURL(join(releaseDirectory, 'src', 'worker.mjs')).href)
if (process.argv[4] === 'initialize') {
  await worker.initializeInstalledNativeRuntime(stateDirectory)
  process.exit(0)
}
// A set boot identity stands for a restarted computer; otherwise the Worker reads the real boot.
const bootId = process.env.REMOTE_REVIEW_WORKER_BOOT_ID
const runtime = await worker.startConfiguredWorker({ stateDirectory,
  ...(bootId ? { readBootId: async () => bootId } : {}) })
const { readWorkerStatus } = await import(pathToFileURL(join(releaseDirectory, 'src', 'runtime.mjs')).href)
const timer = setInterval(() => {
  void readWorkerStatus(stateDirectory).then(view => process.send?.({ kind: 'status', view }))
}, 25)
let closing = false
async function close() {
  if (closing) return
  closing = true
  clearInterval(timer)
  try {
    await runtime.stop()
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(1)
  }
}
process.on('SIGTERM', close)
process.on('SIGINT', close)
