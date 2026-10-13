import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'

it('checks each active unit once per status poll and keeps its resource usage in capacity', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-poll-'))
  const calls: string[][] = []
  const ports: HostCiPorts = { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30, run: async (file, args) => {
      if (file === 'systemctl') calls.push([...args])
      return { code: 0, stdout: file === 'systemctl' ? 'active\n' : '', stderr: '' }
    } }
  const ids = Array.from({ length: 3 }, () => randomUUID())
  try {
    for (const runId of ids) {
      const directory = join(root, 'runs', runId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, repository: 'example/project',
        commit: 'a'.repeat(40), suite: 'lint', state: 'running', startedAt: '2026-10-13T00:00:00Z',
        finishedAt: null, exitCode: null, message: null, cleaned: false,
        resources: { cpuCount: 2, memoryBytes: 2 * 2 ** 30 } }))
      await writeFile(join(directory, 'log'), '')
    }
    const runner = new HostCiRunner(root, ports)
    const status = await runner.handle({ operation: 'status' })
    expect(status).toMatchObject({ operation: 'status', ready: true, slotsUsed: 3 })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs.map(run => run.runId).sort()).toEqual(ids.sort())
    expect(status.runs.every(run => run.state === 'running')).toBe(true)
    expect(calls).toHaveLength(ids.length)
    await runner.handle({ operation: 'status' })
    expect(calls).toHaveLength(2 * ids.length)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
