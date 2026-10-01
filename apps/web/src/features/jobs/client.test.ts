import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { jobsClient } from './client'
import { definition, execution, logPage } from './fixtures'
const root = '*/api/management/workspaces/:workspaceId/jobs'

describe('job client identity and retry boundary', () => {
  it('preserves exact start commandId/payload through lost acknowledgment and same-request retry', async () => {
    const requests: unknown[] = []
    server.use(http.post(`${root}/executions`, async ({ request }) => { requests.push(await request.json()); return requests.length === 1 ? HttpResponse.error() : HttpResponse.json({ execution }) }))
    const command = { commandId: 'start-a', definitionId: definition.id, expectedRevision: 1 }
    await expect(jobsClient.start(definition.workspaceId, command)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(await jobsClient.start(definition.workspaceId, command)).toEqual(execution)
    expect(requests).toEqual([command, command])
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
