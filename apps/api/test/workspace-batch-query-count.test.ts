import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'

it.each([1, 100])('uses a constant number of domain and cleanup queries to archive %i workspaces', async (size) => {
  const workspaces = Array.from({ length: size }, (_, index) => ({ workspaceId: `workspace-${index}`, expectedRevision: 0 }))
  const query = vi.fn(async (sql: string) => ({ rows:
    sql.includes('select archived_at') ? [{ archived_at: null }]
      : sql.includes('select id, revision') ? workspaces.map((item) => ({ id: item.workspaceId, revision: '0' })) : [],
  }))
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  const commands = { execute: async (input: { perform: (client: pg.PoolClient) => Promise<unknown> }) => input.perform(client) } as unknown as PostgresCommandCoordinator
  const service = new WorkspaceManagementService({ connect: async () => client } as unknown as pg.Pool, commands, {} as WorkspaceLocationService)
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['workspaces:archive'], scope: {} }] }
  await service.archiveBatch(principal, 'http', { commandId: 'batch-query-count', workspaces })
  expect(query).toHaveBeenCalledTimes(8)
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('update workspaces'))).toHaveLength(1)
})
