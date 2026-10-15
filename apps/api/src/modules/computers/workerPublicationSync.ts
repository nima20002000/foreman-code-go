import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkerArtifactIndexSchema } from '@foreman-code/contracts/computer-maintenance'

export function startWorkerPublicationSync(
  location: { directory: string; version: string },
  sync: () => Promise<void>,
  reportError: (error: unknown) => void,
): () => void {
  let stopped = false
  let published = false
  let checking = Promise.resolve()
  const check = () => {
    checking = checking.then(async () => {
      if (stopped || published) return
      const index = WorkerArtifactIndexSchema.parse(JSON.parse(await readFile(join(location.directory, 'index.json'), 'utf8')))
      if (stopped || index.version !== location.version || index.publication?.state !== 'published') return
      await sync()
      published = true
    }).catch(reportError)
  }
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(location.directory, { persistent: false }, (_event, filename) => {
      // The publisher replaces index.json atomically, so watch its directory rather than its inode.
      if (filename === null || filename === 'index.json') check()
    })
    watcher.on('error', reportError)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Source checkouts can start before any Worker bundle is installed; periodic synchronization remains available.
    reportError(error)
  }
  check()
  const timer = setInterval(() => { void sync().catch(reportError) }, 60_000)
  timer.unref()
  return () => {
    stopped = true
    watcher?.close()
    clearInterval(timer)
  }
}
