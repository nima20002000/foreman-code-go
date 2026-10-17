import assert from 'node:assert/strict'
import {
  RUN_INSPECTION_TOOLS, RunRecordGetInputSchema, RunRecordDetailSchema,
  RunExecutionsListInputSchema, RunExecutionsPageSchema,
  RunExecutionGetInputSchema, RunExecutionDetailSchema,
  RunExecutionBindingsListInputSchema, RunExecutionBindingsPageSchema,
  RunVersionGetInputSchema, RunVersionDetailSchema,
  type RunRecordDetail, type RunExecutionsPage, type RunExecutionDetail,
  type RunExecutionBindingsPage, type RunVersionDetail, type RunInspectionToolName,
} from '@foreman-code/contracts/wave25'
import type { McpClient } from '../../clients/mcp.js'
import type { ScenarioContext } from '../../scenario.js'
import { assertProtectedRead } from '../http/support.js'
import { runPath } from '../workflows/runs.js'
import { assertInvalidCallerDenied, assertToolFailure, callTool, mcpClaims, operatorClients, type Contract } from './support.js'

export const runInspectionMcpClaims = mcpClaims(...Object.values(RUN_INSPECTION_TOOLS))

export interface RunInspectionReadback {
  record: RunRecordDetail
  executions: RunExecutionsPage
  execution: RunExecutionDetail
  bindings: RunExecutionBindingsPage
  version: RunVersionDetail
}

async function assertInspectionTool<T>(client: McpClient, name: RunInspectionToolName, input: Record<string, unknown>,
  schema: Contract<T>, expected: T) {
  assert.deepStrictEqual(await callTool(client, name, input, schema), expected)
  await assertInvalidCallerDenied(client, name, input)
}

/** These snapshots were independently asserted against the saved fixture and native result. */
export async function assertRunInspectionReadbacks(ctx: ScenarioContext, expected: RunInspectionReadback) {
  const { run } = expected.record
  const path = runPath(run)
  const executionId = expected.execution.execution.executionId
  for (const read of [
    { path: `${path}/record`, body: expected.record },
    { path: `${path}/executions`, body: expected.executions },
    { path: `${path}/executions/${executionId}`, body: expected.execution },
    { path: `${path}/executions/${executionId}/bindings`, body: expected.bindings },
    { path: `${path}/version`, body: expected.version },
  ]) await assertProtectedRead(ctx, read.path, read.body)

  const scope = RunRecordGetInputSchema.parse({ workspaceId: run.workspaceId, runId: run.id })
  const executions = RunExecutionsListInputSchema.parse({ ...scope, limit: 1,
    workflowNodeId: expected.execution.execution.workflowNodeId })
  const execution = RunExecutionGetInputSchema.parse({ ...scope, executionId })
  const bindings = RunExecutionBindingsListInputSchema.parse({ ...execution, limit: 1 })
  const version = RunVersionGetInputSchema.parse(scope)
  const { operator, readOnly } = operatorClients(ctx)
  for (const client of [operator, readOnly]) {
    await assertInspectionTool(client, RUN_INSPECTION_TOOLS.record, scope, RunRecordDetailSchema, expected.record)
    await assertInspectionTool(client, RUN_INSPECTION_TOOLS.executions, executions, RunExecutionsPageSchema, expected.executions)
    await assertInspectionTool(client, RUN_INSPECTION_TOOLS.execution, execution, RunExecutionDetailSchema, expected.execution)
    await assertInspectionTool(client, RUN_INSPECTION_TOOLS.bindings, bindings, RunExecutionBindingsPageSchema, expected.bindings)
    await assertInspectionTool(client, RUN_INSPECTION_TOOLS.version, version, RunVersionDetailSchema, expected.version)

    const wrongWorkspace = RunRecordGetInputSchema.parse({ ...scope, workspaceId: `missing-${run.workspaceId}` })
    for (const name of [RUN_INSPECTION_TOOLS.record, RUN_INSPECTION_TOOLS.version]) {
      assertToolFailure(await client.callTool(name, wrongWorkspace), {
        code: 'RUN_NOT_FOUND', message: 'The Run was not found in this workspace.',
      })
    }
    const wrongNode = RunExecutionsListInputSchema.parse({ ...executions,
      workflowNodeId: `missing-${expected.execution.execution.workflowNodeId}` })
    assertToolFailure(await client.callTool(RUN_INSPECTION_TOOLS.executions, wrongNode), {
      code: 'WORKFLOW_NODE_NOT_FOUND', message: 'The node is not in this Run\'s pinned version.',
    })
    const wrongExecution = RunExecutionGetInputSchema.parse({ ...execution, executionId: `missing-${executionId}` })
    assertToolFailure(await client.callTool(RUN_INSPECTION_TOOLS.execution, wrongExecution), {
      code: 'RUN_EXECUTION_NOT_FOUND', message: 'The execution was not found in this Run.',
    })
    const wrongBindings = RunExecutionBindingsListInputSchema.parse({ ...bindings, executionId: wrongExecution.executionId })
    assertToolFailure(await client.callTool(RUN_INSPECTION_TOOLS.bindings, wrongBindings), {
      code: 'RUN_EXECUTION_NOT_FOUND', message: 'The execution was not found in this Run.',
    })
  }
}
