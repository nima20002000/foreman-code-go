import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { jobsClient } from './client'
import { definition, execution, logPage, queueTicket, verificationDefinition,
  verificationExecution, verificationTemplate, verificationQueueTicket } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs'

it('reads mixed build and verification choices, saved versions, execution history and cancellation', async () => {
  const workspaceId = definition.workspaceId
  const choices = { sources: [definition.spec.source], targets: [], policies: [definition.spec.policy],
    autoPolicies: [{ policy: verificationTemplate.policy, limits: verificationTemplate.resources.limits }],
    verificationTemplates: [verificationTemplate] }
  server.use(
    http.get(`${root}/choices`, () => HttpResponse.json(choices)),
    http.get(`${root}/definitions`, () => HttpResponse.json({ definitions: [definition, verificationDefinition] })),
    http.get(`${root}/definitions/:id`, () => HttpResponse.json({ definition: verificationDefinition })),
    http.get(`${root}/definitions/:id/versions/:version`, () => HttpResponse.json({ definition: verificationDefinition })),
    http.get(`${root}/executions`, () => HttpResponse.json({ executions: [execution, verificationExecution] })),
    http.get(`${root}/executions/:id`, () => HttpResponse.json({ execution: verificationExecution })),
    http.post(`${root}/executions/:id/cancel`, () => HttpResponse.json({ execution: verificationExecution })),
  )
  expect(await jobsClient.choices(workspaceId)).toEqual(choices)
  expect(await jobsClient.definitions(workspaceId)).toEqual([definition, verificationDefinition])
  expect(await jobsClient.definition(workspaceId, verificationDefinition.id)).toEqual(verificationDefinition)
  expect(await jobsClient.definitionVersion(workspaceId, verificationDefinition.id, verificationDefinition.versionId))
    .toEqual(verificationDefinition)
  expect(await jobsClient.executions(workspaceId)).toEqual([execution, verificationExecution])
  expect(await jobsClient.execution(workspaceId, verificationExecution.id)).toEqual(verificationExecution)
  expect(await jobsClient.cancel(workspaceId, verificationExecution.id, 'cancel-verification')).toEqual(verificationExecution)
  await expect(jobsClient.execution('foreign', verificationExecution.id)).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
})

it('validates, saves and starts the verification request without stripping its shared record fields', async () => {
  const requests: unknown[] = []
  server.use(
    http.post(`${root}/validate`, async ({ request }) => {
      requests.push(await request.json())
      return HttpResponse.json({ valid: true, reasons: [], sideEffects: false })
    }),
    http.post(`${root}/definitions`, async ({ request }) => {
      requests.push(await request.json())
      return HttpResponse.json({ definition: verificationDefinition })
    }),
    http.post(`${root}/executions`, () => HttpResponse.json({ admission: {
      kind: 'pending-admission', ticket: verificationQueueTicket,
    } })),
  )
  const input = { commandId: 'save-verification', expectedRevision: null,
    name: verificationDefinition.name, spec: verificationDefinition.spec }
  await jobsClient.validate(definition.workspaceId, input.spec)
  expect(await jobsClient.save(definition.workspaceId, input)).toEqual(verificationDefinition)
  expect(requests).toEqual([{ spec: input.spec }, input])
  const admission = await jobsClient.start(definition.workspaceId, { commandId: verificationQueueTicket.commandId,
    definitionId: verificationDefinition.id, expectedRevision: verificationDefinition.revision })
  expect(admission).toEqual({ kind: 'pending-admission', ticket: verificationQueueTicket })
})

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
  it('reads a retained pre-queue execution without inventing a ticket and rejects changed scope or definition', async () => {
    const admission = { kind: 'retained-execution', execution }
    server.use(http.post(`${root}/executions`, () => HttpResponse.json({ admission })))
    const command = { commandId: 'historical-start', definitionId: definition.id, expectedRevision: 1 }
    expect(await jobsClient.start(definition.workspaceId, command)).toEqual(admission)
    await expect(jobsClient.start('foreign-workspace', command)).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
    await expect(jobsClient.start(definition.workspaceId, { ...command, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
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
    server.use(http.get(`${root}/queue`, () => HttpResponse.json({ tickets: [queueTicket], nextHistoryCursor: null })),
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
    expect(seen!.credentials).toBe('omit')
    expect(seen!.headers.has('Authorization')).toBe(false)
    await expect(jobsClient.logs(execution.workspaceId, execution.id, 'attempt-b', 0)).rejects.toMatchObject({ code: 'JOB_SELECTION_MISMATCH' })
  })
  it('retains explicit forbidden status', async () => {
    server.use(http.get(`${root}/executions/:id`, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied' } }, { status: 403 })))
    await expect(jobsClient.execution(execution.workspaceId, execution.id)).rejects.toMatchObject({ status: 403 })
  })
})
