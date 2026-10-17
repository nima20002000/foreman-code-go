import { randomUUID } from 'node:crypto'
import {
  WorkflowBatchArchiveInputSchema,
  WorkflowBatchArchiveResultSchema,
  WorkflowReorderInputSchema,
  WorkflowReorderResultSchema,
} from '@foreman-code/contracts/management'
import { CurrentManagedWorkflowSchema } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead } from './support.js'
import { createEmptyWorkflow, workflowCollectionPath, workflowCollectionRoute } from './workflow-support.js'

export const workflowOrderScenario: Scenario = {
  id: 'http.workflows.order-batch-archive',
  title: 'Workflow reorder and batch archive preserve membership revisions and atomic failures',
  lane: 'E',
  covers: [
    httpCoverage('PUT', `${workflowCollectionRoute}/order`, 'success'),
    httpCoverage('PUT', `${workflowCollectionRoute}/order`, 'error'),
    httpCoverage('POST', `${workflowCollectionRoute}/batch-archive`, 'success'),
    httpCoverage('POST', `${workflowCollectionRoute}/batch-archive`, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Workflow ordering workspace')
    const workspaceId = workspace.created.workspace.id
    const collection = workflowCollectionPath(workspaceId)
    const first = await createEmptyWorkflow(ctx, workspaceId, 'First workflow')
    const second = await createEmptyWorkflow(ctx, workspaceId, 'Second workflow')
    await assertProtectedRead(ctx, collection, {
      items: [first.created, second.created], pageInfo: { nextCursor: null }, orderRevision: 2,
    })
    const input = WorkflowReorderInputSchema.parse({
      workspaceId, commandId: randomUUID(), expectedRevision: 2,
      workflowIds: [second.created.workflow.id, first.created.workflow.id],
    })
    const response = await ctx.http.request('PUT', `${collection}/order`, { body: input })
    WorkflowReorderResultSchema.parse(response.body)
    const order = { workspaceId, workflowIds: input.workflowIds, orderRevision: 3 }
    assertResponse(response, { status: 200, body: { value: order, replayed: false } })
    assertResponse(await ctx.http.request('PUT', `${collection}/order`, { body: input }), {
      status: 200, body: { value: order, replayed: true },
    })
    assertApiError(await ctx.http.request('PUT', `${collection}/order`, {
      body: { ...input, commandId: randomUUID() },
    }), 409, 'REVISION_CONFLICT', 'The workflow order changed. Reload the list and try again.', { currentRevision: 3 })
    const reordered = [second.created, first.created]
    await assertProtectedRead(ctx, collection, { items: reordered, pageInfo: { nextCursor: null }, orderRevision: 3 })

    const batch = WorkflowBatchArchiveInputSchema.parse({
      workspaceId, commandId: randomUUID(),
      workflows: reordered.map(item => ({ workflowId: item.workflow.id, expectedRevision: 1 })),
    })
    assertApiError(await ctx.http.request('POST', `${collection}/batch-archive`, {
      body: { ...batch, commandId: randomUUID(), workflows: [
        batch.workflows[0], { workflowId: 'workflow-missing', expectedRevision: 1 },
      ] },
    }), 404, 'WORKFLOW_NOT_FOUND', 'A selected workflow was not found. Nothing was deleted.')
    assertApiError(await ctx.http.request('POST', `${collection}/batch-archive`, {
      body: { ...batch, commandId: randomUUID(), workflows: batch.workflows.map(item => ({
        ...item, expectedRevision: 0,
      })) },
    }), 409, 'REVISION_CONFLICT', 'A selected workflow changed. Nothing was deleted. Reload the list and select again.')
    await assertProtectedRead(ctx, collection, { items: reordered, pageInfo: { nextCursor: null }, orderRevision: 3 })
    const archivedResponse = await ctx.http.request('POST', `${collection}/batch-archive`, { body: batch })
    WorkflowBatchArchiveResultSchema.parse(archivedResponse.body)
    const value = { workflowIds: [...input.workflowIds].sort() }
    assertResponse(archivedResponse, { status: 200, body: { value, replayed: false } })
    assertResponse(await ctx.http.request('POST', `${collection}/batch-archive`, { body: batch }), {
      status: 200, body: { value, replayed: true },
    })
    const archived: ReturnType<typeof CurrentManagedWorkflowSchema.parse>[] = []
    for (const item of reordered) {
      const read = await ctx.http.request('GET', `${collection}/${item.workflow.id}`)
      const record = CurrentManagedWorkflowSchema.parse(read.body)
      assertResponse(read, {
        status: 200, body: { ...item, revision: 2, archivedAt: '<timestamp>' },
      }, [{ pointer: '/body/archivedAt', kind: 'timestamp' }])
      archived.push(record)
    }
    await assertProtectedRead(ctx, collection, { items: [], pageInfo: { nextCursor: null }, orderRevision: 5 })
    await assertProtectedRead(ctx, `${collection}?includeArchived=true`, {
      items: archived, pageInfo: { nextCursor: null }, orderRevision: 5,
    })
  },
}
