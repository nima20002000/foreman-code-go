import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { ScheduleSaveInput } from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { scheduleApi, schedulePath } from './client'

const scope = { workspaceId: 'workspace-test', workflowId: 'workflow-test' }
const input: ScheduleSaveInput = { ...scope, commandId: 'schedule-client-command', expectedRevision: 0,
  schedule: { mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC', enabled: true, policy: 'latest_saved' } }
const value = { ...scope, ...input.schedule, revision: 1, nextOccurrenceAt: '2099-08-24T09:00:00.000Z' }

describe('schedule HTTP client', () => {
  it('encodes both scope segments', () => {
    expect(schedulePath({ workspaceId: 'space/one', workflowId: 'flow?& two' }))
      .toBe('/api/management/workspaces/space%2Fone/workflows/flow%3F%26%20two/schedule')
  })
  it('reads absence without synthesizing a schedule', async () => {
    server.use(http.get(schedulePath(scope), ({ request }) => {
      expect(request.credentials).toBe('same-origin')
      return HttpResponse.json({ schedule: null })
    }))
    expect(await scheduleApi.get(scope)).toEqual({ schedule: null })
  })
  it('sends the shared save envelope and validates persisted readback', async () => {
    server.use(http.put(schedulePath(scope), async ({ request }) => {
      const { workspaceId, workflowId, ...body } = input; void workspaceId; void workflowId
      expect(await request.json()).toEqual(body)
      return HttpResponse.json({ value, replayed: false })
    }))
    expect(await scheduleApi.save(input)).toEqual({ value, replayed: false })
  })
  it('rejects a foreign-workflow read or successful save as an invalid response', async () => {
    const foreign = { ...value, workflowId: 'different-workflow' }
    server.use(http.get(schedulePath(scope), () => HttpResponse.json({ schedule: foreign })),
      http.put(schedulePath(scope), () => HttpResponse.json({ value: foreign, replayed: false })))
    await expect(scheduleApi.get(scope)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(scheduleApi.save(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('rejects malformed success and an enabled disable result', async () => {
    server.use(http.put(schedulePath(scope), () => HttpResponse.json({ ok: true })),
      http.post(`${schedulePath(scope)}/disable`, () => HttpResponse.json({ value, replayed: false })))
    await expect(scheduleApi.save(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(scheduleApi.disable({ ...scope, commandId: 'disable-command', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('passes structured permission failures through the shared boundary', async () => {
    server.use(http.put(schedulePath(scope), () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied.' } }, { status: 403 })))
    await expect(scheduleApi.save(input)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})
