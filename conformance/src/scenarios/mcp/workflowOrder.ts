import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  WorkflowBatchArchiveInputSchema, WorkflowBatchArchiveResultSchema,
  WorkflowGetInputSchema, WorkflowReorderInputSchema, WorkflowReorderResultSchema,
} from '@foreman-code/contracts/management'
import { CurrentWorkflowCreateInputSchema, SavedManagedWorkflowSchema, type SavedManagedWorkflow } from '@foreman-code/contracts/wave25'
import type { Scenario } from '../../scenario.js'
import { assertReadOnlyDenied, assertToolFailure, assertValue, callTool, mcpClaims, operatorClients } from './support.js'
import { createMcpWorkspace } from './workspaces.js'
import { assertMetadataWorkflowList, assertMetadataWorkflowReadback, createMetadataWorkflow } from './workflowSupport.js'

export const workflowOrderMcpScenario: Scenario = {
  id: 'mcp.workflows.order-batch-archive',
  title: 'MCP partial reorder and batch archive preserve omitted workflows and atomic failures across restart',
  lane: 'E', authentication: 'operator', timeoutMs: 120_000,
  covers: mcpClaims('workflow_reorder', 'workflow_batch_archive'),
  async run(ctx) {
    const { operator, readOnly } = operatorClients(ctx)
    const workspace = await createMcpWorkspace(operator, 'MCP ordered workflow workspace')
    const workspaceId = workspace.result.value.workspace.id
    const originals: SavedManagedWorkflow[] = []
    for (const name of ['First selected workflow', 'Omitted middle workflow', 'Last selected workflow']) {
      const input = CurrentWorkflowCreateInputSchema.parse({ workspaceId, commandId: randomUUID(), name,
        description: 'MCP workflow ordering metadata.', executionSemanticsVersion: 3, defaultWorktree: null })
      originals.push((await createMetadataWorkflow(operator, input)).value)
    }
    const [first, omitted, last] = originals
    assert.ok(first && omitted && last)
    await assertMetadataWorkflowList(ctx, workspaceId, originals, 3)
    const reorder = WorkflowReorderInputSchema.parse({ workspaceId, commandId: randomUUID(), expectedRevision: 3,
      workflowIds: [last.workflow.id, first.workflow.id] })
    await assertReadOnlyDenied(readOnly, 'workflow_reorder', reorder)
    await assertMetadataWorkflowList(ctx, workspaceId, originals, 3)
    const ordered = await callTool(operator, 'workflow_reorder', reorder, WorkflowReorderResultSchema)
    assertValue(ordered, { value: { workspaceId, workflowIds: reorder.workflowIds, orderRevision: 4 }, replayed: false })
    const reordered = [last, omitted, first]
    await assertMetadataWorkflowList(ctx, workspaceId, reordered, 4)
    assertToolFailure(await operator.callTool('workflow_reorder', { ...reorder, commandId: randomUUID() }), {
      code: 'REVISION_CONFLICT', message: 'The workflow order changed. Reload the list and try again.',
      details: { currentRevision: 4 },
    })
    assertToolFailure(await operator.callTool('workflow_reorder', { ...reorder, workflowIds: [...reorder.workflowIds].reverse() }), {
      code: 'COMMAND_ID_CONFLICT', message: 'This command ID was already used with different input.',
    })
    const missingReorder = WorkflowReorderInputSchema.parse({ ...reorder, commandId: randomUUID(), expectedRevision: 4,
      workflowIds: [last.workflow.id, `missing-${first.workflow.id}`] })
    assertToolFailure(await operator.callTool('workflow_reorder', missingReorder), {
      code: 'WORKFLOW_NOT_FOUND', message: 'A selected workflow was not found in this workspace.',
    })
    await ctx.target.restart()
    assert.deepStrictEqual(await callTool(operator, 'workflow_reorder', reorder, WorkflowReorderResultSchema),
      { ...ordered, replayed: true })
    await assertMetadataWorkflowList(ctx, workspaceId, reordered, 4)
    for (const item of originals) await assertMetadataWorkflowReadback(ctx, item)

    const archive = WorkflowBatchArchiveInputSchema.parse({ workspaceId, commandId: randomUUID(),
      workflows: [last, first].map(item => ({ workflowId: item.workflow.id, expectedRevision: 1 })) })
    await assertReadOnlyDenied(readOnly, 'workflow_batch_archive', archive)
    await assertMetadataWorkflowList(ctx, workspaceId, reordered, 4)
    const missingArchive = WorkflowBatchArchiveInputSchema.parse({ ...archive, commandId: randomUUID(), workflows: [
      { workflowId: last.workflow.id, expectedRevision: 1 }, { workflowId: `missing-${first.workflow.id}`, expectedRevision: 1 },
    ] })
    assertToolFailure(await operator.callTool('workflow_batch_archive', missingArchive), {
      code: 'WORKFLOW_NOT_FOUND', message: 'A selected workflow was not found. Nothing was deleted.',
    })
    await assertMetadataWorkflowList(ctx, workspaceId, reordered, 4)
    const staleArchive = WorkflowBatchArchiveInputSchema.parse({ ...archive, commandId: randomUUID(), workflows: [
      { workflowId: last.workflow.id, expectedRevision: 1 }, { workflowId: first.workflow.id, expectedRevision: 0 },
    ] })
    assertToolFailure(await operator.callTool('workflow_batch_archive', staleArchive), {
      code: 'REVISION_CONFLICT', message: 'A selected workflow changed. Nothing was deleted. Reload the list and select again.',
    })
    await assertMetadataWorkflowList(ctx, workspaceId, reordered, 4)
    const archived = await callTool(operator, 'workflow_batch_archive', archive, WorkflowBatchArchiveResultSchema)
    assertValue(archived, { value: { workflowIds: [...reorder.workflowIds].sort() }, replayed: false })
    const archivedRecords: SavedManagedWorkflow[] = []
    for (const item of [last, first]) {
      const input = WorkflowGetInputSchema.parse({ workspaceId, workflowId: item.workflow.id })
      const actual = await callTool(operator, 'workflow_get', input, SavedManagedWorkflowSchema)
      assertValue(actual, { ...item, revision: 2, archivedAt: '<timestamp>' }, [{ pointer: '/body/archivedAt', kind: 'timestamp' }])
      archivedRecords.push(actual)
    }
    const [archivedLast, archivedFirst] = archivedRecords
    assert.ok(archivedLast && archivedFirst)
    const retained = [archivedLast, omitted, archivedFirst]
    const archivedReorder = WorkflowReorderInputSchema.parse({ ...reorder, commandId: randomUUID(), expectedRevision: 6 })
    assertToolFailure(await operator.callTool('workflow_reorder', archivedReorder), {
      code: 'WORKFLOW_ARCHIVED', message: 'Archived workflows cannot be reordered.',
    })
    await ctx.target.restart()
    assert.deepStrictEqual(await callTool(operator, 'workflow_batch_archive', archive, WorkflowBatchArchiveResultSchema),
      { ...archived, replayed: true })
    assert.deepStrictEqual(await callTool(operator, 'workflow_reorder', reorder, WorkflowReorderResultSchema),
      { ...ordered, replayed: true })
    await assertMetadataWorkflowList(ctx, workspaceId, [omitted], 6)
    await assertMetadataWorkflowList(ctx, workspaceId, retained, 6, true)
    for (const item of retained) await assertMetadataWorkflowReadback(ctx, item)
  },
}
