import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AgentCreateInputSchema } from '@foreman-code/contracts/management'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { assertApiError, createWorkspace, httpCoverage } from '../smoke/support.js'
import { createCodexAgent } from '../workflows/support.js'
import { agentCollectionRoute, agentRoute, codexConfigurationVersion, updateUnreferencedAgent } from './agent-support.js'
import { assertProtectedRead, readCoverage } from './support.js'

export const agentScenario: Scenario = {
  id: 'http.agents.configuration-history',
  title: 'Agent configuration edits preserve exact immutable versions, pins, and public readback',
  lane: 'A2',
  covers: [
    ...readCoverage(agentCollectionRoute),
    ...readCoverage(agentRoute),
    ...readCoverage(`${agentRoute}/versions/:versionId`),
    httpCoverage('POST', agentCollectionRoute, 'success'),
    httpCoverage('POST', agentCollectionRoute, 'error'),
    httpCoverage('PATCH', agentRoute, 'success'),
    httpCoverage('PATCH', agentRoute, 'error'),
  ],
  async run(ctx) {
    const workspace = await createWorkspace(ctx, 'Agent version workspace')
    const workspaceId = workspace.created.workspace.id
    const collection = `/api/management/workspaces/${workspaceId}/agents`
    await assertProtectedRead(ctx, collection, { items: [], pageInfo: { nextCursor: null } })
    const created = await createCodexAgent(ctx, workspaceId, { name: 'Versioned coder' })
    const path = `${collection}/${created.agent.id}`
    assert.ok(created.agent.createdAt)
    const firstVersion = codexConfigurationVersion(workspaceId, created.agent, 1, created.agent.createdAt)
    await assertProtectedRead(ctx, path, { ...created, archivedAt: null, workflowIds: [] })
    await assertProtectedRead(ctx, `${path}/versions/${firstVersion.id}`, { version: firstVersion })
    const conflict = AgentCreateInputSchema.parse({
      workspaceId, agentId: created.agent.id, commandId: randomUUID(), name: 'Conflicting coder ID',
      productRole: 'coder', configuration: created.agent.harnessConfiguration,
      prompt: created.agent.prompt, assignedSkills: [], nativeTools: created.agent.nativeTools,
    })
    assertApiError(await ctx.http.request('POST', collection, { body: conflict }),
      409, 'AGENT_ID_CONFLICT', 'The Agent ID already exists.')

    const { input, updated } = await updateUnreferencedAgent(ctx, workspaceId, created, {
      prompt: { system: 'An immutable revised prompt.\nPreserve Unicode: λ ✓\n' },
    })
    assertResponse(await ctx.http.request('PATCH', path, { body: input }), {
      status: 200, body: { value: updated, replayed: true },
    })
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...input, commandId: randomUUID() },
    }), 409, 'AGENT_REVISION_CONFLICT', 'The Agent metadata changed.')
    assertApiError(await ctx.http.request('PATCH', path, {
      body: { ...input, commandId: randomUUID(), expectedRevision: 2 },
    }), 409, 'AGENT_CONFIGURATION_CONFLICT', 'The Agent configuration changed.')
    const readable = { agent: updated.agent, metadataRevision: 2, archivedAt: null }
    await assertProtectedRead(ctx, path, { ...readable, workflowIds: [] })
    await assertProtectedRead(ctx, collection, { items: [readable], pageInfo: { nextCursor: null } })
    assert.ok(updated.agent.updatedAt)
    const secondVersion = codexConfigurationVersion(workspaceId, updated.agent, 2, updated.agent.updatedAt)
    await assertProtectedRead(ctx, `${path}/versions/${secondVersion.id}`, { version: secondVersion })
    await assertProtectedRead(ctx, `${path}/versions/${firstVersion.id}`, { version: firstVersion })
    assertApiError(await ctx.http.request('GET', `${path}/versions/agent-version-missing`),
      404, 'AGENT_VERSION_NOT_FOUND', 'The Agent version was not found.')
    await ctx.target.restart()
    await assertProtectedRead(ctx, `${path}/versions/${firstVersion.id}`, { version: firstVersion })
    await assertProtectedRead(ctx, path, { ...readable, workflowIds: [] })
  },
}
