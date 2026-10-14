import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sweepCiRunDirectories } from './directoryRetention.js'
import { withHostCiRunLock } from './runnerLock.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-directory-'))
  roots.push(root)
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ state: 'passed' }))
  await writeFile(join(directory, 'log'), 'retained bytes')
  const options = { root, runIds: [runId], isInUse: () => false,
    withRun: (_id: string, work: () => Promise<boolean>) => withHostCiRunLock(directory, work, { nonBlocking: true }) }
  return { directory, options }
}

it('preserves a terminal directory locked by another runner, then removes it once unused', async () => {
  const f = await fixture()
  await withHostCiRunLock(f.directory, async () => {
    await expect(sweepCiRunDirectories(f.options)).resolves.toEqual([])
  })
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
  await expect(sweepCiRunDirectories(f.options)).resolves.toEqual(f.options.runIds)
  await expect(access(f.directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rechecks use after acquiring the directory lock', async () => {
  const f = await fixture()
  let inUse = false
  await expect(sweepCiRunDirectories({ ...f.options, isInUse: () => inUse,
    withRun: async (_id, work) => {
      inUse = true
      return work()
    } })).resolves.toEqual([])
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
})

it('rejects identifiers outside the run directory namespace', async () => {
  const f = await fixture()
  await expect(sweepCiRunDirectories({ ...f.options, runIds: ['../retained'] })).rejects.toThrow()
  await expect(readFile(join(f.directory, 'log'), 'utf8')).resolves.toBe('retained bytes')
})
