import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

async function queuedFixture() {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'queued'
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  return { ...f, runId, read }
}

it('reports a workflow the provider has only queued as queued, not running', async () => {
  const f = await queuedFixture()
  expect(await f.cloud.handle(f.read)).toMatchObject({ run: { state: 'running', step: 'queued' } })
  f.advance(4_001)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'running', step: 'queued' } })
  expect(f.github.canceled).toEqual([])
})

it('cancels a workflow that stays queued past the start window and queues the ticket for another computer', async () => {
  const f = await queuedFixture()
  await f.cloud.handle(f.read)
  f.advance(75_001)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'queued' } })
  expect(f.github.canceled).toEqual(['91'])
})

it('keeps the ticket on the provider when canceling the queued workflow is not confirmed', async () => {
  const f = await queuedFixture()
  await f.cloud.handle(f.read)
  f.advance(75_001)
  const reopened = f.reopen()
  vi.spyOn(reopened.provider, 'cancel').mockRejectedValue(new Error('Provider unreachable'))
  expect(await reopened.handle(f.read)).toMatchObject({ run: { state: 'running' } })
})

it('starts running normally once the provider starts a job', async () => {
  const f = await queuedFixture()
  await f.cloud.handle(f.read)
  f.github.status = 'in_progress'
  f.advance(75_001)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'running' } })
  expect(f.github.canceled).toEqual([])
})
