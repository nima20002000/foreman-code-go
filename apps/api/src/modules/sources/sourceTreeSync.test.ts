import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { openPrivateRoot } from './privateFilesystem.js'
import { syncSourceTree } from './sourceTreeSync.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('flushes an open directory after its path is renamed, including nested writes', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-sync-'))
  roots.push(root)
  const original = join(root, 'original')
  const moved = join(root, 'moved')
  await mkdir(original, { mode: 0o700 })
  const tree = await openPrivateRoot(original)
  try {
    await mkdir(join(original, 'nested'), { mode: 0o700 })
    await writeFile(join(original, 'nested/source.txt'), 'verified bytes', { mode: 0o400 })
    await rename(original, moved)
    await syncSourceTree(tree, AbortSignal.timeout(5000))
    expect(await readFile(join(moved, 'nested/source.txt'), 'utf8')).toBe('verified bytes')
  } finally { await tree.close() }
})

it('rejects cancellation before starting a filesystem flush', async () => {
  const tree = await open(persistentFixtureRoot)
  try {
    const failure = new Error('Preparation canceled')
    await expect(syncSourceTree(tree, AbortSignal.abort(failure))).rejects.toBe(failure)
  } finally { await tree.close() }
})

it('rejects an invalid inherited directory instead of reporting a successful flush', async () => {
  const tree = await open(persistentFixtureRoot)
  await tree.close()
  await expect(syncSourceTree(tree, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'EBADF' })
})
