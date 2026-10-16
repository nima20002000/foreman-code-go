import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { directoryFlags, withPrivateDirectoryLock } from './privateFilesystem.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const roots: string[] = []
afterEach(async () => {
  vi.mocked(spawn).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'directory-lock-'))
  roots.push(root)
  return { root, handle: await open(root, directoryFlags) }
}

it('serializes pinned directory operations without spawning a child process', async () => {
  const f = await fixture()
  let inside = 0
  let maximum = 0
  try {
    const values = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      withPrivateDirectoryLock(f.handle, async guard => {
        expect((await guard.stat()).ino).toBe((await f.handle.stat()).ino)
        maximum = Math.max(maximum, ++inside)
        await delay(5)
        inside--
        return index
      })))
    expect(values).toEqual([0, 1, 2, 3, 4, 5])
    expect(maximum).toBe(1)
    expect(spawn).not.toHaveBeenCalled()
  } finally { await f.handle.close() }
})

it('keeps nonblocking exclusion and cancellation after the pinned directory is renamed', async () => {
  const f = await fixture()
  try {
    await withPrivateDirectoryLock(f.handle, async () => {
      await rename(f.root, `${f.root}-renamed`)
      roots.push(`${f.root}-renamed`)
      await expect(withPrivateDirectoryLock(f.handle, async () => true, { nonBlocking: true }))
        .rejects.toMatchObject({ code: 'SOURCE_CLAIM_LOCK_FAILED' })
      const controller = new AbortController()
      const waiting = withPrivateDirectoryLock(f.handle, async () => true, { signal: controller.signal })
      const rejected = expect(waiting).rejects.toThrow('Canceled lock wait')
      await delay(10)
      controller.abort(new Error('Canceled lock wait'))
      await rejected
    })
    await expect(withPrivateDirectoryLock(f.handle, async () => 'released')).resolves.toBe('released')
    expect(spawn).not.toHaveBeenCalled()
  } finally { await f.handle.close() }
})

it('releases the lock when the operation throws', async () => {
  const f = await fixture()
  try {
    await expect(withPrivateDirectoryLock(f.handle, async () => { throw new Error('Work failed') }))
      .rejects.toThrow('Work failed')
    await expect(withPrivateDirectoryLock(f.handle, async () => 42, { nonBlocking: true })).resolves.toBe(42)
    expect(spawn).not.toHaveBeenCalled()
  } finally { await f.handle.close() }
})

it('shares the same kernel lock with external flock callers', async () => {
  const f = await fixture()
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const lock = () => promisify(execFile)('/usr/bin/flock', ['--exclusive', '--nonblock', f.root, '/usr/bin/true'])
  try {
    await withPrivateDirectoryLock(f.handle, async () => {
      await expect(lock()).rejects.toMatchObject({ code: 1 })
    })
    await expect(lock()).resolves.toMatchObject({ stdout: '' })
    expect(spawn).not.toHaveBeenCalled()
  } finally { await f.handle.close() }
})
