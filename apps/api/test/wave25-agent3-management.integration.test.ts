import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema, GraphDraftSchema } from '@graphql/contracts/management'
import { GraphDraftV2Schema, GraphDraftCommandV2ResultSchema, GraphSaveCommandV2ResultSchema } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { GraphDraftService } from '../src/modules/graph-drafts/service.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import type { HarnessConfigurationQualifier } from '../src/modules/harnesses/port.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { VersionHistoryService } from '../src/modules/workflows/historyManagement.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { agent3Database, seedAgent3, postgresEnabled } from './helpers/wave25Agent3.js'

/** Actual loopback Streamable HTTP MCP endpoint, real persisted principals,
 * scopes, commands and PostgreSQL drafts/versions. No mocked authentication. */
describe.skipIf(!postgresEnabled)('Agent 3 authenticated entry/route editing parity', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>, app: ReturnType<typeof buildApp>
  let access: PostgresAccessService, drafts: GraphDraftService, history: VersionHistoryService, address: string
  const clients: Client[] = []
  beforeAll(async () => {
    db = await agent3Database()
    access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory)
    const workflows = new PostgresWorkflowRepository(db.pool)
    const runs = new PostgresRunRepository(db.pool, workflows, locations)
    drafts = new GraphDraftService(db.pool, commands); history = new VersionHistoryService(db.pool)
    const engine = { start: vi.fn(async () => undefined), cancel: vi.fn(async () => false) } as unknown as LangGraphWorkflowEngine
    const qualifier: HarnessConfigurationQualifier = { async qualify(configuration) {
      return { harness: configuration.harness, version: 'synthetic-no-native-call', authenticated: true, ready: true,
        structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
        supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: ['model'], unsupportedCapabilities: [] }
    } }
    const services = {
      commands, locations, drafts, runs: new RunManagementService(db.pool, commands, runs, engine, locations),
      workflows: new WorkflowManagementService(db.pool, commands), agents: new AgentManagementService(db.pool),
      workspaces: new WorkspaceManagementService(db.pool, commands, locations),
      harnesses: new HarnessCatalogService(qualifier, new PostgresSettingsRepository(db.pool), commands, db.directory),
    }
    app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60000)
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close(); await db?.close()
  })
  async function connect(token: string) {
    const client = new Client({ name: 'wave25-a3-authenticated-fixture', version: '1.0.0' })
    try { await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } })) }
    catch (error) { await client.close().catch(() => undefined); throw error }
    clients.push(client); return client
  }
  async function fixture(legacy = false) {
    const f = await seedAgent3(db.pool, db.directory, undefined, { run: false, legacy })
    const issued = await access.issue({ name: 'Synthetic editing owner', audience: 'operator',
      grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }], expiresAt: new Date(Date.now() + 300_000) })
    const client = await connect(issued.token)
    return { f, issued, client }
  }
  async function tool(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toBeTypeOf('object')
    return result.structuredContent
  }
  async function denied(client: Client, name: string, args: Record<string, unknown>) {
    let result
    try { result = await client.callTool({ name, arguments: args }) }
    catch (error) { expect(error).toBeTruthy(); return }
    expect(result.isError).toBe(true)
  }
  const scoped = (f: Awaited<ReturnType<typeof fixture>>['f']) => ({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId })

  it('edits through MCP, reads the persisted draft through authenticated HTTP, and saves exact immutable entry/routes', async () => {
    const { f, issued, client } = await fixture()
    const draft = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const input = { ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: draft.revision, executionSemanticsVersion: 2,
      operations: [{ type: 'workflow.set_entry', entryNodeId: f.version.entryNodeId },
        { type: 'relationship.put', relationship: { ...f.version.definition.edges[0]!, label: 'Exact execution receipt' } },
        { type: 'node.set_choice', nodeId: f.version.entryNodeId, choice: { outcomes: [
          { outcome: 'pass', target: { kind: 'branch_end' } },
          { outcome: 'issues', target: { kind: 'edge', relationshipId: f.version.definition.edges[0]!.id } },
        ] } }, { type: 'nodes.reorder', nodeIds: [...f.version.definition.nodes].reverse().map((node) => node.id) }] }
    const edited = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', input))
    const replay = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', input))
    expect(replay.replayed).toBe(true); expect(replay.value.draft.revision).toBe(edited.value.draft.revision)
    const path = `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/drafts/${draft.id}`
    // First-party browser authentication uses the existing local enrollment path.
    const enrolled = await app.inject({ method: 'POST', url: '/api/auth/enroll', headers: { host: 'localhost' }, payload: { token: issued.token } })
    expect(enrolled.statusCode).toBe(200)
    const cookie = String(enrolled.headers['set-cookie']).split(';')[0]!
    const read = await app.inject({ method: 'GET', url: path, headers: { host: 'localhost', cookie } })
    expect(read.statusCode).toBe(200)
    expect(GraphDraftV2Schema.parse(read.json()).graph).toEqual(edited.value.draft.graph)
    const moved = await app.inject({ method: 'POST', url: `${path}/operations`, headers: { host: 'localhost', origin: 'http://localhost', cookie },
      payload: { ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: edited.value.draft.revision, executionSemanticsVersion: 2,
        operations: [{ type: 'node.move', nodeId: f.version.entryNodeId, position: { x: 345, y: 123 } }] } })
    expect(moved.statusCode).toBe(200)
    const fromMcp = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))
    expect(fromMcp.graph.entryNodeId).toBe(f.version.entryNodeId)
    expect(fromMcp.graph.nodes.find((node) => node.id === f.version.entryNodeId)!.position).toEqual({ x: 345, y: 123 })
    const saved = GraphSaveCommandV2ResultSchema.parse(await tool(client, 'graph_save', {
      ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: fromMcp.revision, executionSemanticsVersion: 2,
    }))
    // Fresh service/connection: readback is not the request echoed to the client.
    const persisted = await history.workflow(issued.principal, { ...scoped(f), versionId: saved.value.version.id })
    expect(persisted.version).toEqual(saved.value.version)
    expect((await db.pool.query<{ entry_node_id: string; execution_semantics_version: number }>(
      'select entry_node_id,execution_semantics_version from workflow_versions where id=$1', [saved.value.version.id])).rows[0]).toEqual({ entry_node_id: f.version.entryNodeId, execution_semantics_version: 2 })
    const reread = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))
    expect(reread.baseWorkflowVersionId).toBe(saved.value.version.id)
    expect(reread.graph.nodes.find((node) => node.id === f.version.entryNodeId)?.choice).toEqual(fromMcp.graph.nodes.find((node) => node.id === f.version.entryNodeId)?.choice)
  })
  it('rejects cross-workspace and insufficient-grant MCP calls without a persisted edit', async () => {
    const { f, client } = await fixture()
    const draft = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const input = { ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: draft.revision, executionSemanticsVersion: 2,
      operations: [{ type: 'workflow.set_entry', entryNodeId: null }] }
    const otherScope = await access.issue({ name: 'Different scope', audience: 'operator', grants: [{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['not-this-workspace'] } }], expiresAt: new Date(Date.now() + 300_000) })
    const readOnly = await access.issue({ name: 'Read only', audience: 'operator', grants: [{ actions: ['graph:read', 'workflows:read', 'agents:read'], scope: { workspaceIds: [f.scope.workspaceId] } }], expiresAt: new Date(Date.now() + 300_000) })
    await denied(await connect(otherScope.token), 'graph_draft_apply', input)
    await denied(await connect(readOnly.token), 'graph_draft_apply', input)
    const after = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))
    expect(after).toEqual(draft)
    const noAuth = await app.inject({ method: 'POST', url: `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/drafts/${draft.id}/operations`, headers: { host: 'localhost' }, payload: input })
    expect(noAuth.statusCode).toBe(401)
  })
  it('never treats an App/Worker credential as Operator management authority, and honors revocation', async () => {
    const { f, issued, client } = await fixture()
    const draft = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const worker = await access.issue({ name: 'App worker', audience: 'worker', agentId: f.configurations[0]!.agentId,
      grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 300_000) })
    await expect(connect(worker.token)).rejects.toThrow()
    await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id])
    await denied(client, 'graph_draft_apply', { ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: draft.revision,
      executionSemanticsVersion: 2, operations: [{ type: 'workflow.set_entry', entryNodeId: null }] })
    expect((await db.pool.query<{ revision: string }>('select revision::text from graph_drafts where id=$1', [draft.id])).rows[0]!.revision).toBe(String(draft.revision))
  })
  it('migrates only by an explicit v2 edit and keeps saved legacy versions byte-for-byte intact', async () => {
    const { f, issued, client } = await fixture(true)
    const before = (await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record
    const opened = GraphDraftSchema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const upgraded = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', { ...scoped(f), draftId: opened.id,
      commandId: randomUUID(), expectedRevision: opened.revision, executionSemanticsVersion: 2,
      operations: [{ type: 'nodes.reorder', nodeIds: [...f.version.definition.nodes].reverse().map((node) => node.id) }] }))
    expect(upgraded.value.draft.graph.entryNodeId).toBe(f.version.entryNodeId)
    expect((await history.workflow(issued.principal, { ...scoped(f), versionId: f.version.id })).version).toEqual(before)
    expect((await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record).toEqual(before)
  })
  it('clears a removed entry and rejects dangling routes and conflicting command replay', async () => {
    const { f, issued, client } = await fixture()
    let draft = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const choice = { outcomes: [{ outcome: 'go', target: { kind: 'edge', relationshipId: f.version.definition.edges[0]!.id } }] }
    draft = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', { ...scoped(f), draftId: draft.id, commandId: randomUUID(),
      expectedRevision: draft.revision, executionSemanticsVersion: 2,
      operations: [{ type: 'node.set_choice', nodeId: f.version.entryNodeId, choice }, { type: 'edge.disconnect', edgeId: f.version.definition.edges[0]!.id }] })).value.draft
    expect((await drafts.validate(issued.principal, f.scope.workspaceId, f.scope.workflowId, draft.id)).valid).toBe(false)
    const command = { ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: draft.revision, executionSemanticsVersion: 2,
      operations: [{ type: 'node.remove', nodeId: f.version.entryNodeId }] }
    draft = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', command)).value.draft
    expect(draft.graph.entryNodeId).toBeNull()
    await denied(client, 'graph_draft_apply', { ...command, operations: [{ type: 'workflow.set_entry', entryNodeId: null }] })
    expect(GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id })).revision).toBe(draft.revision)
  })
})
