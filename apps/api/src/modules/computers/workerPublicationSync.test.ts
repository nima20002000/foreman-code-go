import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startWorkerPublicationSync } from './workerPublicationSync.js'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const directory = await mkdtemp(join(storage, 'worker-publication-sync-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const write = async (state: string) => {
    const index = { format: 1, version: '1.0.0', artifacts: [], publication: { state, lastError: null } }
    const temporary = join(directory, '.publishing')
    await writeFile(temporary, JSON.stringify(index))
    await rename(temporary, join(directory, 'index.json'))
  }
  await write('pending')
  const sync = vi.fn(async () => {})
  const reportError = vi.fn()
  const stop = startWorkerPublicationSync({ directory, version: '1.0.0' }, sync, reportError)
  cleanup.push(stop)
  return { directory, write, sync, reportError, stop }
}

it('checks devices as soon as publication completes after an early unpublished check', async () => {
  const f = await fixture()
  await f.write('failed')
  await f.write('pending')
  expect(f.sync).not.toHaveBeenCalled()
  await f.write('published')
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledOnce())
  expect(f.reportError).not.toHaveBeenCalled()
})

it('checks a publication that completes before the watcher starts', async () => {
  const f = await fixture()
  f.stop()
  await f.write('published')
  cleanup.push(startWorkerPublicationSync({ directory: f.directory, version: '1.0.0' }, f.sync, f.reportError))
  await vi.waitFor(() => expect(f.sync).toHaveBeenCalledOnce())
})

it('keeps startup available when no Worker artifact directory has been installed', async () => {
  const f = await fixture()
  f.stop()
  await rm(f.directory, { recursive: true })
  const stop = startWorkerPublicationSync({ directory: f.directory, version: '1.0.0' }, f.sync, f.reportError)
  cleanup.push(stop)
  expect(f.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOENT' }))
  expect(f.sync).not.toHaveBeenCalled()
  stop()
})

it('retains periodic recovery checks and stops them on shutdown', async () => {
  vi.useFakeTimers()
  try {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sync).toHaveBeenCalledOnce()
    f.stop()
    await f.write('published')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.sync).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
