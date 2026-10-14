import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

afterEach(() => vi.restoreAllMocks())

it('ends an expired session lock wait with a retryable domain error before executing the command', async () => {
  const principal: ManagementPrincipal = { id: 'fixture', name: 'Fixture', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const release = vi.fn()
  const end = vi.fn(async () => undefined)
  const client = { release, query: async (statement: string) => ({
    rows: statement.includes('advisory_lock(') ? [{ locked: false }] : [], rowCount: 0,
  }) }
  const pool = { options: {}, connect: async () => client, end }
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return pool } as never)
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(600_001)
  const perform = vi.fn(async () => 'captured')
  const coordinator = new PostgresCommandCoordinator(pool as unknown as pg.Pool)
  await expect(coordinator.execute({ principal, source: 'mcp', operation: 'source.project.capture',
    commandId: 'capture', targetKey: 'workspace', payload: {}, dedicatedConnection: true, perform,
  })).rejects.toMatchObject({ code: 'COMMAND_LOCK_TIMEOUT', status: 503,
    details: { retryable: true, newCommandRequired: false } })
  expect(perform).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
  expect(end).toHaveBeenCalledOnce()
})
