import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const spawned = vi.hoisted(() => [] as string[])
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: ((file: string, ...rest: unknown[]) => {
    spawned.push(file)
    return (actual.spawn as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof actual.spawn }
})
const { HostCiRunner } = await import('./runner.js')

it('reads settled runs on a status poll without starting a lock process per run', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-settled-'))
  const ids = Array.from({ length: 5 }, () => randomUUID())
  try {
    for (const runId of ids) {
      const directory = join(root, 'runs', runId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'example/project',
        commit: 'a'.repeat(40), suite: 'lint', state: 'passed', startedAt: '2026-10-13T00:00:00Z',
        finishedAt: '2026-10-13T00:01:00Z', exitCode: 0, message: null, cleaned: true }))
      await writeFile(join(directory, 'log'), '')
    }
    const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: () => 16 * 2 ** 30, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    spawned.length = 0
    const status = await runner.handle({ operation: 'status' })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs.map(run => [run.runId, run.state]).sort()).toEqual(ids.map(id => [id, 'passed']).sort())
    expect(spawned.filter(file => file.endsWith('flock'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
