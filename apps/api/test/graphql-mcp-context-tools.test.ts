import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'

import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'

const scope = { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] }
const worker: ManagementPrincipal = { id: 'worker-1', name: 'Worker', audience: 'worker', agentId: 'agent-1',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: ['interactions:read'], scope }] }

it('advertises only the interaction capabilities whose tools are enabled for the Agent and node', async () => {
  // The Coder's pinned configuration allows only context_get; the node adds nothing.
  const query = vi.fn(async (): Promise<{ rows: unknown[] }> => ({ rows: [{ role: 'coder', defaults: ['context_get'], override: null }] }))
  const service = new PostgresAppInteractionService({ query } as unknown as pg.Pool, {} as never, {} as never)
  const context = await service.context(worker) as { tools: string[]; capabilities: Record<string, boolean> }
  expect(context.tools).toEqual(['context_get'])
  expect(context.capabilities).toEqual({ contextGet: true, interactionList: false, interactionGet: false, interactionRespond: false })
  query.mockResolvedValueOnce({ rows: [{ role: 'coder', defaults: ['context_get'], override: { add: ['interaction_get'], remove: [] } }] })
  expect((await service.context(worker) as { capabilities: Record<string, boolean> }).capabilities)
    .toMatchObject({ interactionList: false, interactionGet: true })
})
