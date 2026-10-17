import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { WorkflowArchiveInputSchema, WorkflowGetInputSchema, WorkflowUpdateInputSchema } from '@foreman-code/contracts/management'
import { OperatorWorkflowListInputSchema } from '@foreman-code/contracts/operator-mcp'
import { CurrentWorkflowCreateInputSchema, SavedManagedWorkflowCommandResultSchema } from '@foreman-code/contracts/wave25'
import type { Scenario } from '../../scenario.js'
import {
  assertInvalidCallerDenied, assertReadOnlyDenied, assertToolFailure, assertValue, callTool, mcpClaims, operatorClients,
} from './support.js'
import { createMcpWorkspace } from './workspaces.js'
import { assertMetadataWorkflowList, assertMetadataWorkflowReadback, createMetadataWorkflow } from './workflowSupport.js'

export const workflowMetadataMcpScenario: Scenario = {
  id: 'mcp.workflows.metadata-archive',
  title: 'MCP workflow metadata preserves exact records, denied mutations and receipts across restart',
  lane: 'E', authentication: 'operator',
  covers: mcpClaims('workflow_list', 'workflow_get', 'workflow_create', 'workflow_update', 'workflow_archive'),
  async run(ctx) {
    const { operator, readOnly } = operatorClients(ctx)
    const workspace = await createMcpWorkspace(operator, 'MCP workflow metadata workspace')
    const workspaceId = workspace.result.value.workspace.id
    const list = OperatorWorkflowListInputSchema.parse({ workspaceId })
    await assertInvalidCallerDenied(operator, 'workflow_list', list)
    await assertMetadataWorkflowList(ctx, workspaceId, [], 0)

    const create = CurrentWorkflowCreateInputSchema.parse({
      workspaceId, commandId: randomUUID(), name: 'MCP metadata workflow', description: 'MCP workflow description.',
      executionSemanticsVersion: 3, defaultWorktree: null,
    })
    await assertReadOnlyDenied(readOnly, 'workflow_create', create)
    await assertMetadataWorkflowList(ctx, workspaceId, [], 0)
    const created = await createMetadataWorkflow(operator, create)
    const workflowId = created.value.workflow.id
    const get = WorkflowGetInputSchema.parse({ workspaceId, workflowId })
    await assertInvalidCallerDenied(operator, 'workflow_get', get)
    await assertMetadataWorkflowReadback(ctx, created.value)
    await assertMetadataWorkflowList(ctx, workspaceId, [created.value], 1)
    assertToolFailure(await operator.callTool('workflow_create', { ...create, name: 'Conflicting workflow command' }), {
      code: 'COMMAND_ID_CONFLICT', message: 'This command ID was already used with different input.',
    })
    const missing = WorkflowGetInputSchema.parse({ workspaceId, workflowId: `missing-${workflowId}` })
    for (const client of [operator, readOnly]) {
      assertToolFailure(await client.callTool('workflow_get', missing), {
        code: 'WORKFLOW_NOT_FOUND', message: `Workflow '${missing.workflowId}' was not found.`,
      })
    }

    const update = WorkflowUpdateInputSchema.parse({ ...get, commandId: randomUUID(), expectedRevision: 1,
      name: 'MCP workflow renamed', description: null })
    await assertReadOnlyDenied(readOnly, 'workflow_update', update)
    await assertMetadataWorkflowReadback(ctx, created.value)
    const updated = await callTool(operator, 'workflow_update', update, SavedManagedWorkflowCommandResultSchema)
    const definition = { ...created.value.workflow }
    delete definition.description
    assertValue(updated, { value: { ...created.value, workflow: {
      ...definition, name: update.name, updatedAt: '<timestamp>',
    }, revision: 2 }, replayed: false }, [{ pointer: '/body/value/workflow/updatedAt', kind: 'timestamp' }])
    assertToolFailure(await operator.callTool('workflow_update', { ...update, commandId: randomUUID() }), {
      code: 'REVISION_CONFLICT', message: 'The workflow changed since it was read.', details: { currentRevision: 2 },
    })
    await ctx.target.restart()
    assert.deepStrictEqual(await callTool(operator, 'workflow_create', create, SavedManagedWorkflowCommandResultSchema),
      { ...created, replayed: true })
    assert.deepStrictEqual(await callTool(operator, 'workflow_update', update, SavedManagedWorkflowCommandResultSchema),
      { ...updated, replayed: true })
    await assertMetadataWorkflowReadback(ctx, updated.value)
    await assertMetadataWorkflowList(ctx, workspaceId, [updated.value], 1)

    const archive = WorkflowArchiveInputSchema.parse({ ...get, commandId: randomUUID(), expectedRevision: 2 })
    await assertReadOnlyDenied(readOnly, 'workflow_archive', archive)
    await assertMetadataWorkflowReadback(ctx, updated.value)
    assertToolFailure(await operator.callTool('workflow_archive', { ...archive, commandId: randomUUID(), expectedRevision: 1 }), {
      code: 'REVISION_CONFLICT', message: 'The workflow changed since it was read.', details: { currentRevision: 2 },
    })
    const archived = await callTool(operator, 'workflow_archive', archive, SavedManagedWorkflowCommandResultSchema)
    assertValue(archived, { value: { ...updated.value, revision: 3, archivedAt: '<timestamp>' }, replayed: false },
      [{ pointer: '/body/value/archivedAt', kind: 'timestamp' }])
    assertToolFailure(await operator.callTool('workflow_update', { ...update, commandId: randomUUID(), expectedRevision: 3 }), {
      code: 'WORKFLOW_ARCHIVED', message: 'Archived workflows cannot be edited.',
    })
    await ctx.target.restart()
    assert.deepStrictEqual(await callTool(operator, 'workflow_archive', archive, SavedManagedWorkflowCommandResultSchema),
      { ...archived, replayed: true })
    assert.deepStrictEqual(await callTool(operator, 'workflow_create', create, SavedManagedWorkflowCommandResultSchema),
      { ...created, replayed: true })
    assert.deepStrictEqual(await callTool(operator, 'workflow_update', update, SavedManagedWorkflowCommandResultSchema),
      { ...updated, replayed: true })
    await assertMetadataWorkflowReadback(ctx, archived.value)
    await assertMetadataWorkflowList(ctx, workspaceId, [], 2)
    await assertMetadataWorkflowList(ctx, workspaceId, [archived.value], 2, true)
  },
}
