import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema } from '@graphql/contracts/wave25'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

function value(result: { isError?: boolean; structuredContent?: unknown }) {
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true)
  return result.structuredContent as Record<string, unknown>
}
afterEach(() => vi.restoreAllMocks())
describe.skipIf(!postgresEnabled)('Operator MCP current PostgreSQL integration', () => {
  it('discovers current tools and denies missing, worker, expired, revoked, wrong-scope and read-only callers', async () => {
    const f = await currentOperatorIntegration()
    try {
      const names = (await f.client.listTools()).tools.map((tool) => tool.name)
      expect(names).toEqual(expect.arrayContaining(['workspace_create', 'workflow_create', 'run_start', 'run_stop', CURRENT_WORKFLOW_TOOLS.save]))
      expect(names).not.toContain('graph_draft_open')
      const readonly = await f.access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['workflows:read', 'graph:read', 'workspace_locations:validate'], scope: { workspaceIds: [f.f.scope.workspaceId] } }] })
      const reader = await f.connect(readonly.token)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain(CURRENT_WORKFLOW_TOOLS.save)
      const input = await f.create()
      expect((await reader.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })).isError).toBe(true)
      const wrong = await f.access.issue({ name: 'Wrong workspace', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['wrong'] } }] })
      expect((await (await f.connect(wrong.token)).callTool({ name: 'workflow_get', arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId } })).isError).toBe(true)
      async function post(token?: string, origin?: string) {
        return fetch(new URL('/mcp/operator', f.address), { method: 'POST', headers: { 'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
      }
      expect((await post()).status).toBe(401)
      const worker = await f.access.issue({ name: 'Worker', audience: 'worker', agentId: f.f.configurations[0]!.agentId,
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      expect((await post(worker.token)).status).toBe(403)
      await f.db.pool.query('update management_principals set expires_at=now()-interval \'1 second\' where id=$1', [wrong.principal.id])
      expect((await post(wrong.token)).status).toBe(401)
      await f.access.revoke(readonly.principal.id)
      expect((await post(readonly.token)).status).toBe(401)
      expect((await post(f.writer.token, 'https://example.com')).status).toBe(403)
      expect((await f.db.pool.query('select id from management_audit where principal_id=$1', [readonly.principal.id])).rowCount).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 60000)

  it('creates independent workspaces, persists and conflicts on location revisions, and reports unavailable paths', async () => {
    const f = await currentOperatorIntegration()
    try {
      const ids: string[] = []
      for (const index of [0, 1]) {
        const commandId = randomUUID()
        const args = { commandId, name: `Independent workspace ${index}` }
        const created = value(await f.client.callTool({ name: 'workspace_create', arguments: args }))
        const workspace = (created.value as { workspace: { id: string } }).workspace; ids.push(workspace.id)
        expect(value(await f.client.callTool({ name: 'workspace_create', arguments: args }))).toEqual({ ...created, replayed: true })
        const rootPath = join(f.db.directory, `project-${index}`); await mkdir(rootPath)
        const location = { workspaceId: workspace.id, commandId: randomUUID(), expectedLocationRevision: 0, runnerId: f.locations.runnerId, rootPath }
        value(await f.client.callTool({ name: 'workspace_location_set', arguments: location }))
        expect(value(await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: workspace.id } })))
          .toMatchObject({ executionLocation: { rootPath }, locationRevision: 1 })
        expect((await f.client.callTool({ name: 'workspace_location_set', arguments: { ...location, commandId: randomUUID() } })).isError).toBe(true)
      }
      expect(ids[0]).not.toBe(ids[1])
      const rootPath = join(f.db.directory, 'project-1'); await rm(rootPath, { recursive: true })
      expect(value(await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId: ids[1] } })))
        .toMatchObject({ executionLocation: { rootPath }, locationValidation: { status: 'unavailable' } })
      const listed = value(await f.client.callTool({ name: 'workspace_list', arguments: { limit: 100 } }))
      expect((listed.items as Array<{ workspace: { id: string } }>).map((item) => item.workspace.id)).toEqual(expect.arrayContaining(ids))
    } finally { await f.close() }
  }, 60000)

  it('saves, validates, reads, starts and Stops through authenticated MCP with exact current pins and durable retries', async () => {
    const f = await currentOperatorIntegration()
    try {
      const input = await f.create(), { commandId: _commandId, ...validation } = input
      value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.validate, arguments: validation }))
      const saved = CurrentWorkflowSaveResultSchema.parse(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input })))
      expect(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: input }))).toEqual({ ...saved, replayed: true })
      expect((await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: { ...input, graph: { ...input.graph, name: 'Conflicting command' } } })).isError).toBe(true)
      const read = value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.saved, arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId } }))
      expect(read.version).toEqual(saved.value.version)
      const start = { workspaceId: input.workspaceId, workflowId: input.workflowId, workflowVersionId: saved.value.currentVersionId,
        executionSemanticsVersion: 3, expectedWorkflowRevision: saved.value.revision,
        expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
        expectedLocationRevision: 1, commandId: randomUUID(), input: { message: 'exact input' } }
      const started = value(await f.client.callTool({ name: 'run_start', arguments: start }))
      const run = started.run as { id: string }
      expect(value(await f.client.callTool({ name: 'run_start', arguments: start }))).toMatchObject({ run: { id: run.id }, replayed: true })
      await expect.poll(async () => (await f.runs.get(run.id))?.executionState, { timeout: 20000 }).toBe('waiting')
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2 })
      const persisted = value(await f.client.callTool({ name: 'run_get', arguments: { workspaceId: input.workspaceId, runId: run.id } }))
      expect(persisted.run).toMatchObject({ workflowVersionId: saved.value.currentVersionId, executionSemanticsVersion: 3 })
      expect((await f.client.callTool({ name: 'run_start', arguments: { ...start, input: { message: 'changed' } } })).isError).toBe(true)
      expect((await f.client.callTool({ name: 'workflow_archive', arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId,
        expectedRevision: saved.value.revision, commandId: randomUUID() } })).isError).toBe(true)
      const stop = { workspaceId: input.workspaceId, runId: run.id, commandId: randomUUID() }
      expect(value(await f.client.callTool({ name: 'run_stop', arguments: stop }))).toMatchObject({ runId: run.id, processStopped: false })
      expect(value(await f.client.callTool({ name: 'run_stop', arguments: stop }))).toMatchObject({ runId: run.id, replayed: true })
      await expect.poll(async () => (await f.runs.get(run.id))?.outcome, { timeout: 20000 }).toBe('canceled')
      const archived = value(await f.client.callTool({ name: 'workflow_archive', arguments: { workspaceId: input.workspaceId, workflowId: input.workflowId,
        expectedRevision: saved.value.revision, commandId: randomUUID() } }))
      expect(archived.value).toMatchObject({ archivedAt: expect.any(String) })
      expect(value(await f.client.callTool({ name: 'run_get', arguments: { workspaceId: input.workspaceId, runId: run.id } })))
        .toMatchObject({ run: { id: run.id, outcome: 'canceled' } })
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
