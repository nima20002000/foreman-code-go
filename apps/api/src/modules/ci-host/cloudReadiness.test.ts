import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it.each(['github', 'circleci'] as const)(
  'answers every %s slot readiness while one recovery sweep is blocked', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
    const path = join(f.root, 'ci-cloud', 'runs', runId, 'meta.json')
    const run = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...run, providerRunId: run.providerRunId ?? 'fixture-run',
      state: 'canceled', finishedAt: run.startedAt,
      cancellation: { at: run.startedAt, canceledIds: [] } }))
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const cancel = vi.spyOn(f.cloud.provider, 'cancel').mockImplementation(() => blocked)
    let timer: NodeJS.Timeout | undefined
    const statuses = Promise.all(f.cloud.computers().map(() => f.cloud.handle({ operation: 'status' })))
    try {
      const result = await Promise.race([statuses, new Promise<'blocked'>(resolve => {
        timer = setTimeout(() => resolve('blocked'), 500)
      })])
      expect(result).not.toBe('blocked')
      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'status', ready: true })]))
      await expect.poll(() => cancel.mock.calls.length).toBe(1)
    } finally {
      clearTimeout(timer)
      release()
      await statuses
      await f.cloud.reconcile()
    }
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(path, 'utf8')).cancellation.canceledIds).toHaveLength(1)
  },
)
