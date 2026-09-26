import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ManagementActionSchema, ManagementHarnessConfigurationSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { GraphDraftV2Schema, GraphEditReadResultSchema, WorkflowRunV2Schema, WorkflowVersionV2Schema,
  type GraphDraftOperationV2, type GraphEditIntent } from '@graphql/contracts/wave25'
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
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { insertOneShotRun } from '../src/modules/runs/oneShotAdmission.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { agent3Database, seedAgent3, postgresEnabled, ownedAgent3 } from './helpers/wave25Agent3.js'

/** NIM-2644 BE-002/003. Actual persisted grants, browser-session HTTP routes,
 * intent journal, Stop service/coordinator and PostgreSQL receipt rollback.
 * The engine does NOT launch a native provider. Its cancellation completion is
 * synthetic evidence through the real owned saver; this is not native acceptance.
 * Opt in only with the existing isolated loopback PostgreSQL test fixture. */
describe.skipIf(!postgresEnabled)('NIM-2644 BE-002/003 pre-Stop authority and receipt gap', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>, app: ReturnType<typeof buildApp>
  let access: PostgresAccessService, commands: PostgresCommandCoordinator, drafts: GraphDraftService, runs: RunManagementService
  let address: string
  const clients: Client[] = []
  const cancel = vi.fn(async (runId: string) => { expect(runId).toBeTypeOf('string'); return false })
  beforeAll(async () => {
    db = await agent3Database()
    access = new PostgresAccessService(db.pool)
    commands = new PostgresCommandCoordinator(db.pool)
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory)
    const repository = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), locations)
    drafts = new GraphDraftService(db.pool, commands)
    const engine = { start: vi.fn(async () => undefined), cancel } as unknown as LangGraphWorkflowEngine
    runs = new RunManagementService(db.pool, commands, repository, engine, locations)
    const qualifier: HarnessConfigurationQualifier = { async qualify(configuration) {
      return { harness: configuration.harness, version: 'synthetic-no-native-call', authenticated: true, ready: true,
        structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
        supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: ['model'], unsupportedCapabilities: [] }
    } }
    app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { commands, locations, drafts, runs,
        workflows: new WorkflowManagementService(db.pool, commands), agents: new AgentManagementService(db.pool),
        workspaces: new WorkspaceManagementService(db.pool, commands, locations),
        harnesses: new HarnessCatalogService(qualifier, new PostgresSettingsRepository(db.pool), commands, db.directory),
      } } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
    // Fixture-only DDL in agent3Database's random test schema, NOT a migration.
    // This raises INSIDE the receipt transaction, after perform() returned.
    // It is deliberately not an exception thrown after a successful Stop reply.
    await db.pool.query(`create table be003_receipt_fault(command_id text primary key);
      create function be003_fail_receipt() returns trigger language plpgsql as $$
      begin
        if new.operation = 'run.stop' and exists(select 1 from be003_receipt_fault where command_id = new.command_id) then
          raise exception 'BE003 injected BEFORE Stop receipt INSERT/COMMIT';
        end if;
        return new;
      end $$;
      create trigger be003_receipt_fault before insert on management_command_receipts
        for each row execute function be003_fail_receipt()`)
  }, 60000)
  afterAll(async () => {
    for (const client of clients) await client.close().catch(() => undefined)
    await app?.close(); await db?.close()
  })

  async function fixture() {
    const f = await seedAgent3(db.pool, db.directory, undefined, { run: true })
    const grants: ManagementPrincipal['grants'] = [{ actions: ManagementActionSchema.options, scope: { workspaceIds: [f.scope.workspaceId] } }]
    const issued = await access.issue({ name: 'NIM-2644 isolated owner', audience: 'operator', grants,
      expiresAt: new Date(Date.now() + 300_000) })
    const client = new Client({ name: 'nim2644-receipt-authority-fixture', version: '1.0.0' })
    try { await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => issued.token } })) }
    catch (error) { await client.close().catch(() => undefined); throw error }
    clients.push(client)
    const enrollment = await app.inject({ method: 'POST', url: '/api/auth/enroll', headers: { host: 'localhost' }, payload: { token: issued.token } })
    expect(enrollment.statusCode).toBe(200)
    const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(enrollment.headers['set-cookie']).split(';')[0]! }
    const draft = GraphDraftV2Schema.parse(await drafts.open(issued.principal, f.scope.workspaceId, f.scope.workflowId))
    const path = `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/drafts/${draft.id}/edit-intents`
    return { f, issued, grants, headers, draft, path, client }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const advanceInput = (intent: GraphEditIntent) => ({ action: 'stop_and_save' as const, workspaceId: intent.workspaceId,
    workflowId: intent.workflowId, draftId: intent.draftId, intentId: intent.id, commandId: intent.advanceCommandId })
  async function stage(t: Fixture, operations: GraphDraftOperationV2[] = [
    { type: 'node.replace_v2', node: { ...t.draft.graph.nodes[0]!, initialPrompt: 'NIM-2644 exact staged payload' } },
  ]) {
    const response = await app.inject({ method: 'POST', url: t.path, headers: t.headers, payload: {
      action: 'stage_edits', workspaceId: t.f.scope.workspaceId, workflowId: t.f.scope.workflowId,
      draftId: t.draft.id, expectedRevision: t.draft.revision, expectedWorkflowVersionId: t.draft.baseWorkflowVersionId,
      executionSemanticsVersion: 2, commandId: randomUUID(), operations,
    } })
    expect(response.statusCode, response.body).toBe(200)
    return GraphEditReadResultSchema.parse(response.json()).intent!
  }
  const advance = (t: Fixture, intent: GraphEditIntent) => app.inject({ method: 'POST',
    url: `${t.path}/${intent.id}/advance`, headers: t.headers, payload: advanceInput(intent) })
  async function read(t: Fixture, intent: GraphEditIntent) {
    const response = await app.inject({ method: 'GET', url: `${t.path}/${intent.id}`, headers: t.headers })
    expect(response.statusCode, response.body).toBe(200)
    const fromHttp = GraphEditReadResultSchema.parse(response.json())
    const fromMcp = await t.client.callTool({ name: 'graph_draft_get', arguments: { action: 'read_edits',
      workspaceId: intent.workspaceId, workflowId: intent.workflowId, draftId: intent.draftId, intentId: intent.id } })
    expect(fromMcp.isError).not.toBe(true)
    expect(GraphEditReadResultSchema.parse(fromMcp.structuredContent).intent).toEqual(fromHttp.intent)
    return fromHttp
  }
  async function deniedMcp(t: Fixture, intent: GraphEditIntent) {
    const response = await t.client.callTool({ name: 'graph_save', arguments: advanceInput(intent) })
    expect(response.isError).toBe(true)
  }
  async function receipts(t: Fixture) {
    return (await db.pool.query<{ command_id: string; target_key: string; input_hash: string; result: unknown }>(
      `select command_id,target_key,input_hash,result from management_command_receipts
       where principal_id=$1 and operation='run.stop' order by command_id`, [t.issued.principal.id])).rows
  }
  async function publicationCounts(t: Fixture) {
    return (await db.pool.query(`select
      (select count(*)::text from workflow_versions where workspace_id=$1) as versions,
      (select count(*)::text from agent_configuration_versions where workspace_id=$1) as configurations,
      (select count(*)::text from runs where workspace_id=$1) as runs`, [t.f.scope.workspaceId])).rows[0]
  }
  async function runFacts(t: Fixture) {
    return (await db.pool.query(`select id,stop_requested_at,record from runs where workspace_id=$1 order by id`, [t.f.scope.workspaceId])).rows
  }
  async function setGrants(t: Fixture, grants: ManagementPrincipal['grants']) {
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [t.issued.principal.id, JSON.stringify(grants)])
  }
  async function sibling(t: Fixture) {
    const workflowId = randomUUID()
    const version = WorkflowVersionV2Schema.parse({ ...t.f.version, id: randomUUID(), workflowId,
      definition: { ...t.f.version.definition, id: workflowId } })
    const run = WorkflowRunV2Schema.parse({ ...t.f.run, id: randomUUID(), workflowId, workflowVersionId: version.id })
    await db.pool.query('insert into workflows(id,workspace_id,current_version_id,record) values($1,$2,null,$3::jsonb)',
      [workflowId, t.f.scope.workspaceId, JSON.stringify(version.definition)])
    await db.pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
      values($1,$2,$3,1,$4,$5::jsonb,2)`, [version.id, t.f.scope.workspaceId, workflowId, version.entryNodeId, JSON.stringify(version)])
    await db.pool.query('update workflows set current_version_id=$2 where id=$1', [workflowId, version.id])
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) => insertOneShotRun(sql, run)))
    return { ...t.f, scope: { ...t.f.scope, workflowId, runId: run.id }, version, run }
  }
  async function assertNoStop(t: Fixture, intent: GraphEditIntent, before: { runs: unknown; counts: unknown; calls: number }) {
    expect(cancel.mock.calls.length).toBe(before.calls)
    expect(await runFacts(t)).toEqual(before.runs)
    expect(await publicationCounts(t)).toEqual(before.counts)
    expect(await receipts(t)).toEqual([])
    expect((await db.pool.query(`select 1 from management_audit where principal_id=$1 and action='graph.edit_stop_attempt'`,
      [t.issued.principal.id])).rowCount).toBe(0)
    const after = (await read(t, intent)).intent!
    expect(after.stops).toEqual(intent.stops)
    expect(after.stagedDraft).toEqual(intent.stagedDraft)
    expect(after.advanceCommandId).toBe(intent.advanceCommandId)
    expect(after.saveInput).toEqual(intent.saveInput)
  }

  it.each(['graph:edit', 'graph:read'] as const)('BE-002 revoking secondary %s with both Stop grants intact denies before either Run is touched', async (revoked) => {
    const t = await fixture(), other = await sibling(t)
    const intent = await stage(t, [{ type: 'agent.rename', agentId: t.f.configurations[0]!.agentId,
      expectedAgentRevision: 1, name: 'NIM-2644 shared write' }])
    expect(new Set(intent.stops.map((entry) => entry.input.runId))).toEqual(new Set([t.f.run.id, other.run.id]))
    const before = { runs: await runFacts(t), counts: await publicationCounts(t), calls: cancel.mock.calls.length }
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [t.issued.principal.id, JSON.stringify([
      { actions: ManagementActionSchema.options, scope: { workspaceIds: [t.f.scope.workspaceId], workflowIds: [t.f.scope.workflowId] } },
      { actions: ManagementActionSchema.options.filter((action) => action !== revoked),
        scope: { workspaceIds: [t.f.scope.workspaceId], workflowIds: [other.scope.workflowId] } },
    ])])
    const denied = await advance(t, intent)
    expect(denied.statusCode, denied.body).toBe(403)
    await deniedMcp(t, intent)
    await assertNoStop(t, intent, before)
    // Restoration must reuse the staged plan; no replacement identities.
    await setGrants(t, t.grants)
    const retry = await advance(t, intent)
    expect(retry.statusCode, retry.body).toBe(200)
    const result = GraphEditReadResultSchema.parse(retry.json())
    expect(result.intent?.state).toBe('waiting')
    expect(result.intent?.stops.map((entry) => entry.input)).toEqual(intent.stops.map((entry) => entry.input))
    expect(await receipts(t)).toHaveLength(2)
  })

  it.each(['skills:read', 'harnesses:update'] as const)('BE-002 rechecks staged configuration %s before Stop', async (revoked) => {
    const t = await fixture(), agent = t.f.configurations[0]!
    const configuration = revoked === 'harnesses:update'
      ? ManagementHarnessConfigurationSchema.parse({ ...agent.harness, harness: 'codex', sandbox: 'danger-full-access' })
      : ManagementHarnessConfigurationSchema.parse(agent.harness)
    const intent = await stage(t, [{ type: 'agent.configure', agentId: agent.agentId, expectedAgentRevision: 1,
      configuration, ...(revoked === 'skills:read' ? { assignedSkills: [{ skillId: 'synthetic-be002', version: '1' }] } : {}) }])
    const before = { runs: await runFacts(t), counts: await publicationCounts(t), calls: cancel.mock.calls.length }
    await setGrants(t, [{ actions: ManagementActionSchema.options.filter((action) => action !== revoked), scope: { workspaceIds: [t.f.scope.workspaceId] } }])
    const denied = await advance(t, intent)
    expect(denied.statusCode, denied.body).toBe(403)
    await deniedMcp(t, intent)
    await assertNoStop(t, intent, before)
    await setGrants(t, t.grants)
    const retry = await advance(t, intent)
    expect(retry.statusCode, retry.body).toBe(200)
    expect(GraphEditReadResultSchema.parse(retry.json()).intent?.state).toBe('waiting')
    expect((await receipts(t))[0]?.command_id).toBe(intent.stops[0]?.input.commandId)
  })

  it('BE-003 a failed receipt transaction after durable cancellation remains uncertain through settlement and service reconstruction', async () => {
    const t = await fixture(), owned = await ownedAgent3(db.pool, t.f)
    const intent = await stage(t), entry = intent.stops[0]!, before = await publicationCounts(t)
    const stopCalls: Array<Parameters<RunManagementService['stop']>[2]> = []
    const actualStop = runs.stop.bind(runs)
    const stopSpy = vi.spyOn(runs, 'stop').mockImplementation(async (principal, source, input) => {
      stopCalls.push(structuredClone(input)); return actualStop(principal, source, input)
    })
    await db.pool.query('insert into be003_receipt_fault(command_id) values($1)', [entry.input.commandId])
    cancel.mockImplementationOnce(async (runId) => {
      expect(runId).toBe(t.f.run.id)
      // requestStop is already durable, and the real owner settles cancellation.
      await changeOneShotLifecycle(db.pool, runId, { kind: 'cleanup', pending: true })
      await owned.store.settleRun(true)
      return true
    })
    try {
      const first = await advance(t, intent)
      expect(first.statusCode, first.body).toBe(200)
      expect(GraphEditReadResultSchema.parse(first.json()).intent?.state).toBe('uncertain')
      expect((await runFacts(t))[0]).toMatchObject({ record: { executionState: 'completed', outcome: 'canceled' } })
      expect((await runFacts(t))[0]?.stop_requested_at).not.toBeNull()
      // These independently persisted facts prove the exact receipt-gap cut.
      expect(await receipts(t)).toEqual([])
      expect((await db.pool.query(`select 1 from management_audit where principal_id=$1 and action='run.stop'
        and outcome='failed' and details->>'commandId'=$2`, [t.issued.principal.id, entry.input.commandId])).rowCount).toBe(1)
      expect((await db.pool.query(`select details from management_audit where principal_id=$1 and action='graph.edit_stop_attempt'
        and target_key=$2`, [t.issued.principal.id, `edit-intent:${intent.id}`])).rows).toEqual([
        { details: { commandId: entry.input.commandId, inputHash: entry.inputHash, targetKey: `run:${entry.input.runId}` } },
      ])
      await changeOneShotLifecycle(db.pool, t.f.run.id, { kind: 'cleanup', pending: false })
      expect((await read(t, intent)).current.every((item) => item.settled)).toBe(true)
      const resumedService = new GraphDraftService(db.pool, new PostgresCommandCoordinator(db.pool))
      const retry = () => resumedService.editIntents.advance(t.issued.principal, 'http', advanceInput(intent), runs.stop.bind(runs))
      const unresolved = await retry() // the trigger still rejects the SAME receipt
      expect(unresolved.intent?.state).toBe('uncertain')
      expect(unresolved.intent?.stops[0]?.receipt).toBeUndefined()
      expect(await publicationCounts(t)).toEqual(before)
      expect(await receipts(t)).toEqual([])
      // Losing Stop authority after settlement cannot reclassify the attempt.
      await setGrants(t, [{ actions: ManagementActionSchema.options.filter((action) => action !== 'runs:stop'), scope: { workspaceIds: [t.f.scope.workspaceId] } }])
      await expect(retry()).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(stopCalls).toHaveLength(2)
      expect(await publicationCounts(t)).toEqual(before)
      await setGrants(t, t.grants)
      await db.pool.query('delete from be003_receipt_fault where command_id=$1', [entry.input.commandId])
      const saved = await retry()
      expect(saved.intent?.state).toBe('saved')
      expect(stopCalls).toEqual([entry.input, entry.input, entry.input])
      expect(saved.intent?.stops[0]?.receipt).toEqual({ runId: entry.input.runId, status: 'already_terminal', processStopped: false })
      const rows = await receipts(t)
      expect(rows).toEqual([{ command_id: entry.input.commandId, target_key: `run:${entry.input.runId}`,
        input_hash: commandInputHash(entry.input), result: saved.intent!.stops[0]!.receipt }])
      expect((await read(t, intent)).intent).toEqual(saved.intent)
      expect((await retry()).intent).toEqual(saved.intent)
      expect(stopCalls).toHaveLength(3) // a saved replay does not resubmit anything
      expect((await publicationCounts(t)).versions).toBe(String(Number(before.versions) + 1))
      expect((await db.pool.query(`select 1 from management_command_receipts where principal_id=$1 and operation='graph.save' and command_id=$2`,
        [t.issued.principal.id, intent.saveInput.commandId])).rowCount).toBe(1)
    } finally {
      stopSpy.mockRestore(); cancel.mockReset(); cancel.mockImplementation(async () => false)
      await db.pool.query('delete from be003_receipt_fault where command_id=$1', [entry.input.commandId])
      await owned.owner.release()
    }
  })

  it('BE-003 proven natural completion before submission still publishes with no Stop receipt or attempt', async () => {
    const t = await fixture(), owned = await ownedAgent3(db.pool, t.f), intent = await stage(t)
    const calls = cancel.mock.calls.length
    try {
      await owned.store.settleRun(false)
      const response = await advance(t, intent)
      expect(response.statusCode, response.body).toBe(200)
      const saved = GraphEditReadResultSchema.parse(response.json())
      expect(saved.intent?.state).toBe('saved')
      expect(saved.current.every((item) => item.settled)).toBe(true)
      expect(saved.intent?.stops[0]?.receipt).toBeUndefined()
      expect(cancel.mock.calls.length).toBe(calls)
      expect(await receipts(t)).toEqual([])
      expect((await db.pool.query(`select 1 from management_audit where principal_id=$1 and action='graph.edit_stop_attempt'`,
        [t.issued.principal.id])).rowCount).toBe(0)
    } finally { await owned.owner.release() }
  })

  it('BE-003 an advanced pre-tracking intent is not treated as proven natural completion', async () => {
    const t = await fixture(), owned = await ownedAgent3(db.pool, t.f), intent = await stage(t), before = await publicationCounts(t)
    try {
      // Explicit upgrade fixture: old stopping/uncertain records have no proof
      // distinguishing a process death before Stop from one after its effects.
      await db.pool.query(`delete from management_audit where principal_id=$1 and action='graph.edit_stop_tracking' and target_key=$2`,
        [t.issued.principal.id, `edit-intent:${intent.id}`])
      await db.pool.query(`update graph_edit_intents set state='uncertain',record=$2::jsonb where id=$1`,
        [intent.id, JSON.stringify({ ...intent, state: 'uncertain' })])
      await owned.store.settleRun(false)
      const response = await advance(t, intent)
      expect(response.statusCode, response.body).toBe(200)
      expect(GraphEditReadResultSchema.parse(response.json()).intent?.state).toBe('uncertain')
      expect(await publicationCounts(t)).toEqual(before)
      expect(await receipts(t)).toEqual([])
    } finally { await owned.owner.release() }
  })
})
