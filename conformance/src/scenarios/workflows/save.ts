import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema, WorkflowDefinitionV3Schema,
  type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import { parseSuccessResponse } from '../../clients/response.js'
import type { ScenarioContext } from '../../scenario.js'
import type { ExecutableWorkflow } from './authoring.js'
import { workflowDigest } from './digest.js'

/** Publish through the public Save contract; the returned fixture follows the accepted immutable version. */
export async function saveExecutableWorkflow(ctx: ScenarioContext, fixture: ExecutableWorkflow,
  configure: (definition: WorkflowDefinitionV3) => WorkflowDefinitionV3): Promise<ExecutableWorkflow> {
  const first = fixture.saved.version
  const graph = WorkflowDefinitionV3Schema.parse(configure(first.definition))
  const input = CurrentWorkflowSaveInputSchema.parse({ workspaceId: first.workspaceId, workflowId: first.workflowId,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: fixture.saved.revision,
    expectedWorkflowVersionId: first.id, expectedAgentConfigurationVersionIds: first.agentConfigurationVersionIds, graph,
  })
  const response = await ctx.http.request('PUT', fixture.definitionPath, { body: input })
  const saved = parseSuccessResponse(response, CurrentWorkflowSaveResultSchema, {
    method: 'PUT', path: fixture.definitionPath, status: 200, contract: 'CurrentWorkflowSaveResult',
  }).value
  const definition = { ...graph, version: first.version + 1, updatedAt: saved.version.createdAt }
  const contentHash = workflowDigest({ definition, configurations: first.agentConfigurationVersionIds,
    entryNodeId: definition.entryNodeId })
  assertResponse(response, { status: 200, body: { value: { workspaceId: first.workspaceId, workflowId: first.workflowId,
    revision: fixture.saved.revision + 1, currentVersionId: saved.version.id,
    version: { ...first, id: '<id>', version: first.version + 1, definition, entryNodeId: definition.entryNodeId,
      approval: definition.approval, contentHash, createdAt: '<timestamp>' },
  }, replayed: false } }, [{ pointer: '/body/value/version/id', kind: 'id' },
    { pointer: '/body/value/version/createdAt', kind: 'timestamp' }])
  assert.notEqual(saved.currentVersionId, first.id)
  assert.notEqual(saved.version.contentHash, first.contentHash)
  assertResponse(await ctx.http.request('PUT', fixture.definitionPath, { body: input }),
    { status: 200, body: { value: saved, replayed: true } })
  assertResponse(await ctx.http.request('GET', fixture.definitionPath), { status: 200, body: saved })
  return { ...fixture, saved, workflow: { ...fixture.workflow, workflow: saved.version.definition,
    revision: saved.revision, currentVersionId: saved.currentVersionId } }
}
