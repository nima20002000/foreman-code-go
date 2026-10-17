import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ListAgentsResponseSchema } from '@foreman-code/contracts'
import { WorkflowArchiveInputSchema, WorkflowUpdateInputSchema } from '@foreman-code/contracts/management'
import {
  SavedManagedWorkflowCommandResultSchema, SavedWorkflowResponseSchema, SavedWorkspaceDetailsSchema,
  type SavedWorkspaceDetails,
} from '@foreman-code/contracts/wave25'
import type { ZodType } from 'zod'
import { assertResponse, type NormalizationRule } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertApiError, createWorkspace } from '../smoke/support.js'
import { createCodexAgent } from '../workflows/agents.js'
import { updateUnreferencedAgent } from './agent-support.js'
import { assertReadCredentialRejected, readCoverage } from './support.js'
import { createEmptyWorkflow, workflowCollectionPath } from './workflow-support.js'

const workspaceRoute = '/api/workspaces/:workspaceId'
const agentsRoute = `${workspaceRoute}/agents`
const workflowRoute = `${workspaceRoute}/workflows/:workflowId`

async function assertProjection(ctx: ScenarioContext, path: string, contract: ZodType,
  expected: unknown, normalization: readonly NormalizationRule[] = []) {
  const response = await ctx.http.request('GET', path)
  contract.parse(response.body)
  assertResponse(response, { status: 200, body: expected }, normalization)
  const head = await ctx.http.request('HEAD', path)
  assertResponse(head, { status: 200, body: null })
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(head.headers.get('content-type'), response.headers.get('content-type'))
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(JSON.stringify(response.body))))
  await assertReadCredentialRejected(ctx, path)
}

async function assertProductSnapshot(ctx: ScenarioContext,
  expected: Pick<SavedWorkspaceDetails, 'workspace' | 'agents' | 'workflows'>) {
  const path = `/api/workspaces/${expected.workspace.id}`
  await assertProjection(ctx, path, SavedWorkspaceDetailsSchema, {
    ...expected, runs: [], resources: [],
    runners: [{ id: 'runner-local', name: 'Local Runner',
      health: { status: 'healthy', checkedAt: '<timestamp>' } }],
  }, [{ pointer: '/body/runners/0/health/checkedAt', kind: 'timestamp' }])
  await assertProjection(ctx, `${path}/agents`, ListAgentsResponseSchema, { agents: expected.agents })
  for (const workflow of expected.workflows) {
    await assertProjection(ctx, `${path}/workflows/${workflow.id}`, SavedWorkflowResponseSchema, { workflow })
  }
}

export const workspaceProductScenario: Scenario = {
  id: 'http.workspace-product.persisted-projections',
  title: 'Product reads retain complete Agent and workflow records through edits, archive and restart',
  lane: 'A2',
  covers: [...readCoverage(workspaceRoute), ...readCoverage(agentsRoute), ...readCoverage(workflowRoute)],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Product projection workspace')
    const workspaceId = workspace.created.workspace.id
    const createdAgent = await createCodexAgent(ctx, workspaceId, { name: 'Product projection coder' })
    const { input: create, created } = await createEmptyWorkflow(ctx, workspaceId, 'Product projection workflow')
    const snapshot: Pick<SavedWorkspaceDetails, 'workspace' | 'agents' | 'workflows'> = {
      workspace: workspace.created.workspace, agents: [createdAgent.agent], workflows: [created.workflow],
    }
    await assertProductSnapshot(ctx, snapshot)

    const missingId = `missing-${workspaceId}`
    assertApiError(await ctx.http.request('GET', `/api/workspaces/${missingId}`),
      404, 'WORKSPACE_NOT_FOUND', `workspace '${missingId}' was not found.`)
    // The frozen product Agent collection returns an empty list for an absent workspace.
    await assertProjection(ctx, `/api/workspaces/${missingId}/agents`, ListAgentsResponseSchema, { agents: [] })
    const other = await createWorkspace(ctx, 'Separate product projection workspace')
    assertApiError(await ctx.http.request('GET',
      `/api/workspaces/${other.created.workspace.id}/workflows/${created.workflow.id}`),
    404, 'WORKFLOW_NOT_FOUND', `Workflow '${created.workflow.id}' was not found.`)

    const { updated: updatedAgent } = await updateUnreferencedAgent(ctx, workspaceId, createdAgent, {
      prompt: { system: 'The product projection must retain this revised prompt.\nUnicode: café λ.' },
    })
    const update = WorkflowUpdateInputSchema.parse({ workspaceId, workflowId: created.workflow.id,
      commandId: randomUUID(), expectedRevision: 1, name: 'Updated product workflow', description: null })
    const managementPath = `${workflowCollectionPath(workspaceId)}/${created.workflow.id}`
    const response = await ctx.http.request('PATCH', managementPath, { body: update })
    const updated = SavedManagedWorkflowCommandResultSchema.parse(response.body).value
    const definition = { ...created.workflow }
    delete definition.description
    assertResponse(response, { status: 200, body: { value: {
      ...created, workflow: { ...definition, name: update.name, updatedAt: '<timestamp>' }, revision: 2,
    }, replayed: false } }, [{ pointer: '/body/value/workflow/updatedAt', kind: 'timestamp' }])
    snapshot.agents = [updatedAgent.agent]
    snapshot.workflows = [updated.workflow]
    await assertProductSnapshot(ctx, snapshot)

    const archive = WorkflowArchiveInputSchema.parse({ workspaceId, workflowId: created.workflow.id,
      commandId: randomUUID(), expectedRevision: 2 })
    const archivedResponse = await ctx.http.request('DELETE', managementPath, { body: archive })
    const archived = SavedManagedWorkflowCommandResultSchema.parse(archivedResponse.body).value
    assertResponse(archivedResponse, { status: 200, body: {
      value: { ...updated, revision: 3, archivedAt: '<timestamp>' }, replayed: false,
    } }, [{ pointer: '/body/value/archivedAt', kind: 'timestamp' }])
    // Product definitions remain readable after archive; the management list hides active membership.
    await assertProductSnapshot(ctx, snapshot)
    assertResponse(await ctx.http.request('GET', workflowCollectionPath(workspaceId)), {
      status: 200, body: { items: [], pageInfo: { nextCursor: null }, orderRevision: 2 },
    })
    await ctx.target.restart()
    await assertProductSnapshot(ctx, snapshot)
    assertResponse(await ctx.http.request('GET', workflowCollectionPath(workspaceId)), {
      status: 200, body: { items: [], pageInfo: { nextCursor: null }, orderRevision: 2 },
    })
    assertResponse(await ctx.http.request('DELETE', managementPath, { body: archive }), {
      status: 200, body: { value: archived, replayed: true },
    })
    assertResponse(await ctx.http.request('POST', workflowCollectionPath(workspaceId), { body: create }), {
      status: 200, body: { value: created, replayed: true },
    })
    await assertProductSnapshot(ctx, snapshot)
    assertResponse(await ctx.http.request('GET', workflowCollectionPath(workspaceId)), {
      status: 200, body: { items: [], pageInfo: { nextCursor: null }, orderRevision: 2 },
    })
  },
}
