import { randomUUID } from 'node:crypto'
import {
  ScheduleDisableInputSchema,
  ScheduleSaveInputSchema,
  ScheduleSaveResultSchema,
  WorkflowScheduleSchema,
  type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'
import { createEmptyWorkflow, workflowCollectionPath, workflowRoute } from './workflow-support.js'

const scheduleRoute = `${workflowRoute}/schedule`
const SaveBodySchema = ScheduleSaveInputSchema.omit({ workspaceId: true, workflowId: true })
const CommandBodySchema = ScheduleDisableInputSchema.omit({ workspaceId: true, workflowId: true })

async function changeEnabled(
  ctx: ScenarioContext,
  path: string,
  action: 'enable' | 'disable',
  previous: WorkflowSchedule,
  expected: WorkflowSchedule,
) {
  const body = CommandBodySchema.parse({ commandId: randomUUID(), expectedRevision: previous.revision })
  const response = await ctx.http.request('POST', `${path}/${action}`, { body })
  ScheduleSaveResultSchema.parse(response.body)
  assertResponse(response, { status: 200, body: { value: expected, replayed: false } })
  assertResponse(await ctx.http.request('POST', `${path}/${action}`, { body }), {
    status: 200, body: { value: expected, replayed: true },
  })
  assertApiError(await ctx.http.request('POST', `${path}/${action}`, {
    body: { ...body, commandId: randomUUID() },
  }), 409, 'REVISION_CONFLICT', 'The schedule changed since it was read.', { currentRevision: expected.revision })
  await assertProtectedRead(ctx, path, { schedule: expected })
}

export const workflowScheduleScenario: Scenario = {
  id: 'http.workflows.schedule-lifecycle',
  title: 'Schedule save, enable, disable, clear, and recreate preserve revisions and durable readback',
  lane: 'E',
  covers: [
    ...readCoverage(scheduleRoute),
    ...readCoverage(`${scheduleRoute}/occurrences`),
    httpCoverage('PUT', scheduleRoute, 'success'),
    httpCoverage('PUT', scheduleRoute, 'error'),
    ...['enable', 'disable', 'clear'].flatMap(action => [
      httpCoverage('POST', `${scheduleRoute}/${action}`, 'success'),
      httpCoverage('POST', `${scheduleRoute}/${action}`, 'error'),
    ]),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Schedule lifecycle workspace')
    const workspaceId = workspace.created.workspace.id
    const workflow = await createEmptyWorkflow(ctx, workspaceId, 'Scheduled workflow metadata')
    const workflowId = workflow.created.workflow.id
    const path = `${workflowCollectionPath(workspaceId)}/${workflowId}/schedule`
    await assertProtectedRead(ctx, path, { schedule: null })
    await assertProtectedRead(ctx, `${path}/occurrences?limit=1`, { items: [], pageInfo: { nextCursor: null } })
    for (const action of ['enable', 'disable', 'clear']) {
      const body = CommandBodySchema.parse({ commandId: randomUUID(), expectedRevision: 0 })
      assertApiError(await ctx.http.request('POST', `${path}/${action}`, { body }),
        404, 'SCHEDULE_NOT_FOUND', 'This workflow has no saved schedule.')
    }

    const anchorAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString()
    const input = SaveBodySchema.parse({
      commandId: randomUUID(), expectedRevision: 0,
      schedule: { mode: 'interval', timezone: 'UTC', enabled: false, policy: 'latest_saved',
        every: 1, unit: 'hour', anchorAt },
    })
    const saved = WorkflowScheduleSchema.parse({
      ...input.schedule, workspaceId, workflowId, revision: 1, nextOccurrenceAt: null,
    })
    const response = await ctx.http.request('PUT', path, { body: input })
    ScheduleSaveResultSchema.parse(response.body)
    assertResponse(response, { status: 200, body: { value: saved, replayed: false } })
    assertResponse(await ctx.http.request('PUT', path, { body: input }), {
      status: 200, body: { value: saved, replayed: true },
    })
    assertApiError(await ctx.http.request('PUT', path, {
      body: { ...input, commandId: randomUUID() },
    }), 409, 'REVISION_CONFLICT', 'The schedule changed since it was read.', { currentRevision: 1 })
    await assertProtectedRead(ctx, path, { schedule: saved })

    const enabled = WorkflowScheduleSchema.parse({ ...saved, enabled: true, revision: 2, nextOccurrenceAt: anchorAt })
    await changeEnabled(ctx, path, 'enable', saved, enabled)
    const disabled = WorkflowScheduleSchema.parse({ ...enabled, enabled: false, revision: 3, nextOccurrenceAt: null })
    await changeEnabled(ctx, path, 'disable', enabled, disabled)
    const clear = CommandBodySchema.parse({ commandId: randomUUID(), expectedRevision: 3 })
    assertResponse(await ctx.http.request('POST', `${path}/clear`, { body: clear }), {
      status: 200, body: { value: null, replayed: false },
    })
    assertResponse(await ctx.http.request('POST', `${path}/clear`, { body: clear }), {
      status: 200, body: { value: null, replayed: true },
    })
    await assertProtectedRead(ctx, path, { schedule: null })
    await ctx.target.restart()
    await assertProtectedRead(ctx, path, { schedule: null })

    const recreated = WorkflowScheduleSchema.parse({ ...saved, revision: 5 })
    const recreate = SaveBodySchema.parse({ ...input, commandId: randomUUID() })
    assertResponse(await ctx.http.request('PUT', path, { body: recreate }), {
      status: 200, body: { value: recreated, replayed: false },
    })
    await assertProtectedRead(ctx, path, { schedule: recreated })
    await assertProtectedRead(ctx, `${path}/occurrences`, { items: [], pageInfo: { nextCursor: null } })
  },
}
