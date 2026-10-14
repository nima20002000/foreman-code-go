import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { CloudStatus } from './cloudProviders.js'
import { fixture } from './cloud.testSupport.js'

async function runningFixture(durations: number[]) {
  const f = await fixture()
  vi.spyOn(f.cloud.provider, 'find').mockImplementation(async run => run.runId)
  vi.spyOn(f.cloud.provider, 'status').mockResolvedValue({ done: false })
  vi.spyOn(f.cloud.provider, 'log').mockResolvedValue('finished\n')
  vi.spyOn(f.cloud.provider, 'artifacts').mockResolvedValue({ durations: null, testResults: null })
  const ids = durations.map(() => randomUUID())
  for (const [index, runId] of ids.entries()) {
    await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
      repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full',
      expectedDurationMs: durations[index]! })
    await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
  }
  return { ...f, ids, read: (runId: string) => f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }) }
}

it('notices completion within three seconds near the expected end', async () => {
  const f = await runningFixture([10_000])
  f.advance(10_000)
  await f.read(f.ids[0]!)
  vi.mocked(f.cloud.provider.status).mockResolvedValue({ done: true, conclusion: 'success',
    finishedAt: f.ports.now().toISOString() })
  f.advance(2500)
  expect(await f.read(f.ids[0]!)).toMatchObject({ run: { state: 'passed' } })
})

it('polls a busy cloud fleet concurrently and puts an overdue queued run first', async () => {
  const f = await runningFixture([...Array<number>(47).fill(600_000), 10_000])
  f.advance(15_000)
  const calls: string[] = []
  const releases = new Map<string, () => void>()
  let unblock = false
  vi.mocked(f.cloud.provider.status).mockImplementation(async run => {
    calls.push(run.runId)
    if (!unblock) await new Promise<void>(resolve => { releases.set(run.runId, resolve) })
    return { done: false } satisfies CloudStatus
  })
  const reads = f.ids.slice(0, -1).map(f.read)
  try {
    await expect.poll(() => calls.length).toBeGreaterThanOrEqual(24)
    const overdue = f.read(f.ids.at(-1)!)
    reads.push(overdue)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    // The read must reach the status queue before a slot is released.
    await expect.poll(() => f.read(f.ids.at(-1)!)).toMatchObject({ run: { state: 'running' } })
    const initial = calls.length
    releases.get(calls[0]!)!()
    await expect.poll(() => calls.length).toBeGreaterThan(initial)
    expect(calls[initial]).toBe(f.ids.at(-1))
  } finally {
    unblock = true
    for (const release of releases.values()) release()
    await Promise.all(reads)
  }
})
