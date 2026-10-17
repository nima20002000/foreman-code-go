import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { RunStopInputSchema, RunStopResultSchema } from '@foreman-code/contracts/management'
import { RunAcceptedInputValueSchema, type WorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { httpCoverage } from '../smoke/support.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import { assertBindings, assertExecutionDetail, assertExecutions, waitForRunningExecution } from './inspection.js'
import { runPath, startWorkflow, waitForCompletedRun, waitForRun } from './runs.js'

export async function assertActiveRun(ctx: ScenarioContext, run: WorkflowRunV3) {
  const { response, record } = await waitForRun(ctx, run, current => current.run.executionState === 'running')
  assertResponse(response, { status: 200, body: {
    run: { ...run, executionState: 'running', startedAt: '<timestamp>' },
    stopRequested: false, cleanupPending: false,
  } }, [{ pointer: '/body/run/startedAt', kind: 'timestamp' }])
  return record
}

export async function stopWorkflow(ctx: ScenarioContext, run: WorkflowRunV3) {
  const input = RunStopInputSchema.parse({ workspaceId: run.workspaceId, runId: run.id, commandId: randomUUID() })
  const path = `${runPath(run)}/stop`
  const response = await ctx.http.request('POST', path, { body: input })
  const receipt = RunStopResultSchema.parse(response.body)
  assertResponse(response, { status: 200, body: {
    runId: run.id, status: 'accepted', processStopped: false, replayed: false,
  } })
  const completed = await waitForCompletedRun(ctx, run, { outcome: 'canceled' }, { stopRequested: true })
  assertResponse(await ctx.http.request('POST', path, { body: input }), {
    status: 200, body: { ...receipt, replayed: true },
  })
  return completed
}

export const stopWorkflowScenarios: Scenario[] = [{
  id: 'workflow.stop-running-native-turn',
  title: 'Stop settles a running native turn without accepting its answer and permits a distinct explicit Start',
  lane: 'E', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'stop', case: 'success' },
    httpCoverage('POST', '/api/management/workspaces/:workspaceId/runs/:runId/stop', 'success')],
  async run(ctx) {
    const prompt = 'Conformance held turn for Stop'
    const fixture = await createExecutableWorkflow(ctx, { name: 'Stop controlled native work', initialPrompt: prompt })
    await installCodexScripts(ctx, [{ id: 'stop-native-turn', includes: prompt, turns: [
      { holdUntilFile: 'unreleased-native-turn', answer: 'This result must never be accepted' },
      { answer: 'New Run after Stop' },
    ] }])
    const { run } = await startWorkflow(ctx, fixture, { task: 'Stop this exact Run' })
    const nodeId = fixture.saved.version.definition.nodes[0]!.id
    const running = await waitForRunningExecution(ctx, run, nodeId)
    const active = await assertActiveRun(ctx, run)
    const executions = await assertExecutions(ctx, fixture, active, [{ nodeId, state: 'running', accepted: false }])
    assert.equal(executions[0]!.executionId, running.executionId)
    const input = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [],
    })
    await assertExecutionDetail(ctx, active, executions[0]!, input, undefined, false)
    const stopped = await stopWorkflow(ctx, run)
    const canceled = await assertExecutions(ctx, fixture, stopped, [{ nodeId, accepted: false }])
    assert.equal(canceled[0]!.executionId, running.executionId)
    await assertExecutionDetail(ctx, stopped, canceled[0]!, input, { outcome: 'canceled' }, false)
    await assertBindings(ctx, run, canceled[0]!, input, [])
    const next = await startWorkflow(ctx, fixture, { task: 'Begin separately after confirmed Stop' })
    assert.notEqual(next.run.id, run.id)
    await waitForCompletedRun(ctx, next.run, { outcome: 'succeeded', output: { text: 'New Run after Stop' } })
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: stopped })
  },
}]
