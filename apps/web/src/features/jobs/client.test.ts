import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { jobsClient } from './client'
import { definition, execution, logPage, queueTicket } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs'

describe('job client identity and retry boundary', () => {
  it('preserves exact start commandId/payload through lost acknowledgment and same-request retry', async () => {
    const requests: unknown[] = []
    const admission = { kind: 'pending-admission', ticket: queueTicket }
    server.use(http.post(`${root}/executions`, async ({ request }) => {
      requests.push(await request.json())
      return requests.length === 1 ? HttpResponse.error() : HttpResponse.json({ admission })
    }))
    const command = { commandId: 'start-a', definitionId: definition.id, expectedRevision: 1 }
    await expect(jobsClient.start(definition.workspaceId, command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await jobsClient.start(definition.workspaceId, command)).toEqual(admission)
    expect(requests).toEqual([command, command])
  })
  it('reads the accepted admission envelope without inventing execution facts', async () => {
    const admission = { kind: 'accepted', ticketId: queueTicket.id, executionId: execution.id }
    server.use(http.post(`${root}/executions`, () => HttpResponse.json({ admission })))
    expect(await jobsClient.start(definition.workspaceId,
      { commandId: queueTicket.commandId, definitionId: definition.id, expectedRevision: 1 })).toEqual(admission)
  })
  it('rejects a pending response for another command or saved definition revision', async () => {
    server.use(http.post(`${root}/executions`, () =>
      HttpResponse.json({ admission: { kind: 'pending-admission', ticket: queueTicket } })))
    await expect(jobsClient.start(definition.workspaceId,
      { commandId: 'different-start', definitionId: definition.id, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
    await expect(jobsClient.start(definition.workspaceId,
      { commandId: queueTicket.commandId, definitionId: definition.id, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  })
  it('reads scoped queue tickets and rejects a foreign workspace or ticket identity', async () => {
    server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [queueTicket] })),
      http.get(`${root}/queue/:id`, () => HttpResponse.json({ ticket: queueTicket })))
    expect(await jobsClient.queue(definition.workspaceId)).toEqual([queueTicket])
    expect(await jobsClient.queueTicket(definition.workspaceId, queueTicket.id)).toEqual(queueTicket)
    await expect(jobsClient.queue('workspace-b')).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
    await expect(jobsClient.queueTicket('workspace-b', queueTicket.id))
      .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
    await expect(jobsClient.queueTicket(definition.workspaceId, '22222222-2222-4222-8222-222222222222'))
      .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  })
  it('cancels through the ticket URL with the reviewed revision and preserves denial', async () => {
    let received: unknown
    const cancelled = { ...queueTicket, state: 'terminal', terminalReason: 'cancelled', revision: 2,
      cancelRequestedAt: queueTicket.enqueuedAt, finishedAt: queueTicket.enqueuedAt }
    server.use(http.post(`${root}/queue/:id/cancel`, async ({ request, params }) => {
      expect(params.id).toBe(queueTicket.id)
      received = await request.json()
      return HttpResponse.json({ ticket: cancelled })
    }))
    const input = { commandId: 'cancel-a', ticketId: queueTicket.id, expectedRevision: queueTicket.revision }
    expect(await jobsClient.cancelQueued(definition.workspaceId, input)).toEqual(cancelled)
    expect(received).toEqual({ commandId: 'cancel-a', expectedRevision: queueTicket.revision })
    server.use(http.post(`${root}/queue/:id/cancel`, () =>
      HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Denied' } }, { status: 403 })))
    await expect(jobsClient.cancelQueued(definition.workspaceId, input))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
  })
  it('rejects a stale or cross-workspace execution', async () => {
    server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution })))
    await expect(jobsClient.execution('workspace-b', execution.id)).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
    await expect(jobsClient.execution(execution.workspaceId, 'execution-b')).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  })
  it('enforces bounded cursor pages and rejects another attempt', async () => {
    let seen: Request | undefined
    server.use(http.get(`${root}/executions/:id/logs`, ({ request }) => { seen = request; return HttpResponse.json(logPage) }))
    await jobsClient.logs(execution.workspaceId, execution.id, execution.attemptId, 0)
    expect(new URL(seen!.url).searchParams.get('limit')).toBe('50')
    expect(seen!.credentials).toBe('same-origin')
    await expect(jobsClient.logs(execution.workspaceId, execution.id, 'attempt-b', 0)).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  })
  it('retains explicit forbidden status', async () => {
    server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 })))
    await expect(jobsClient.execution(execution.workspaceId, execution.id)).rejects.toMatchObject({ status: 403 })
  })
})
