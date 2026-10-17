import assert from 'node:assert/strict'
import { WorkflowGetInputSchema } from '@foreman-code/contracts/management'
import { OperatorWorkflowListInputSchema, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowCreateInputSchema, SavedManagedWorkflowCommandResultSchema,
  SavedManagedWorkflowPageSchema, SavedManagedWorkflowSchema,
  type CurrentWorkflowCreateInput, type SavedManagedWorkflow,
} from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { McpClient } from '../../clients/mcp.js'
import type { ScenarioContext } from '../../scenario.js'
import { assertValue, callTool, operatorClients } from './support.js'

/** Explicitly opt out of worktree creation; this scenario authors metadata only. */
export async function createMetadataWorkflow(client: McpClient, raw: CurrentWorkflowCreateInput) {
  const input = CurrentWorkflowCreateInputSchema.parse(raw)
  const result = await callTool(client, 'workflow_create', input, SavedManagedWorkflowCommandResultSchema)
  assertValue(result, { value: {
    workflow: {
      id: '<id>', workspaceId: input.workspaceId, name: input.name, description: input.description,
      approval: { handler: 'orchestrator' }, executionSemanticsVersion: 3, entryNodeId: null,
      handoffs: { contractVersion: 1 }, executionCondition: { kind: 'manual' }, nodes: [], edges: [],
      createdAt: '<timestamp>', updatedAt: '<timestamp>',
    },
    revision: 1, currentVersionId: null, archivedAt: null,
  }, replayed: false }, [
    { pointer: '/body/value/workflow/id', kind: 'id' },
    { pointer: '/body/value/workflow/createdAt', kind: 'timestamp' },
    { pointer: '/body/value/workflow/updatedAt', kind: 'timestamp' },
  ])
  assert.equal(result.value.workflow.createdAt, result.value.workflow.updatedAt)
  assert.match(result.value.workflow.id, /^workflow-[0-9a-f-]{36}$/)
  return result
}

export async function assertMetadataWorkflowReadback(ctx: ScenarioContext, expected: SavedManagedWorkflow) {
  const input = WorkflowGetInputSchema.parse({ workspaceId: expected.workflow.workspaceId, workflowId: expected.workflow.id })
  const { operator, readOnly } = operatorClients(ctx)
  for (const client of [operator, readOnly]) {
    assert.deepStrictEqual(await callTool(client, 'workflow_get', input, SavedManagedWorkflowSchema), expected)
  }
  assertResponse(await ctx.http.request('GET', `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}`),
    { status: 200, body: expected })
}

export async function assertMetadataWorkflowList(ctx: ScenarioContext, workspaceId: string,
  items: SavedManagedWorkflow[], orderRevision: number, includeArchived = false) {
  const input = OperatorWorkflowListInputSchema.parse({ workspaceId, includeArchived })
  const expected = { items, pageInfo: { nextCursor: null }, orderRevision }
  const { operator, readOnly } = operatorClients(ctx)
  for (const client of [operator, readOnly]) {
    assert.deepStrictEqual(await callTool(client, 'workflow_list', { ...input, detail: 'full' },
      SavedManagedWorkflowPageSchema), expected)
    assert.deepStrictEqual(await callTool(client, 'workflow_list', input, WorkflowSummaryPageSchema), {
      detail: 'compact', items: items.map(({ workflow, ...item }) => ({ ...item,
        workflow: { id: workflow.id, workspaceId: workflow.workspaceId, name: workflow.name }, detailsOmitted: true,
      })), pageInfo: { nextCursor: null }, orderRevision,
    })
  }
  const path = `/api/management/workspaces/${workspaceId}/workflows?includeArchived=${includeArchived}`
  assertResponse(await ctx.http.request('GET', path), { status: 200, body: expected })
}
