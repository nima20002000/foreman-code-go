import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CurrentManagedWorkflowCommandResultSchema,
  CurrentWorkflowCreateInputSchema,
} from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'

export const workflowCollectionRoute = '/api/management/workspaces/:workspaceId/workflows'
export const workflowRoute = `${workflowCollectionRoute}/:workflowId`

export function workflowCollectionPath(workspaceId: string): string {
  return `/api/management/workspaces/${workspaceId}/workflows`
}

/** Metadata authoring accepts a current, incomplete definition without a harness or filesystem grant. */
export async function createEmptyWorkflow(ctx: ScenarioContext, workspaceId: string, name: string) {
  const input = CurrentWorkflowCreateInputSchema.parse({
    workspaceId, commandId: randomUUID(), name, description: 'Conformance workflow metadata.',
    executionSemanticsVersion: 3, defaultWorktree: null,
  })
  const response = await ctx.http.request('POST', workflowCollectionPath(workspaceId), { body: input })
  const created = CurrentManagedWorkflowCommandResultSchema.parse(response.body).value
  assertResponse(response, {
    status: 201,
    body: {
      value: {
        workflow: {
          id: '<id>', workspaceId, name, description: input.description,
          approval: { handler: 'orchestrator' }, executionSemanticsVersion: 3, entryNodeId: null,
          handoffs: { contractVersion: 1 }, executionCondition: { kind: 'manual' }, nodes: [], edges: [],
          createdAt: '<timestamp>', updatedAt: '<timestamp>',
        },
        revision: 1, currentVersionId: null, archivedAt: null,
      },
      replayed: false,
    },
  }, [
    { pointer: '/body/value/workflow/id', kind: 'id' },
    { pointer: '/body/value/workflow/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/workflow/updatedAt', kind: 'timestamp' },
  ])
  assert.equal(created.workflow.createdAt, created.workflow.updatedAt)
  return { input, created }
}
