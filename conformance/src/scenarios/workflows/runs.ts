import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import {
  GraphDigestSchema, ManualRunStartInputSchema, ManualRunStartResultSchema,
  RunRecordDetailSchema, type RunRecordDetail, type WorkflowRunV3,
} from '@foreman-code/contracts/wave25'
import type { ExecutionResult } from '@foreman-code/contracts'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import type { ExecutableWorkflow } from './authoring.js'

export async function startWorkflow(ctx: ScenarioContext, fixture: ExecutableWorkflow, runInput: Record<string, unknown> = {}) {
  const { saved, workspace } = fixture
  const input = ManualRunStartInputSchema.parse({
    workspaceId: saved.workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.currentVersionId,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: workspace.locationRevision, input: runInput,
  })
  const path = `/api/management/workspaces/${saved.workspaceId}/workflows/${saved.workflowId}/runs`
  const response = await ctx.http.request('POST', path, { body: input })
  const { run } = ManualRunStartResultSchema.parse(response.body)
  assert.ok(run.executionLocation)
  GraphDigestSchema.parse(run.executionLocation.identityHash)
  assertResponse(response, { status: 202, body: { run: {
    id: '<id>', workspaceId: saved.workspaceId, workflowId: saved.workflowId,
    workflowVersionId: saved.currentVersionId, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    executionLocation: { ...workspace.executionLocation, locationRevision: workspace.locationRevision, identityHash: '<id>' },
    approval: saved.version.approval, executionCondition: saved.version.definition.executionCondition,
    executionState: 'queued', outcome: 'pending', input: input.input, createdAt: '<timestamp>',
  }, accepted: true, replayed: false } }, [
    { pointer: '/body/run/id', kind: 'id' },
    { pointer: '/body/run/executionLocation/identityHash', kind: 'id' },
    { pointer: '/body/run/createdAt', kind: 'timestamp' },
  ])
  const replay = await ctx.http.request('POST', path, { body: input })
  assertResponse(replay, { status: 202, body: { run, accepted: true, replayed: true } })
  return { input, run, path }
}

export function runPath(run: WorkflowRunV3) {
  return `/api/management/workspaces/${run.workspaceId}/runs/${run.id}`
}

export async function waitForRun(
  ctx: ScenarioContext,
  run: WorkflowRunV3,
  ready: (record: RunRecordDetail) => boolean,
) {
  for (;;) {
    ctx.signal.throwIfAborted()
    const response = await ctx.http.request('GET', `${runPath(run)}/record`)
    assert.equal(response.status, 200, 'The public Run record must remain readable during execution')
    const record = RunRecordDetailSchema.parse(response.body)
    assert.equal(record.run.id, run.id)
    assert.equal(record.run.workflowVersionId, run.workflowVersionId)
    assert.deepStrictEqual(record.run.agentConfigurationVersionIds, run.agentConfigurationVersionIds)
    assert.deepStrictEqual(record.run.input, run.input)
    if (ready(record)) return { response, record }
    assert.notEqual(record.run.executionState, 'completed', 'The Run ended before the required public lifecycle state')
    await setTimeout(50, undefined, { signal: ctx.signal })
  }
}

export async function waitForCompletedRun(ctx: ScenarioContext, run: WorkflowRunV3, result: ExecutionResult) {
  for (;;) {
    const { response, record } = await waitForRun(ctx, run,
      current => current.run.executionState === 'completed')
    if (!record.cleanupPending) {
      assertResponse(response, { status: 200, body: {
        run: { ...run, executionState: 'completed', outcome: result.outcome, result,
          startedAt: '<timestamp>', finishedAt: '<timestamp>' },
        stopRequested: false, cleanupPending: false,
      } }, [
        { pointer: '/body/run/startedAt', kind: 'timestamp' },
        { pointer: '/body/run/finishedAt', kind: 'timestamp' },
      ])
      return record
    }
    await setTimeout(50, undefined, { signal: ctx.signal })
  }
}
