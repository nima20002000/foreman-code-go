import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema,
  WorkflowDefinitionV3Schema,
} from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { createExecutableWorkflow } from '../workflows/support.js'
import { workflowDigest } from '../workflows/digest.js'
import { assertProtectedRead, readCoverage } from './support.js'
import { workflowRoute } from './workflow-support.js'

const versionsRoute = `${workflowRoute}/versions`
const definitionRoute = `${workflowRoute}/definition`

export const workflowVersionScenario: Scenario = {
  id: 'http.workflows.immutable-versions',
  title: 'Publishing a new current definition preserves exact immutable workflow history and pins',
  lane: 'E',
  covers: [
    ...readCoverage(versionsRoute),
    ...readCoverage(`${versionsRoute}/:versionId`),
    ...readCoverage(definitionRoute),
    httpCoverage('PUT', definitionRoute, 'success'),
    httpCoverage('PUT', definitionRoute, 'error'),
  ],
  async run(ctx) {
    const fixture = await createExecutableWorkflow(ctx, { name: 'Immutable workflow history' })
    const first = fixture.saved.version
    const { workspaceId, workflowId } = fixture.saved
    const versions = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}/versions`
    await assertProtectedRead(ctx, fixture.definitionPath, fixture.saved)
    await assertProtectedRead(ctx, versions, { items: [first], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${versions}/${first.id}`, { version: first })

    const graph = WorkflowDefinitionV3Schema.parse({
      ...fixture.workflow.workflow,
      nodes: fixture.workflow.workflow.nodes.map(node => ({
        ...node, initialPrompt: 'Return the second immutable conformance answer.',
      })),
    })
    const input = CurrentWorkflowSaveInputSchema.parse({
      workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: fixture.workflow.revision, expectedWorkflowVersionId: first.id,
      expectedAgentConfigurationVersionIds: first.agentConfigurationVersionIds, graph,
    })
    const response = await ctx.http.request('PUT', fixture.definitionPath, { body: input })
    const saved = CurrentWorkflowSaveResultSchema.parse(response.body).value
    const definition = { ...graph, version: 2, updatedAt: saved.version.createdAt }
    const contentHash = workflowDigest({
      definition, configurations: first.agentConfigurationVersionIds, entryNodeId: first.entryNodeId,
    })
    assertResponse(response, {
      status: 200,
      body: {
        value: {
          workspaceId, workflowId, revision: 3, currentVersionId: saved.version.id,
          version: { ...first, id: '<id>', version: 2, definition, contentHash, createdAt: '<timestamp>' },
        },
        replayed: false,
      },
    }, [
      { pointer: '/body/value/version/id', kind: 'id' },
      { pointer: '/body/value/version/createdAt', kind: 'timestamp' },
    ])
    assert.notEqual(saved.version.id, first.id)
    assert.notEqual(saved.version.contentHash, first.contentHash)
    assertResponse(await ctx.http.request('PUT', fixture.definitionPath, { body: input }), {
      status: 200, body: { value: saved, replayed: true },
    })
    assertApiError(await ctx.http.request('PUT', fixture.definitionPath, {
      body: { ...input, commandId: randomUUID() },
    }), 409, 'REVISION_CONFLICT', 'The displayed workflow revision changed.')
    await assertProtectedRead(ctx, fixture.definitionPath, saved)
    await assertProtectedRead(ctx, `${fixture.definitionPath}?workflowVersionId=${encodeURIComponent(first.id)}`, {
      ...saved, version: first,
    })
    await assertProtectedRead(ctx, versions, { items: [first, saved.version], pageInfo: { nextCursor: null } })
    await assertProtectedRead(ctx, `${versions}?limit=1`, { items: [first], pageInfo: { nextCursor: '1' } })
    await assertProtectedRead(ctx, `${versions}?limit=1&cursor=1`, {
      items: [saved.version], pageInfo: { nextCursor: null },
    })
    await assertProtectedRead(ctx, `${versions}/${first.id}`, { version: first })
    await assertProtectedRead(ctx, `${versions}/${saved.version.id}`, { version: saved.version })
    assertApiError(await ctx.http.request('GET', `${versions}?cursor=0`),
      400, 'CURSOR_INVALID', 'Version cursors must be positive database version numbers.')
    assertApiError(await ctx.http.request('GET', `${versions}/workflow-version-missing`),
      404, 'WORKFLOW_VERSION_NOT_FOUND', 'The workflow version was not found.')
    await ctx.target.restart()
    await assertProtectedRead(ctx, `${versions}/${first.id}`, { version: first })
    await assertProtectedRead(ctx, fixture.definitionPath, saved)
  },
}
