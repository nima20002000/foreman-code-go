import { afterEach, expect, it, vi } from 'vitest'
import { startPostgres } from './postgres.js'
import { describeFailure } from '../reporting/report.js'

const failure = vi.hoisted(() => ({
  setup: new Error('Owned PostgreSQL never reached readiness'),
  cleanup: new Error('Owned PostgreSQL process did not stop'),
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined),
  realpath: vi.fn(async (value: string) => value),
}))
vi.mock('./ports.js', () => ({ randomLoopbackPort: vi.fn(async () => 32123) }))
vi.mock('./commands.js', () => ({
  CommandError: class extends Error {},
  runCommand: vi.fn(async () => ''),
  startProcess: vi.fn(() => ({ stop: vi.fn(async () => { throw failure.cleanup }) })),
  waitUntilReady: vi.fn(async () => { throw failure.setup }),
}))

afterEach(() => { vi.restoreAllMocks() })

it('retains readiness and process cleanup errors without starting a real database', async () => {
  // This identity belongs only to the dependency doubles above; no process or database is created.
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
  const result = await startPostgres({ directory: '/conformance-owned-postgres', environment: {}, binaryDirectory: '/fixture-postgres-bin' })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AggregateError)
  expect(result).toMatchObject({
    message: 'PostgreSQL startup and cleanup failed',
    errors: [failure.setup, failure.cleanup], cause: failure.cleanup,
  })
  expect(describeFailure(result).causes).toEqual([
    { name: 'Error', message: failure.setup.message },
    { name: 'Error', message: failure.cleanup.message },
  ])
})
