import { expect, it, vi } from 'vitest'
import { createIsolatedEnvironment } from './environment.js'
import { describeFailure } from '../reporting/report.js'

const failure = vi.hoisted(() => ({
  setup: new Error('Managed launcher copy failed'),
  cleanup: new Error('Owned marker could not be inspected'),
}))

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/conformance-owned-environment'),
  realpath: vi.fn(async (value: string) => value),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => { throw failure.setup }),
  lstat: vi.fn(async () => { throw failure.cleanup }),
  readFile: vi.fn(), rm: vi.fn(),
}))

it('retains setup and ownership cleanup failures when isolated environment creation fails', async () => {
  const result = await createIsolatedEnvironment('/conformance-repository', { PATH: '/usr/bin:/bin' })
    .catch((error: unknown) => error)
  expect(result).toBeInstanceOf(AggregateError)
  expect(result).toMatchObject({
    message: 'Conformance directory setup and cleanup failed',
    errors: [failure.setup, failure.cleanup], cause: failure.cleanup,
  })
  expect(describeFailure(result).causes).toEqual([
    { name: 'Error', message: failure.setup.message },
    { name: 'Error', message: failure.cleanup.message },
  ])
})
