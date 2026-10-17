import { randomUUID } from 'node:crypto'
import { WorkflowArchiveInputSchema, WorkflowUpdateInputSchema } from '@foreman-code/contracts/management'
import { CurrentManagedWorkflowCommandResultSchema } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { assertProtectedRead, readCoverage } from './support.js'
import {
  createEmptyWorkflow, workflowCollectionPath, workflowCollectionRoute, workflowRoute,
} from './workflow-support.js'

export const workflowMetadataScenario: Scenario = {
  id: 'http.workflows.metadata-archive',
  title: 'Current workflow metadata, command replay, and archive retain exact public records',
  lane: 'E',
  covers: [
    ...readCoverage(workflowCollectionRoute),
    ...readCoverage(workflowRoute),
    httpCoverage('POST', workflowCollectionRoute, 'success'),
    httpCoverage('POST', workflowCollectionRoute, 'error'),
    httpCoverage('PATCH', workflowRoute, 'success'),
    httpCoverage('PATCH', workflowRoute, 'error'),
    httpCoverage('DELETE', workflowRoute, 'success'),
    httpCoverage('DELETE', workflowRoute, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Workflow metadata workspace')
    const workspaceId = workspace.created.workspace.id
    const collection = workflowCollectionPath(workspaceId)
    await assertProtectedRead(ctx, collection, { items: [], pageInfo: { nextCursor: null }, orderRevision: 0 })
    const { input, created } = await createEmptyWorkflow(ctx, workspaceId, 'Metadata workflow')
    const path = `${collection}/${created.workflow.id}`
    await assertProtectedRead(ctx, path, created)
    assertResponse(await ctx.http.request('POST', collection, { body: input }), {
      status: 200, body: { value: created, replayed: true },
    })
    assertApiError(await ctx.http.request('POST', collection, {
      body: { ...input, name: 'Conflicting workflow command' },
    }), 409, 'COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')

    const update = WorkflowUpdateInputSchema.parse({
      workspaceId, workflowId: created.workflow.id, commandId: randomUUID(), expectedRevision: 1,
      name: 'Renamed workflow', description: null,
    })
    const response = await ctx.http.request('PATCH', path, { body: update })
    const updated = CurrentManagedWorkflowCommandResultSchema.parse(response.body).value
    const definition = { ...created.workflow }
    delete definition.description
    assertResponse(response, {
      status: 200,
      body: { value: { ...created, workflow: {
        ...definition, name: update.name, updatedAt: '<timestamp>',
      }, revision: 2 }, replayed: false },
    }, [{ pointer: '/body/value/workflow/updatedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('PATCH', path, { body: update }), {
      status: 200, body: { value: updated, replayed: true },
    })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...update, commandId: randomUUID() },
    }), 409, 'REVISION_CONFLICT', 'The workflow changed since it was read.', { currentRevision: 2 })
    await assertProtectedRead(ctx, path, updated)
    await assertProtectedRead(ctx, collection, { items: [updated], pageInfo: { nextCursor: null }, orderRevision: 1 })

    const archive = WorkflowArchiveInputSchema.parse({
      workspaceId, workflowId: created.workflow.id, commandId: randomUUID(), expectedRevision: 2,
    })
    assertApiError(await ctx.http.request('DELETE', path, {
      body: { ...archive, commandId: randomUUID(), expectedRevision: 1 },
    }), 409, 'REVISION_CONFLICT', 'The workflow changed since it was read.', { currentRevision: 2 })
    const archivedResponse = await ctx.http.request('DELETE', path, { body: archive })
    const archived = CurrentManagedWorkflowCommandResultSchema.parse(archivedResponse.body).value
    assertResponse(archivedResponse, {
      status: 200, body: { value: { ...updated, revision: 3, archivedAt: '<timestamp>' }, replayed: false },
    }, [{ pointer: '/body/value/archivedAt', kind: 'timestamp' }])
    assertResponse(await ctx.http.request('DELETE', path, { body: archive }), {
      status: 200, body: { value: archived, replayed: true },
    })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...update, commandId: randomUUID(), expectedRevision: 3 },
    }), 409, 'WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.')
    await assertProtectedRead(ctx, path, archived)
    await assertProtectedRead(ctx, collection, { items: [], pageInfo: { nextCursor: null }, orderRevision: 2 })
    await assertProtectedRead(ctx, `${collection}?includeArchived=true`, {
      items: [archived], pageInfo: { nextCursor: null }, orderRevision: 2,
    })
  },
}
