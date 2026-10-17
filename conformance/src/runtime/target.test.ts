import { expect, it, vi } from 'vitest'
import { startTarget } from './target.js'
import { describeFailure } from '../reporting/report.js'

const failure = vi.hoisted(() => ({
  setup: new Error('Fresh database initialization failed'),
  cleanup: new Error('Owned target state could not be removed'),
}))

vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => undefined),
  readFile: vi.fn(async () => JSON.stringify({ version: '0.1.0' })),
}))
vi.mock('./environment.js', () => ({ createIsolatedEnvironment: vi.fn(async () => ({
  directory: '/conformance-owned-target', token: 'owned-fixture-token', environment: {},
  close: vi.fn(async () => { throw failure.cleanup }),
})) }))
vi.mock('./postgres.js', () => ({ startPostgres: vi.fn(async () => { throw failure.setup }) }))
vi.mock('./owned-processes.js', () => ({ waitForOwnedProcessesToExit: vi.fn(async () => undefined) }))

it('retains target setup and cleanup errors while reporting cleanup as failed', async () => {
  const onCleanup = vi.fn()
  const result = await startTarget({ target: 'go', repoRoot: '/conformance-repository', environment: {}, onCleanup })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AggregateError)
  expect(result).toMatchObject({
    message: 'Target setup and cleanup failed',
    errors: [failure.setup, failure.cleanup], cause: failure.cleanup,
  })
  expect(describeFailure(result).causes).toEqual([
    { name: 'Error', message: failure.setup.message },
    { name: 'Error', message: failure.cleanup.message },
  ])
  expect(onCleanup.mock.calls.map(([event]) => event)).toEqual([
    { type: 'start' }, { type: 'finish', status: 'failed' },
  ])
})
