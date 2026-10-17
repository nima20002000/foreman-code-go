import assert from 'node:assert/strict'
import {
  RunAcceptedInputValueSchema, RunExecutionBindingsPageSchema, RunExecutionDetailSchema,
  RunExecutionsPageSchema, RunVersionDetailSchema,
} from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { httpCoverage } from '../smoke/support.js'
import { createExecutableWorkflow } from './authoring.js'
import { workflowDigest } from './digest.js'
import { runPath, startWorkflow, waitForCompletedRun } from './runs.js'

const publicRun = '/api/management/workspaces/:workspaceId/runs/:runId'

export const ordinaryWorkflowScenarios: Scenario[] = [
  {
    id: 'workflow.ordinary-native-completion',
    title: 'An ordinary saved workflow starts Codex and retains exact inputs, result and immutable pins',
    lane: 'E', timeoutMs: 120_000,
    covers: [
      { surface: 'workflow', name: 'ordinary', case: 'success' },
      httpCoverage('POST', '/api/management/workspaces/:workspaceId/workflows/:workflowId/runs', 'success'),
      httpCoverage('GET', `${publicRun}/record`, 'success'),
      httpCoverage('GET', `${publicRun}/executions`, 'success'),
      httpCoverage('GET', `${publicRun}/executions/:executionId`, 'success'),
      httpCoverage('GET', `${publicRun}/executions/:executionId/bindings`, 'success'),
      httpCoverage('GET', `${publicRun}/version`, 'success'),
    ],
    async run(ctx) {
      const fixture = await createExecutableWorkflow(ctx, { name: 'Ordinary workflow' })
      const { run } = await startWorkflow(ctx, fixture, { message: 'Conformance ordinary input', nested: { value: 17 } })
      const result = { outcome: 'succeeded' as const, output: { text: 'answer-agent-a' } }
      const completed = await waitForCompletedRun(ctx, run, result)
      const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId,
        runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
      const runSummary = { ...scope, executionState: 'completed', outcome: 'succeeded',
        createdAt: run.createdAt, startedAt: completed.run.startedAt,
        finishedAt: completed.run.finishedAt, cleanupPending: false }
      const node = fixture.saved.version.definition.nodes[0]!
      assert.ok(node.kind !== 'job')
      const path = runPath(run)
      const listResponse = await ctx.http.request('GET', `${path}/executions`)
      const list = RunExecutionsPageSchema.parse(listResponse.body)
      assertResponse(listResponse, { status: 200, body: {
        run: runSummary,
        items: [{ workflowNodeId: node.id, executionId: '<id>', agentId: node.agentId,
          agentConfigurationVersionId: run.agentConfigurationVersionIds[node.agentId], attempt: 1,
          state: 'completed', acceptedResultAvailable: true,
          createdAt: '<timestamp>', startedAt: '<timestamp>', finishedAt: '<timestamp>' }],
        pageInfo: { nextCursor: null },
      } }, [
        { pointer: '/body/items/0/executionId', kind: 'id' },
        { pointer: '/body/items/0/createdAt', kind: 'timestamp' },
        { pointer: '/body/items/0/startedAt', kind: 'timestamp' },
        { pointer: '/body/items/0/finishedAt', kind: 'timestamp' },
      ])
      const execution = list.items[0]!
      const acceptedInput = RunAcceptedInputValueSchema.parse({
        executionSemanticsVersion: 3, runInput: run.input, occurrence: null, entry: null, predecessors: [],
      })
      const inputDigest = workflowDigest(acceptedInput)
      const detailResponse = await ctx.http.request('GET', `${path}/executions/${execution.executionId}`)
      RunExecutionDetailSchema.parse(detailResponse.body)
      assertResponse(detailResponse, { status: 200, body: {
        run: runSummary, execution,
        acceptedInput: { digest: inputDigest, value: acceptedInput },
        acceptedResult: { status: 'accepted', digest: workflowDigest(result), value: result },
        reportedResult: result,
      } })
      const bindingsResponse = await ctx.http.request('GET', `${path}/executions/${execution.executionId}/bindings`)
      RunExecutionBindingsPageSchema.parse(bindingsResponse.body)
      assertResponse(bindingsResponse, { status: 200, body: {
        scope, executionId: execution.executionId, inputDigest, items: [], pageInfo: { nextCursor: null },
      } })
      const versionResponse = await ctx.http.request('GET', `${path}/version`)
      RunVersionDetailSchema.parse(versionResponse.body)
      assertResponse(versionResponse, { status: 200, body: { scope, version: fixture.saved.version } })
      assertResponse(await ctx.http.request('GET', `/api/management/workspaces/${run.workspaceId}/runs`), {
        status: 200, body: { items: [completed.run], pageInfo: { nextCursor: null } },
      })
    },
  },
]
