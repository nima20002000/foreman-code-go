import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'
import { deferred } from '../../../test/helpers/deferred.js'

it('retries dispatch within a few seconds while an earlier fleet read remains blocked', async () => {
  vi.useFakeTimers()
  const entered = deferred()
  const release = deferred()
  const computers = vi.fn<HostCiEndpoint['computers']>()
    .mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return []
    })
    .mockResolvedValue([])
  const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = { computers, request: vi.fn() }
  const ci = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits, endpoint)
  let finished = false
  const first = ci.dispatch().then(() => { finished = true })
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(3500)
    expect(finished).toBe(true)
    await ci.dispatch()
    expect(computers).toHaveBeenCalledTimes(2)
    release.resolve()
    await first
  } finally {
    release.resolve()
    await first
    await ci.close()
    vi.useRealTimers()
  }
})
