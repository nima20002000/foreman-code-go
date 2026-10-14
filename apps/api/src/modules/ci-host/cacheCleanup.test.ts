import { mkdir, mkdtemp, access, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sweepHostCiCache } from './cacheCleanup.js'
import { withHostCiRunLock } from './runnerLock.js'

it('preserves a cache held by another runner and evicts its oldest entries after the lock is released', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cache-'))
  const cache = join(root, 'cache/fixture/site')
  const oldest = join(cache, 'pnpm-store/old')
  const newest = join(cache, 'pnpm-store/new')
  await mkdir(join(cache, 'pnpm-store'), { recursive: true })
  await writeFile(oldest, 'old bytes')
  await writeFile(newest, 'new bytes')
  await utimes(oldest, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
  await utimes(newest, new Date('2026-10-03T00:00:00Z'), new Date('2026-10-03T00:00:00Z'))
  const options = { budgetBytes: 9, activeRepositories: () => new Set<string>() }
  try {
    await withHostCiRunLock(cache, async () => {
      await expect(sweepHostCiCache(root, options)).resolves.toEqual([])
    })
    await expect(sweepHostCiCache(root, options)).resolves.toEqual([oldest])
    await expect(readFile(newest, 'utf8')).resolves.toBe('new bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('evicts complete contracts snapshots and preserves lock files and cache entries within the budget', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cache-snapshot-'))
  const cache = join(root, 'cache/fixture/site')
  const snapshot = join(cache, 'contracts/snapshot')
  await mkdir(snapshot, { recursive: true })
  await mkdir(join(cache, 'locks'))
  await writeFile(join(snapshot, '.ci-cache-key'), 'key')
  await writeFile(join(snapshot, 'output'), 'built bytes')
  await writeFile(join(cache, 'locks/install.lock'), '')
  try {
    await expect(sweepHostCiCache(root, { budgetBytes: 20, activeRepositories: () => new Set<string>() }))
      .resolves.toEqual([])
    await expect(sweepHostCiCache(root, { budgetBytes: 0, activeRepositories: () => new Set<string>() }))
      .resolves.toEqual([snapshot])
    await expect(access(snapshot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(cache, 'locks/install.lock'), 'utf8')).resolves.toBe('')
  } finally { await rm(root, { recursive: true, force: true }) }
})
