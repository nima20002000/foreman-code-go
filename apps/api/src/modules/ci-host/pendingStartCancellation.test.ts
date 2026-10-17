import { randomUUID } from 'node:crypto'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { CI_RUN_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { ticketStore } from './ciTicketStore.testSupport.js'
import { queuedTicket, readyStatus } from './dispatchFleet.testSupport.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

it.each(['main', 'device'] as const)(
  'delivers Stop to a %s executor before its Start acknowledgement and rejects the late reply', async kind => {
    const computer: HostCiComputer = { key: 'executor', label: 'Executor', priority: 0,
      hostRef: kind === 'main' ? { kind, mainId: 'main' } : { kind, mainId: 'main', deviceId: 'device' } }
    const run = queuedTicket()
    const caller: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
      grants: [{ actions: CI_RUN_ACTIONS, scope: { workspaceIds: [run.workspaceId] } }],
      expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
    const authority: CiAuthority = { resolve: async () => ({ principal: caller, workspaceId: run.workspaceId }) }
    let entered = false
    const acknowledge = deferred()
    const executionRunId = randomUUID()
    // Retries must signal the persisted execution ID rather than the ticket ID.
    const retry = queuedTicket({ ...run, executionRunId })
    const retryStore = ticketStore([retry])
    const stopped: string[] = []
    const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_computer, request) => {
      if (request.operation === 'status') return readyStatus()
      if (request.operation === 'start') {
        entered = true
        await acknowledge.promise
        return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'build',
          startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
      }
      if (request.operation === 'cancel') {
        stopped.push(request.runId)
        return { operation: 'cancel', run: { runId: request.runId, state: 'canceled', step: null,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          exitCode: null, message: 'Canceled.', logBytes: 0 } }
      }
      throw new Error(`Unexpected ${request.operation}`)
    } }
    const service = new HostCiService(retryStore.pool, {} as PostgresCommandCoordinator, authority,
      {} as CiCommits, endpoint)
    try {
      const dispatching = service.dispatch()
      await vi.waitFor(() => expect(entered, JSON.stringify(retryStore.read(run.id).record)).toBe(true))
      await expect(service.cancel(caller, { workspaceId: run.workspaceId, ticketId: run.id }))
        .rejects.toMatchObject({ code: 'CI_CANCEL_PENDING' })
      expect(stopped).toEqual([executionRunId])
      expect(retryStore.read(run.id).record).toMatchObject({ state: 'starting', cancellation: { reason: 'direct' } })
      acknowledge.resolve()
      await dispatching
      await service.drain()
      expect(retryStore.read(run.id).record.state).not.toBe('running')
      await expect(service.cancel(caller, { workspaceId: run.workspaceId, ticketId: run.id }))
        .resolves.toMatchObject({ run: { state: 'canceled' } })
      expect(retryStore.read(run.id)).toMatchObject({ state: 'canceled', hostKey: null })
    } finally {
      acknowledge.resolve()
      await service.close()
    }
  },
)
