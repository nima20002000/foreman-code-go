import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema, GraphDraftSchema } from '@graphql/contracts/management'
import { GraphDraftV2Schema, GraphDraftCommandV2ResultSchema, GraphSaveCommandV2ResultSchema, WorkflowRunV2Schema, WorkflowVersionV2Schema, GraphEditReadResultSchema, type GraphEditIntent } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator, commandInputHash } from '../src/modules/commands/postgres.js'
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
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { insertOneShotRun } from '../src/modules/runs/oneShotAdmission.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { agent3Database, seedAgent3, postgresEnabled, ownedAgent3 } from './helpers/wave25Agent3.js'

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
  async function fixture(legacy = false, withRun = false) {
    const f = await seedAgent3(db.pool, db.directory, undefined, { run: withRun, legacy })
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

  // NIM-2642: real authenticated transports and persisted readback. These
  // fixtures model domain lifecycle cuts without starting a native provider.
  const draftPath = (f: Awaited<ReturnType<typeof fixture>>['f'], draftId: string) =>
    `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/drafts/${draftId}`
  async function browserHeaders(token: string) {
    const enrolled = await app.inject({ method: 'POST', url: '/api/auth/enroll',
      headers: { host: 'localhost' }, payload: { token } })
    expect(enrolled.statusCode).toBe(200)
    return { host: 'localhost', origin: 'http://localhost', cookie: String(enrolled.headers['set-cookie']).split(';')[0]! }
  }
  async function stagedPrompt(f: Awaited<ReturnType<typeof fixture>>['f'], client: Client) {
    const opened = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    return GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', {
      ...scoped(f), draftId: opened.id, commandId: randomUUID(), expectedRevision: opened.revision,
      executionSemanticsVersion: 2, operations: [{ type: 'node.replace_v2',
        node: { ...opened.graph.nodes[0]!, initialPrompt: 'NIM-2642 retained exact prompt' } }],
    })).value.draft
  }
  const saveInput = (f: Awaited<ReturnType<typeof fixture>>['f'], draft: ReturnType<typeof GraphDraftV2Schema.parse>) => ({
    ...scoped(f), draftId: draft.id, commandId: randomUUID(), expectedRevision: draft.revision, executionSemanticsVersion: 2 as const,
  })
  async function counts(f: Awaited<ReturnType<typeof fixture>>['f']) {
    return (await db.pool.query<{ versions: string; runs: string }>(
      `select (select count(*)::text from workflow_versions where workflow_id=$1) as versions,
        (select count(*)::text from runs where workflow_id=$1) as runs`, [f.scope.workflowId])).rows[0]!
  }

  it.each(['queued', 'running', 'waiting'] as const)('NIM-2642 rejects meaningful publication for %s through HTTP and MCP without changing accepted facts', async (state) => {
    const { f, issued, client } = await fixture(false, true)
    const owned = await ownedAgent3(db.pool, f)
    try {
      await owned.store.updateRun({ executionState: state, outcome: 'pending' })
      const before = (await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [f.run.id])).rows[0]!.record
      const draft = await stagedPrompt(f, client), input = saveInput(f, draft)
      const response = await app.inject({ method: 'POST', url: `${draftPath(f, draft.id)}/save`,
        headers: await browserHeaders(issued.token), payload: input })
      expect(response.statusCode).toBe(409)
      expect(JSON.stringify(response.json())).toContain('WORKFLOW_RUNS_UNSETTLED')
      await denied(client, 'graph_save', input)
      expect(await counts(f)).toEqual({ versions: '1', runs: '1' })
      expect((await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [f.run.id])).rows[0]!.record).toEqual(before)
      expect(GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))).toEqual(draft)
      expect((await db.pool.query('select 1 from management_command_receipts where operation=$1 and command_id=$2',
        ['graph.save', input.commandId])).rowCount).toBe(0)
      expect((await db.pool.query('select 1 from management_command_receipts where operation=$1 and target_key=$2',
        ['run.stop', `run:${f.run.id}`])).rowCount).toBe(0)
    } finally { await owned.owner.release() }
  })

  it('NIM-2642 permits layout during execution, reuses the immutable version, reconciles a dropped reply across transports, and revokes replay authority', async () => {
    const { f, issued, client } = await fixture(false, true)
    const before = (await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record
    const opened = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const moved = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', {
      ...scoped(f), draftId: opened.id, commandId: randomUUID(), expectedRevision: opened.revision,
      executionSemanticsVersion: 2, operations: [{ type: 'node.move', nodeId: opened.graph.nodes[0]!.id, position: { x: 987, y: -123 } }],
    })).value.draft
    expect(moved.publishedRevision).toBe(moved.revision)
    const input = saveInput(f, moved), headers = await browserHeaders(issued.token)
    // Intentionally ignore the first successful body: retry is the exact same
    // graph.save command through the other authenticated transport.
    expect((await app.inject({ method: 'POST', url: `${draftPath(f, moved.id)}/save`, headers, payload: input })).statusCode).toBe(200)
    const replay = GraphSaveCommandV2ResultSchema.parse(await tool(client, 'graph_save', input))
    expect(replay.replayed).toBe(true)
    expect(replay.value.version.id).toBe(f.version.id)
    expect(replay.value.draft.revision).toBe(input.expectedRevision + 1)
    expect(replay.value.draft.graph.nodes[0]!.position).toEqual({ x: 987, y: -123 })
    expect(await counts(f)).toEqual({ versions: '1', runs: '1' })
    expect((await db.pool.query<{ record: unknown }>('select record from workflow_versions where id=$1', [f.version.id])).rows[0]!.record).toEqual(before)
    expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
      [issued.principal.id, 'graph.save', input.commandId])).rowCount).toBe(1)
    const read = await app.inject({ method: 'GET', url: draftPath(f, moved.id), headers })
    expect(GraphDraftV2Schema.parse(read.json())).toEqual(replay.value.draft)
    await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id])
    // Exercise the service too: a previously authenticated in-memory principal
    // cannot bypass revocation by replaying an already successful receipt.
    await expect(drafts.save(issued.principal, 'mcp', input)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    await denied(client, 'graph_save', input)
  })

  it('NIM-2642 requires every active Run and post-terminal cleanup, preserves one exact Stop receipt and saves once without restarting', async () => {
    const { f, issued, client } = await fixture(false, true)
    const secondId = randomUUID()
    const second = { ...f, scope: { ...f.scope, runId: secondId }, run: WorkflowRunV2Schema.parse({ ...f.run, id: secondId }) }
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, second.run)))
    const firstOwner = await ownedAgent3(db.pool, f), secondOwner = await ownedAgent3(db.pool, second)
    try {
      const draft = await stagedPrompt(f, client), input = saveInput(f, draft)
      const stop = { workspaceId: f.scope.workspaceId, runId: f.run.id, commandId: randomUUID() }
      // The fixture engine returns not_owner, not an invented process exit.
      expect(await tool(client, 'run_stop', stop)).toMatchObject({ runId: f.run.id, processStopped: false })
      expect(await tool(client, 'run_stop', stop)).toMatchObject({ replayed: true, processStopped: false })
      await denied(client, 'graph_save', input)
      expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
        [issued.principal.id, 'run.stop', stop.commandId])).rowCount).toBe(1)
      expect((await db.pool.query<{ stopped: boolean }>('select stop_requested_at is not null as stopped from runs where id=$1', [secondId])).rows[0]!.stopped).toBe(false)
      await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'cleanup', pending: true })
      await firstOwner.store.settleRun(true)
      // One business terminal is not all-Run settlement.
      await denied(client, 'graph_save', input)
      await secondOwner.store.settleRun(false) // natural failed completion; no Stop is fabricated for this Run
      await denied(client, 'graph_save', input) // first Run still has pending cleanup
      // No native work was launched. This is synthetic cleanup evidence through
      // the existing lifecycle service, not a native-provider verification.
      await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'cleanup', pending: false })
      const saved = GraphSaveCommandV2ResultSchema.parse(await tool(client, 'graph_save', input))
      expect(saved.value.version.id).not.toBe(f.version.id)
      expect(GraphSaveCommandV2ResultSchema.parse(await tool(client, 'graph_save', input)).replayed).toBe(true)
      expect(await counts(f)).toEqual({ versions: '2', runs: '2' })
      const accepted = await db.pool.query<{ workflow_version_id: string; pins: unknown }>(
        `select workflow_version_id,record->'agentConfigurationVersionIds' as pins from runs where workflow_id=$1`, [f.scope.workflowId])
      expect(accepted.rows).toHaveLength(2)
      for (const run of accepted.rows) {
        expect(run.workflow_version_id).toBe(f.version.id)
        expect(run.pins).toEqual(f.run.agentConfigurationVersionIds)
      }
      expect((await history.workflow(issued.principal, { ...scoped(f), versionId: f.version.id })).version).toEqual(f.version)
      expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
        [issued.principal.id, 'graph.save', input.commandId])).rowCount).toBe(1)
    } finally { await firstOwner.owner.release(); await secondOwner.owner.release() }
  })

  it('NIM-2642 does not give read-only/wrong-scope callers a layout-save bypass', async () => {
    const { f, client } = await fixture(false, true)
    const draft = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    const input = saveInput(f, draft)
    for (const wrongScope of [false, true]) {
      const limited = await access.issue({ name: 'NIM-2642 denied save caller', audience: 'operator',
        grants: [{ actions: wrongScope ? ManagementActionSchema.options : ['graph:read', 'workflows:read', 'agents:read'],
          scope: { workspaceIds: [wrongScope ? 'another-workspace' : f.scope.workspaceId] } }],
        expiresAt: new Date(Date.now() + 300_000) })
      await denied(await connect(limited.token), 'graph_save', input)
      const response = await app.inject({ method: 'POST', url: `${draftPath(f, draft.id)}/save`,
        headers: await browserHeaders(limited.token), payload: input })
      expect(response.statusCode).toBe(403)
    }
    expect(GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))).toEqual(draft)
    expect(await counts(f)).toEqual({ versions: '1', runs: '1' })
  })


  // Private intent protocol: real authenticated HTTP/MCP and independent SQL
  // readback. The existing fixture engine launches no native work; these tests
  // MUST NOT be described as provider/real-browser evidence.
  const intentCommand = (intent: GraphEditIntent, discard = false) => ({
    action: discard ? 'discard_edits' as const : 'stop_and_save' as const,
    workspaceId: intent.workspaceId, workflowId: intent.workflowId, draftId: intent.draftId,
    intentId: intent.id, commandId: discard ? intent.discardCommandId : intent.advanceCommandId,
  })
  async function privateRequest(f: Awaited<ReturnType<typeof fixture>>['f'], client: Client) {
    const draft = GraphDraftV2Schema.parse(await tool(client, 'graph_draft_open', scoped(f)))
    return { draft, request: { ...saveInput(f, draft), action: 'stage_edits' as const,
      expectedWorkflowVersionId: draft.baseWorkflowVersionId,
      operations: [{ type: 'node.replace_v2' as const, node: { ...draft.graph.nodes[0]!, initialPrompt: 'Private exact payload' } }] } }
  }
  async function readPrivate(client: Client, intent: GraphEditIntent) {
    return GraphEditReadResultSchema.parse(await tool(client, 'graph_draft_get', { action: 'read_edits',
      workspaceId: intent.workspaceId, workflowId: intent.workflowId, draftId: intent.draftId, intentId: intent.id }))
  }
  it('NIM-2642 privately stages, recovers a lost reply across transports, then atomically saves and reads the SAME command once', async () => {
    const { f, issued, client } = await fixture()
    const { draft, request } = await privateRequest(f, client), headers = await browserHeaders(issued.token)
    const root = `${draftPath(f, draft.id)}/edit-intents`
    expect((await app.inject({ method: 'POST', url: root, headers, payload: request })).statusCode).toBe(200)
    // Ignore the first body, then reconcile the exact Stage receipt via MCP.
    const staged = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', request)), intent = staged.intent!
    expect(intent.state).toBe('staged'); expect(intent.stageCommandId).toBe(request.commandId)
    expect(intent.stageInputHash).toBe(commandInputHash(request))
    expect(intent.advanceInputHash).toBe(commandInputHash(intentCommand(intent)))
    expect(intent.discardInputHash).toBe(commandInputHash(intentCommand(intent, true)))
    expect(intent.saveInputHash).toBe(commandInputHash({ ...intent.saveInput, editIntentId: intent.id }))
    expect(intent.stops).toEqual([])
    expect(GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))).toEqual(draft)
    expect(await counts(f)).toEqual({ versions: '1', runs: '0' })
    expect((await db.pool.query('select 1 from management_command_receipts where operation=$1 and command_id=$2',
      ['graph.stage_edits', request.commandId])).rowCount).toBe(1)
    const savedResponse = await app.inject({ method: 'POST', url: `${root}/${intent.id}/advance`, headers, payload: intentCommand(intent) })
    expect(savedResponse.statusCode).toBe(200) // Body may be dropped; durable read is authoritative.
    const saved = await readPrivate(client, intent)
    expect(saved.intent?.state).toBe('saved')
    const replay = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', intentCommand(intent)))
    expect(replay.intent).toEqual(saved.intent)
    expect((await db.pool.query<{ record: unknown }>('select record from graph_edit_intents where id=$1', [intent.id])).rows[0]!.record).toEqual(saved.intent)
    expect(await counts(f)).toEqual({ versions: '2', runs: '0' })
    expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
      [issued.principal.id, 'graph.save', intent.saveInput.commandId])).rowCount).toBe(1)
    expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2',
      [issued.principal.id, 'run.stop'])).rowCount).toBe(0)
    expect((await history.workflow(issued.principal, { ...scoped(f), versionId: saved.intent!.result!.version.id })).version)
      .toEqual(saved.intent!.result!.version)
    // A caller cannot impersonate the journal's internal-only save context.
    await denied(client, 'graph_save', intent.saveInput)
    await denied(client, 'graph_save', { ...intentCommand(intent), commandId: randomUUID() })
  })

  it.each(['queued', 'running', 'waiting'] as const)('NIM-2642 retains private %s intent; Discard issues no Stop and never rewrites the shared layout', async (state) => {
    const { f, issued, client } = await fixture(false, true), owned = await ownedAgent3(db.pool, f)
    try {
      await owned.store.updateRun({ executionState: state, outcome: 'pending' })
      const { draft, request } = await privateRequest(f, client)
      const staged = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', request)), intent = staged.intent!
      expect(staged.current).toHaveLength(1); expect(staged.current[0]?.settled).toBe(false)
      expect(intent.affected[0]).toMatchObject({ runId: f.run.id, workflowVersionId: f.version.id, agentConfigurationVersionIds: f.run.agentConfigurationVersionIds })
      expect(intent.stops[0]?.inputHash).toBe(commandInputHash(intent.stops[0]!.input))
      const before = (await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [f.run.id])).rows[0]!.record
      // Another tab may independently change layout. Private discard must not
      // call the shared draft discard or rewind that separately acknowledged edit.
      const moved = GraphDraftCommandV2ResultSchema.parse(await tool(client, 'graph_draft_apply', { ...saveInput(f, draft),
        operations: [{ type: 'node.move', nodeId: draft.graph.nodes[0]!.id, position: { x: 440, y: -220 } }] })).value.draft
      const response = await app.inject({ method: 'POST', url: `${draftPath(f, draft.id)}/edit-intents/${intent.id}/discard`,
        headers: await browserHeaders(issued.token), payload: intentCommand(intent, true) })
      expect(response.statusCode).toBe(200)
      const discarded = GraphEditReadResultSchema.parse(await tool(client, 'graph_draft_discard', intentCommand(intent, true)))
      expect(discarded.intent?.state).toBe('discarded'); expect(discarded.intent?.stagedDraft).toEqual(intent.stagedDraft)
      expect(GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))).toEqual(moved)
      expect((await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [f.run.id])).rows[0]!.record).toEqual(before)
      expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2',
        [issued.principal.id, 'run.stop'])).rowCount).toBe(0)
      expect(await counts(f)).toEqual({ versions: '1', runs: '1' })
    } finally { await owned.owner.release() }
  })

  it('NIM-2642 reuses every Stop receipt after dropped replies/duplicate clicks and waits beyond terminal cleanup before save', async () => {
    const { f, issued, client } = await fixture(false, true)
    const secondId = randomUUID(), second = { ...f, scope: { ...f.scope, runId: secondId }, run: WorkflowRunV2Schema.parse({ ...f.run, id: secondId }) }
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, second.run)))
    const first = await ownedAgent3(db.pool, f), other = await ownedAgent3(db.pool, second)
    const originalStop = RunManagementService.prototype.stop
    const lostReply = vi.spyOn(RunManagementService.prototype, 'stop').mockImplementationOnce(async function (this: RunManagementService, ...args: Parameters<RunManagementService['stop']>) {
      await originalStop.apply(this, args)
      throw new Error('Synthetic lost Stop reply AFTER its command receipt committed')
    })
    try {
      const { draft, request } = await privateRequest(f, client)
      const staged = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', request)), intent = staged.intent!
      expect(intent.stops).toHaveLength(2)
      const command = intentCommand(intent), headers = await browserHeaders(issued.token)
      const replies = await Promise.all([
        app.inject({ method: 'POST', url: `${draftPath(f, draft.id)}/edit-intents/${intent.id}/advance`, headers, payload: command }),
        tool(client, 'graph_save', command),
      ])
      expect(replies[0].statusCode).toBe(200)
      let read = await readPrivate(client, intent)
      expect(read.intent?.state).toBe('waiting')
      expect(read.intent?.stops.map((entry) => entry.input)).toEqual(intent.stops.map((entry) => entry.input))
      for (const entry of read.intent!.stops) {
        expect(entry.receipt).toMatchObject({ runId: entry.input.runId, status: 'not_owner', processStopped: false })
        expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3',
          [issued.principal.id, 'run.stop', entry.input.commandId])).rowCount).toBe(1)
      }
      await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'cleanup', pending: true })
      await first.store.settleRun(true); await other.store.settleRun(false)
      read = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', command))
      expect(read.intent?.state).toBe('waiting'); expect(read.current.some((item) => item.cleanupPending)).toBe(true)
      expect(await counts(f)).toEqual({ versions: '1', runs: '2' })
      await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'cleanup', pending: false })
      const siblingPending = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', command))
      expect(siblingPending.intent?.state).toBe('waiting')
      expect(siblingPending.current.find((item) => item.pin.runId === second.run.id)?.cleanupPending).toBe(true)
      await changeOneShotLifecycle(db.pool, second.run.id, { kind: 'cleanup', pending: false })
      const saved = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', command))
      expect(saved.intent?.state).toBe('saved')
      expect((await readPrivate(client, intent)).intent).toEqual(saved.intent)
      expect(await counts(f)).toEqual({ versions: '2', runs: '2' })
      const accepted = await db.pool.query<{ workflow_version_id: string; pins: unknown }>(
        `select workflow_version_id,record->'agentConfigurationVersionIds' as pins from runs where workflow_id=$1`, [f.scope.workflowId])
      for (const run of accepted.rows) { expect(run.workflow_version_id).toBe(f.version.id); expect(run.pins).toEqual(f.run.agentConfigurationVersionIds) }
      expect((await history.workflow(issued.principal, { ...scoped(f), versionId: f.version.id })).version).toEqual(f.version)
    } finally { lostReply.mockRestore(); await first.owner.release(); await other.owner.release() }
  })

  it('NIM-2642 records natural completion without a fabricated Stop and retains stale revision/Start conflicts without expanding the plan', async () => {
    const { f, issued, client } = await fixture(false, true), owned = await ownedAgent3(db.pool, f)
    try {
      const { draft, request } = await privateRequest(f, client)
      const intent = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', request)).intent!
      await owned.store.settleRun(false) // No Stop has been requested.
      const naturallySaved = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', intentCommand(intent)))
      expect(naturallySaved.intent?.state).toBe('saved')
      expect(naturallySaved.current[0]).toMatchObject({ settled: true, outcome: 'failed' })
      expect(naturallySaved.intent?.stops[0]?.receipt).toBeUndefined()
      expect((await db.pool.query('select 1 from management_command_receipts where operation=$1 and principal_id=$2', ['run.stop', issued.principal.id])).rowCount).toBe(0)
      const next = await privateRequest(f, client)
      const pending = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', next.request)).intent!
      const fresh = naturallySaved.intent!.result!.version
      const added = WorkflowRunV2Schema.parse({ ...f.run, id: randomUUID(), workflowVersionId: fresh.id,
        agentConfigurationVersionIds: fresh.agentConfigurationVersionIds })
      await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, added)))
      const conflict = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', intentCommand(pending)))
      expect(conflict.intent?.state).toBe('blocked'); expect(conflict.intent?.error?.code).toBe('AFFECTED_RUN_SET_CHANGED')
      expect(conflict.intent?.stops).toEqual(pending.stops)
      expect((await db.pool.query<{ stopped: boolean }>('select stop_requested_at is not null as stopped from runs where id=$1', [added.id])).rows[0]!.stopped).toBe(false)
      await tool(client, 'graph_draft_discard', intentCommand(pending, true))
      const again = await privateRequest(f, client)
      const stale = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', again.request)).intent!
      await tool(client, 'graph_draft_apply', { ...saveInput(f, again.draft), operations: [{ type: 'node.move',
        nodeId: draft.graph.nodes[0]!.id, position: { x: 91, y: 92 } }] })
      const rejected = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', intentCommand(stale)))
      expect(rejected.intent?.error?.code).toBe('REVISION_CONFLICT')
      expect(rejected.intent?.stagedDraft).toEqual(stale.stagedDraft)
      expect(rejected.intent?.advanceCommandId).toBe(stale.advanceCommandId)
      expect(rejected.intent?.saveInput).toEqual(stale.saveInput)
    } finally { await owned.owner.release() }
  })

  it('NIM-2642 denies read-only/wrong-scope/other-principal access and revalidates Stop grants before any effect', async () => {
    const { f, issued, client } = await fixture(false, true)
    const { draft, request } = await privateRequest(f, client)
    const intent = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', request)).intent!
    for (const kind of ['readonly', 'wrong-scope', 'other-owner'] as const) {
      const limited = await access.issue({ name: `Intent ${kind}`, audience: 'operator', grants: [{
        actions: kind === 'readonly' ? ['graph:read', 'workflows:read', 'agents:read', 'runs:read'] : ManagementActionSchema.options,
        scope: { workspaceIds: [kind === 'wrong-scope' ? 'different-workspace' : f.scope.workspaceId] },
      }], expiresAt: new Date(Date.now() + 300_000) })
      const other = await connect(limited.token), headers = await browserHeaders(limited.token)
      await denied(other, 'graph_draft_get', { ...scoped(f), draftId: draft.id, intentId: intent.id, action: 'read_edits' })
      const response = await app.inject({ method: 'GET', url: `${draftPath(f, draft.id)}/edit-intents/${intent.id}`, headers })
      expect([403, 404]).toContain(response.statusCode)
      expect(JSON.stringify(response.json())).not.toContain('Private exact payload')
      if (kind !== 'other-owner') await denied(other, 'graph_save', request)
    }
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [issued.principal.id,
      JSON.stringify([{ actions: ManagementActionSchema.options.filter((action) => action !== 'runs:stop'), scope: { workspaceIds: [f.scope.workspaceId] } }])])
    await denied(client, 'graph_save', intentCommand(intent))
    const noStop = await app.inject({ method: 'POST', url: `${draftPath(f, draft.id)}/edit-intents/${intent.id}/advance`,
      headers: await browserHeaders(issued.token), payload: intentCommand(intent) })
    expect(noStop.statusCode).toBe(403)
    expect((await db.pool.query('select 1 from management_command_receipts where principal_id=$1 and operation=$2', [issued.principal.id, 'run.stop'])).rowCount).toBe(0)
    expect((await readPrivate(client, intent)).intent?.stagedDraft).toEqual(intent.stagedDraft)
    await db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [issued.principal.id])
    await expect(drafts.editIntents.read(issued.principal, { ...scoped(f), draftId: draft.id, intentId: intent.id, action: 'read_edits' }))
      .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  })

  it('NIM-2642 includes shared-Agent cross-workflow Runs, preserves their accepted pins and never stops an unplanned Run', async () => {
    const { f, client } = await fixture(false, true)
    const workflowId = randomUUID(), versionId = randomUUID(), runId = randomUUID()
    const version = WorkflowVersionV2Schema.parse({ ...f.version, id: versionId, workflowId,
      definition: { ...f.version.definition, id: workflowId } })
    const run = WorkflowRunV2Schema.parse({ ...f.run, id: runId, workflowId, workflowVersionId: version.id })
    await db.pool.query('insert into workflows(id,workspace_id,current_version_id,record) values($1,$2,null,$3::jsonb)',
      [workflowId, f.scope.workspaceId, JSON.stringify(version.definition)])
    await db.pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
      values($1,$2,$3,1,$4,$5::jsonb,2)`, [version.id, f.scope.workspaceId, workflowId, version.entryNodeId, JSON.stringify(version)])
    await db.pool.query('update workflows set current_version_id=$2 where id=$1', [workflowId, version.id])
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, run)))
    const { draft, request } = await privateRequest(f, client)
    const staged = GraphEditReadResultSchema.parse(await tool(client, 'graph_save', { ...request,
      operations: [{ type: 'agent.rename', agentId: f.configurations[0]!.agentId, expectedAgentRevision: 1, name: 'Shared staged Agent' }] }))
    const intent = staged.intent!
    expect(new Set(intent.affected.map((pin) => pin.runId))).toEqual(new Set([f.run.id, run.id]))
    expect(intent.affected.find((pin) => pin.runId === run.id)).toMatchObject({ workflowId, workflowVersionId: version.id,
      agentConfigurationVersionIds: version.agentConfigurationVersionIds })
    const sharedBefore = (await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [run.id])).rows[0]!.record
    // Private staging itself is neither Stop nor Agent publication.
    expect((await db.pool.query<{ record: unknown }>('select record from runs where id=$1', [run.id])).rows[0]!.record).toEqual(sharedBefore)
    expect(GraphDraftV2Schema.parse(await tool(client, 'graph_draft_get', { ...scoped(f), draftId: draft.id }))).toEqual(draft)
    await tool(client, 'graph_draft_discard', intentCommand(intent, true))
    expect((await db.pool.query<{ stopped: boolean }>('select stop_requested_at is not null as stopped from runs where id=$1', [run.id])).rows[0]!.stopped).toBe(false)
  })
})
