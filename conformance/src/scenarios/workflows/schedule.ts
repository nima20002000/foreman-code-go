import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import {
  ScheduleDisableInputSchema, ScheduleDisableResultSchema, ScheduleGetResultSchema,
  ScheduleOccurrencePageSchema, ScheduleOccurrenceSchema, ScheduleSaveInputSchema, ScheduleSaveResultSchema,
  WorkflowScheduleSchema, scheduleOccurrenceId, type ScheduleOccurrence,
} from '@foreman-code/contracts/schedules'
import {
  CurrentRunPageSchema, GraphDigestSchema, RunAcceptedInputValueSchema, RunRecordDetailSchema, RunVersionDetailSchema,
} from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import { parseSuccessResponse } from '../../clients/response.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertProtectedRead, readCoverage } from '../http/support.js'
import { assertInvalidCallerDenied, callTool, mcpClaims, operatorClients } from '../mcp/support.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts, releaseCodexTurn } from './codexScript.js'
import { assertBindings, assertExecutionDetail, assertExecutions, runScope, waitForRunningExecution } from './inspection.js'
import { runPath, waitForCompletedRun, waitForRun } from './runs.js'
import { saveExecutableWorkflow } from './save.js'

const publicSchedule = '/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule'

async function waitForOccurrence(ctx: ScenarioContext, path: string, dueAt: string) {
  for (;;) {
    ctx.signal.throwIfAborted()
    const response = await ctx.http.request('GET', `${path}/occurrences?limit=25`)
    assert.equal(response.status, 200)
    const page = ScheduleOccurrencePageSchema.parse(response.body)
    assert.ok(page.items.length <= 1, 'Only one occurrence can become due in this controlled schedule')
    const occurrence = page.items[0]
    if (occurrence) {
      assert.equal(occurrence.dueAt, dueAt)
      assert.equal(occurrence.status, 'accepted', 'A genuine scheduler admission must create the Run')
      if (occurrence.status !== 'accepted') throw new Error('The scheduled native Run was not accepted')
      return occurrence
    }
    assertResponse(response, { status: 200, body: { items: [], pageInfo: { nextCursor: null } } })
    await setTimeout(100, undefined, { signal: ctx.signal })
  }
}

async function assertScheduledReadback(ctx: ScenarioContext, path: string, occurrence: ScheduleOccurrence,
  schedule: ReturnType<typeof WorkflowScheduleSchema.parse>) {
  const expected = { items: [occurrence], pageInfo: { nextCursor: null } }
  await assertProtectedRead(ctx, path, { schedule })
  await assertProtectedRead(ctx, `${path}/occurrences?limit=25`, expected)
  const scope = { workspaceId: schedule.workspaceId, workflowId: schedule.workflowId }
  const clients = operatorClients(ctx)
  for (const client of [clients.operator, clients.readOnly]) {
    assert.deepStrictEqual(await callTool(client, 'workflow_schedule_get', scope, ScheduleGetResultSchema), { schedule })
    assert.deepStrictEqual(await callTool(client, 'workflow_schedule_occurrences_list', { ...scope, limit: 25 },
      ScheduleOccurrencePageSchema), expected)
    await assertInvalidCallerDenied(client, 'workflow_schedule_get', scope)
    await assertInvalidCallerDenied(client, 'workflow_schedule_occurrences_list', { ...scope, limit: 25 })
  }
}

export const scheduledWorkflowScenarios: Scenario[] = [{
  id: 'workflow.schedule-latest-save-native-admission',
  title: 'The scheduler pins the latest saved graph and disabling future admission preserves its running native execution',
  lane: 'E', authentication: 'operator', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'schedule', case: 'success' },
    ...readCoverage(publicSchedule), ...readCoverage(`${publicSchedule}/occurrences`),
    httpCoverage('PUT', publicSchedule, 'success'), httpCoverage('PUT', publicSchedule, 'error'),
    httpCoverage('POST', `${publicSchedule}/disable`, 'success'), httpCoverage('POST', `${publicSchedule}/disable`, 'error'),
    ...mcpClaims('workflow_schedule_get', 'workflow_schedule_occurrences_list')],
  async run(ctx) {
    const originalPrompt = 'Conformance obsolete scheduled version'
    const prompt = 'Conformance latest saved scheduled version'
    const original = await createExecutableWorkflow(ctx, { name: 'Genuine scheduled native Run', initialPrompt: originalPrompt })
    await installCodexScripts(ctx, [
      { id: 'obsolete-schedule', includes: originalPrompt, turns: [{ failure: 'The scheduler selected an obsolete workflow version.' }] },
      { id: 'latest-schedule', includes: prompt, turns: [{ holdUntilFile: 'finish-scheduled-run', answer: 'Scheduled accepted value 73' }] },
    ])
    const { workspaceId, workflowId } = original.saved
    const path = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}/schedule`
    const dueAt = new Date(Date.now() + 10_000).toISOString()
    const body = ScheduleSaveInputSchema.omit({ workspaceId: true, workflowId: true }).parse({
      commandId: randomUUID(), expectedRevision: 0,
      schedule: { mode: 'interval', every: 1, unit: 'hour', anchorAt: dueAt,
        timezone: 'UTC', enabled: true, policy: 'latest_saved' },
    })
    const configured = WorkflowScheduleSchema.parse({ ...body.schedule, workspaceId, workflowId, revision: 1, nextOccurrenceAt: dueAt })
    const savedResponse = await ctx.http.request('PUT', path, { body })
    parseSuccessResponse(savedResponse, ScheduleSaveResultSchema, {
      method: 'PUT', path, status: 200, contract: 'ScheduleSaveResult',
    })
    assertResponse(savedResponse, { status: 200, body: { value: configured, replayed: false } })
    assertResponse(await ctx.http.request('PUT', path, { body }), { status: 200, body: { value: configured, replayed: true } })
    assertApiError(await ctx.http.request('PUT', path, { body: { ...body, commandId: randomUUID() } }),
      409, 'REVISION_CONFLICT', 'The schedule changed since it was read.', { currentRevision: 1 })
    const fixture = await saveExecutableWorkflow(ctx, original, definition => ({ ...definition,
      nodes: definition.nodes.map(node => ({ ...node, initialPrompt: prompt })),
    }))
    assert.ok(Date.parse(fixture.saved.version.createdAt) < Date.parse(dueAt), 'The new version must exist before this scheduled occurrence')
    const occurrence = await waitForOccurrence(ctx, path, dueAt)
    const expectedOccurrence = ScheduleOccurrenceSchema.parse({ id: scheduleOccurrenceId(workflowId, dueAt), workspaceId, workflowId,
      dueAt, scheduleRevision: 1, status: 'accepted', reason: null,
      runId: occurrence.runId, workflowVersionId: fixture.saved.currentVersionId })
    assert.deepStrictEqual(occurrence, expectedOccurrence)
    const firstRead = await ctx.http.request('GET', `/api/management/workspaces/${workspaceId}/runs/${occurrence.runId}/record`)
    assert.equal(firstRead.status, 200)
    const observed = RunRecordDetailSchema.parse(firstRead.body)
    const node = fixture.saved.version.definition.nodes[0]!
    await waitForRunningExecution(ctx, observed.run, node.id)
    const running = await waitForRun(ctx, observed.run, record => record.run.executionState === 'running')
    assert.ok(running.record.run.executionLocation)
    GraphDigestSchema.parse(running.record.run.executionLocation.identityHash)
    assertResponse(running.response, { status: 200, body: { run: { id: occurrence.runId, workspaceId, workflowId,
      workflowVersionId: fixture.saved.currentVersionId, executionSemanticsVersion: 3,
      agentConfigurationVersionIds: fixture.saved.version.agentConfigurationVersionIds,
      executionLocation: { ...fixture.workspace.executionLocation, locationRevision: fixture.workspace.locationRevision, identityHash: '<id>' },
      approval: fixture.saved.version.approval, executionCondition: fixture.saved.version.definition.executionCondition,
      executionState: 'running', outcome: 'pending', input: {}, createdAt: '<timestamp>', startedAt: '<timestamp>' },
    stopRequested: false, cleanupPending: false } }, [
      { pointer: '/body/run/executionLocation/identityHash', kind: 'id' },
      { pointer: '/body/run/createdAt', kind: 'timestamp' }, { pointer: '/body/run/startedAt', kind: 'timestamp' },
    ])
    const run = running.record.run
    assert.ok(Date.parse(run.createdAt) >= Date.parse(dueAt), 'The scheduler cannot create the Run before it is due')
    const advanced = WorkflowScheduleSchema.parse({ ...configured, nextOccurrenceAt: new Date(Date.parse(dueAt) + 3_600_000).toISOString() })
    await assertScheduledReadback(ctx, path, expectedOccurrence, advanced)
    const disable = ScheduleDisableInputSchema.omit({ workspaceId: true, workflowId: true }).parse({ commandId: randomUUID(), expectedRevision: 1 })
    const disabled = WorkflowScheduleSchema.parse({ ...advanced, revision: 2, enabled: false, nextOccurrenceAt: null })
    const disabledResponse = await ctx.http.request('POST', `${path}/disable`, { body: disable })
    parseSuccessResponse(disabledResponse, ScheduleDisableResultSchema, {
      method: 'POST', path: `${path}/disable`, status: 200, contract: 'ScheduleDisableResult',
    })
    assertResponse(disabledResponse, { status: 200, body: { value: disabled, replayed: false } })
    assertResponse(await ctx.http.request('POST', `${path}/disable`, { body: disable }),
      { status: 200, body: { value: disabled, replayed: true } })
    assertApiError(await ctx.http.request('POST', `${path}/disable`, { body: { ...disable, commandId: randomUUID() } }),
      409, 'REVISION_CONFLICT', 'The schedule changed since it was read.', { currentRevision: 2 })
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: running.record })
    await releaseCodexTurn(ctx, 'finish-scheduled-run')
    const result = { outcome: 'succeeded' as const, output: { text: 'Scheduled accepted value 73' } }
    const completed = await waitForCompletedRun(ctx, run, result)
    assert.equal(completed.run.startedAt, run.startedAt)
    const [execution] = await assertExecutions(ctx, fixture, completed, [{ nodeId: node.id }])
    assert.ok(execution)
    const input = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null, predecessors: [] })
    await assertExecutionDetail(ctx, completed, execution, input, result)
    await assertBindings(ctx, run, execution, input, [])
    const version = await ctx.http.request('GET', `${runPath(run)}/version`)
    RunVersionDetailSchema.parse(version.body)
    assertResponse(version, { status: 200, body: { scope: runScope(run), version: fixture.saved.version } })
    await ctx.target.restart()
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: completed })
    await assertScheduledReadback(ctx, path, expectedOccurrence, disabled)
    const list = await ctx.http.request('GET', `/api/management/workspaces/${workspaceId}/runs`)
    CurrentRunPageSchema.parse(list.body)
    assertResponse(list, { status: 200, body: { items: [completed.run], pageInfo: { nextCursor: null } } })
  },
}]
