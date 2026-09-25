import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentSchema } from '@graphql/contracts'
import { ManagementActionSchema, type ManagementGrant } from '@graphql/contracts/management'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  CurrentWorkflowReadResultSchema, SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
  CANONICAL_RUN_GRAPH_MCP_TOOLS, RepeatGraphSnapshotV3Schema, CurrentEditReadResultSchema, type CurrentFixtureForm,
} from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { currentDatabase as agent3Database, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphRpc, graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { insertCurrentRunFixture as insertFixtureRepeatRun } from './helpers/eng04CurrentRunFixture.js'

/** Real migrated PostgreSQL, issued bearer auth, typed writer, command/audit and
 * stateless Operator MCP. The engine below is a FAILING tripwire only for denied
 * admission tests; this suite does not claim native execution or native closure. */
describe.skipIf(!postgresEnabled)('ENG04-B unified current workflow HTTP/MCP', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(form: CurrentFixtureForm = 'sequential') {
    const f = makeCurrentWorkflowFixture(randomUUID(), form)
    const configurations = f.configurations
    // Only workspace/Agent configuration fixtures are seeded. No workflow or
    // immutable v3 version is inserted here; both travel through product HTTP/MCP.
    await db.pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
      values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [f.scope.workspaceId,
    JSON.stringify({ id: f.scope.workspaceId, name: 'Current workflow fixture' }),
    JSON.stringify({ runnerId: 'runner-local', rootPath: db.directory }), JSON.stringify({ fixture: true })])
    for (const config of configurations) {
      const agent = AgentSchema.parse({ id: config.agentId, name: 'Fixture Worker', productRole: config.productRole,
        harness: config.harness.harness, model: config.harness.model, effort: 'low', fastMode: false,
        harnessConfiguration: config.harness, prompt: config.prompt, assignedSkills: config.assignedSkills, configurationVersionId: config.id })
      await db.pool.query('insert into agents(id,workspace_id,record) values($1,$2,$3::jsonb)', [agent.id, f.scope.workspaceId, JSON.stringify(agent)])
      await db.pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
        [config.id, f.scope.workspaceId, config.agentId, JSON.stringify(config)])
      await db.pool.query('update agents set current_configuration_version_id=$2 where id=$1', [agent.id, config.id])
    }
    const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
    const credential = (grants: ManagementGrant[]) => access.issue({ name: 'Current workflow test caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants })
    const writer = await credential([{ actions: ['capabilities:read'], scope: {} }, {
      actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope: { workspaceIds: [f.scope.workspaceId] },
    }])
    const workflows = new WorkflowManagementService(db.pool, commands)
    const locations = new WorkspaceLocationService(db.pool, commands, db.directory, 'runner-local', db.directory)
    const workflowRepository = new PostgresWorkflowRepository(db.pool)
    const repository = new PostgresRunRepository(db.pool, workflowRepository, locations)
    const start = vi.fn(async () => { throw new Error('UNQUALIFIED_NATIVE_START_REACHED') })
    const cancel = vi.fn(async () => { throw new Error('UNQUALIFIED_NATIVE_STOP_REACHED') })
    const runs = new RunManagementService(db.pool, commands, repository, { start, cancel } as unknown as LangGraphWorkflowEngine, locations)
    const services = { workflows, commands, runs,
      runGraph: new RunGraphReadService(db.pool, { qualifiedReads: true }) } as unknown as OperatorServices
    const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    apps.push(app); await app.ready()
    const createInput = { workspaceId: f.scope.workspaceId, commandId: randomUUID(), name: `Current ${form}` }
    const created = await app.inject({ method: 'POST', url: `/api/management/workspaces/${f.scope.workspaceId}/workflows`,
      headers: graphHeaders(writer.token), payload: createInput })
    expect(created.statusCode, created.body).toBe(201)
    const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
    expect(managed.workflow.executionSemanticsVersion).toBe(3)
    expect(Object.hasOwn(managed.workflow, 'repeat')).toBe(false)
    const createReplay = await graphRpc(app, writer.token, 'tools/call', { name: 'workflow_create', arguments: createInput })
    expect(createReplay.result?.isError).not.toBe(true)
    expect(graphRpcValue(createReplay.result)).toMatchObject({ value: managed, replayed: true })
    const graph = { ...f.version.definition, id: managed.workflow.id,
      version: managed.workflow.version, createdAt: managed.workflow.createdAt, updatedAt: managed.workflow.updatedAt,
      name: managed.workflow.name }
    const input = CurrentWorkflowSaveInputSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: managed.workflow.id,
      commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: managed.revision,
      expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: Object.fromEntries(configurations.map((config) => [config.agentId, config.id])),
      expectedLocationRevision: 1, graph })
    const url = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/definition`
    const call = async (name: string, args: unknown, token = writer.token) => graphRpc(app, token, 'tools/call', { name, arguments: args })
    return { app, input, url, writer, access, credential, commands, workflows, call, f, configurations, start, cancel }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const httpSave = (t: Fixture, input = t.input, token = t.writer.token) => t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(token), payload: input })
  async function save(t: Fixture) {
    const result = await httpSave(t); expect(result.statusCode, result.body).toBe(200)
    return CurrentWorkflowSaveResultSchema.parse(result.json())
  }
  async function count(t: Fixture, table: 'workflow_versions' | 'runs') {
    return Number((await db.pool.query<{ n: string }>(`select count(*)::text as n from ${table} where workflow_id=$1`, [t.input.workflowId])).rows[0]!.n)
  }
  it.each(['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat'] as const)('%s uses the same validation, typed save, replay, persisted read and closed Start', async (form) => {
    const t = await fixture(form)
    const { commandId, ...validation } = t.input; void commandId
    const checked = await t.app.inject({ method: 'POST', url: `${t.url}/validate`, headers: graphHeaders(t.writer.token), payload: validation })
    expect(checked.statusCode, checked.body).toBe(200)
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.validate, validation)).result)).toEqual(checked.json())
    expect(await count(t, 'workflow_versions')).toBe(0)
    const saved = await save(t)
    const replay = await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)
    expect(replay.result?.isError).not.toBe(true)
    expect(graphRpcValue(replay.result)).toEqual({ ...saved, replayed: true })
    const http = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(http.statusCode, http.body).toBe(200)
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.saved, { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
    expect(graphRpcValue(remote.result)).toEqual(http.json())
    const read = CurrentWorkflowReadResultSchema.parse(http.json())
    expect(read.version).toEqual(saved.value.version)
    const managedUrl = t.url.replace(/\/definition$/, '')
    const managedHttp = await t.app.inject({ method: 'GET', url: managedUrl, headers: graphHeaders(t.writer.token) })
    expect(managedHttp.statusCode, managedHttp.body).toBe(200)
    const managedMcp = await t.call('workflow_get', { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
    expect(managedMcp.result?.isError).not.toBe(true)
    expect(graphRpcValue(managedMcp.result)).toEqual(managedHttp.json())
    expect(Object.hasOwn(read.version.definition, 'repeat')).toBe(form === 'repeat')
    if (form === 'repeat') expect(read.version.definition.repeat!.blocks).toHaveLength(1)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect((await db.pool.query('select 1 from current_workflow_publications where workflow_version_id=$1', [saved.value.currentVersionId])).rowCount).toBe(1)
    const startInput = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, workflowVersionId: saved.value.currentVersionId,
      executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: saved.value.revision,
      expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds, expectedLocationRevision: 1, input: {} }
    const startUrl = `/api/management/workspaces/${t.input.workspaceId}/workflows/${t.input.workflowId}/runs`
    const httpStart = await t.app.inject({ method: 'POST', url: startUrl, headers: graphHeaders(t.writer.token), payload: startInput })
    expect(httpStart.statusCode).toBe(409)
    expect(httpStart.json()).toMatchObject({ error: { code: 'REPEAT_START_RUNTIME_UNAVAILABLE' } })
    expect(graphRpcValue((await t.call('run_start', startInput)).result)).toMatchObject({ error: { code: 'REPEAT_START_RUNTIME_UNAVAILABLE' } })
    expect(await count(t, 'runs')).toBe(0); expect(t.start).not.toHaveBeenCalled()
  })
  it('publishes through MCP, conflicts on changed command input, and retains exact old versions after a later Save', async () => {
    const t = await fixture()
    const result = await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)
    expect(result.result?.isError).not.toBe(true)
    const first = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(result.result))
    expect(CurrentWorkflowSaveResultSchema.parse((await httpSave(t)).json()).replayed).toBe(true)
    const conflict = await httpSave(t, { ...t.input, graph: { ...t.input.graph, name: 'different input' } })
    expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const next = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, name: 'Next exact immutable version' } }
    const second = CurrentWorkflowSaveResultSchema.parse((await httpSave(t, next)).json())
    expect(second.value.currentVersionId).not.toBe(first.value.currentVersionId)
    const historical = await t.app.inject({ method: 'GET', url: `${t.url}?workflowVersionId=${first.value.currentVersionId}`, headers: graphHeaders(t.writer.token) })
    expect(historical.json()).toMatchObject({ currentVersionId: second.value.currentVersionId, version: first.value.version })
    expect(CurrentWorkflowSaveResultSchema.parse((await httpSave(t)).json())).toEqual({ ...first, replayed: true })
  })
  it('rejects stale revision/version/configuration/location pins without creating an immutable version', async () => {
    const t = await fixture()
    for (const changed of [{ expectedRevision: t.input.expectedRevision + 1 }, { expectedWorkflowVersionId: 'wrong-version' },
      { expectedAgentConfigurationVersionIds: {} }, { expectedLocationRevision: 2 }]) {
      const input = { ...t.input, ...changed, commandId: randomUUID() }
      const http = await httpSave(t, input)
      expect(http.statusCode).toBe(409)
      const remote = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(remote.result?.isError).toBe(true)
    }
    expect(await count(t, 'workflow_versions')).toBe(0)
  })
  it('denies read-only, wrong-scope, revoked and missing callers; both transports audit denied writes', async () => {
    const t = await fixture()
    const readonly = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    const wrong = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['wrong'] } }])
    const tools = await graphRpc(t.app, readonly.token, 'tools/list')
    expect(tools.result?.tools?.map((tool) => tool.name)).not.toContain(CURRENT_WORKFLOW_TOOLS.save)
    for (const caller of [readonly, wrong]) {
      expect((await httpSave(t, t.input, caller.token)).statusCode).toBe(403)
      expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input, caller.token)).result?.isError).toBe(true)
      const audit = (await db.pool.query('select source,outcome from management_audit where principal_id=$1', [caller.principal.id])).rows
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'http', outcome: 'denied' }), expect.objectContaining({ source: 'mcp', outcome: 'denied' })]))
    }
    expect((await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(), payload: t.input })).statusCode).toBe(401)
    await t.access.revoke(t.writer.principal.id)
    expect((await httpSave(t)).statusCode).toBe(401)
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)).status).toBe(401)
    expect(await count(t, 'workflow_versions')).toBe(0)
  })
  it.each(['sequential', 'parallel', 'repeat'] as const)('%s stages/reopens/replays a full definition and preserves later layout during atomic Save', async (form) => {
    const t = await fixture(form), first = await save(t)
    const stage = { ...t.input, action: 'stage_edits' as const, draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...first.value.version.definition, nodes: first.value.version.definition.nodes.map((node, index) =>
        index === 0 ? { ...node, name: 'Staged node label' } : node) } }
    const http = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(http.statusCode, http.body).toBe(200)
    const staged = CurrentEditReadResultSchema.parse(http.json()), intent = staged.intent!
    expect(intent.kind).toBe('current'); expect(intent.state).toBe('staged')
    expect(intent.stops).toEqual([]); expect(await count(t, 'workflow_versions')).toBe(1)
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).toEqual(staged)
    const scope = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId, intentId: intent.id }
    const reopen = await t.app.inject({ method: 'GET', url: `${t.url}/edits?draftId=${scope.draftId}&intentId=${scope.intentId}`, headers: graphHeaders(t.writer.token) })
    expect(reopen.statusCode, reopen.body).toBe(200)
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' })).result)).toEqual(reopen.json())
    const direct = await httpSave(t, intent.saveInput)
    expect(direct.statusCode).toBe(409); expect(direct.json()).toMatchObject({ error: { code: 'GRAPH_EDIT_USE_INTENT' } })
    const layout = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition,
        nodes: first.value.version.definition.nodes.map((node) => ({ ...node, position: { x: 103, y: 207 } })) } }
    const moved = CurrentWorkflowSaveResultSchema.parse((await httpSave(t, layout)).json())
    expect(moved.value.revision).toBe(first.value.revision); expect(moved.value.currentVersionId).toBe(first.value.currentVersionId)
    const advance = { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId }
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)
    expect(remote.result?.isError).not.toBe(true)
    const finished = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result))
    expect(finished.intent?.state, JSON.stringify(finished.intent?.error)).toBe('saved')
    expect(finished.intent?.result?.version.definition.nodes[0]).toMatchObject({ name: 'Staged node label', position: { x: 103, y: 207 } })
    const retried = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })
    expect(retried.statusCode, retried.body).toBe(200); expect(retried.json()).toEqual(finished)
    expect(await count(t, 'workflow_versions')).toBe(2)
    expect((await db.pool.query(`select 1 from management_command_receipts where principal_id=$1
      and operation='workflow.save.v3' and command_id=$2`, [t.writer.principal.id, intent.saveInput.commandId])).rowCount).toBe(1)
    expect(t.start).not.toHaveBeenCalled(); expect(t.cancel).not.toHaveBeenCalled()
  })
  it('full-definition Discard preserves the saved head and exact command conflicts; another caller cannot read a private intent', async () => {
    const t = await fixture(), first = await save(t)
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...first.value.version.definition, name: 'Private unsaved label' } }
    const result = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(result.result?.isError).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(result.result)).intent!
    const scope = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId, intentId: intent.id }
    const other = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' }, other.token)).result?.isError).toBe(true)
    const changed = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...scope, action: 'discard_edits', commandId: randomUUID() })
    expect(graphRpcValue(changed.result)).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const discard = { ...scope, action: 'discard_edits', commandId: intent.discardCommandId }
    const dropped = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: discard })
    expect(dropped.statusCode, dropped.body).toBe(200); expect(dropped.json().intent.state).toBe('discarded')
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, discard)).result)).toEqual(dropped.json())
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.saved,
      { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result)).version).toEqual(first.value.version)
    expect(t.cancel).not.toHaveBeenCalled()
  })
  it.each(['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat'] as const)('%s persisted canonical read uses typed Save + repeatStartPublication, not native admission', async (form) => {
    const t = await fixture(form), saved = await save(t)
    const accepted = await insertFixtureRepeatRun(db.pool, { ...t.f, configurations: t.configurations, run: { ...t.f.run,
      workflowId: t.input.workflowId, createdAt: new Date().toISOString(), agentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds,
      approval: saved.value.version.approval,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` },
    } }, saved.value, t.writer.principal.id, { input: { privateCanary: 'CURRENT-PRIVATE-INPUT' } })
    const request = { protocolVersion: 1, scope: accepted.scope }
    const reader = await t.credential([{ actions: ['runs:read'], scope: { workspaceIds: [t.input.workspaceId], workflowIds: [t.input.workflowId] } }])
    const query = new URLSearchParams({ workflowVersionId: accepted.version.id, executionSemanticsVersion: '3' })
    const root = `/api/workspaces/${t.input.workspaceId}/workflows/${t.input.workflowId}/runs/${accepted.run.id}/graph/v1`
    for (const kind of ['snapshot', 'current', 'events'] as const) {
      const args = { ...request, ...(kind === 'events' ? { afterSequence: '0' } : {}) }
      const url = `${root}/${kind}?${query}${kind === 'events' ? '&afterSequence=0' : ''}`
      const http = await t.app.inject({ method: 'GET', url, headers: graphHeaders(reader.token) })
      expect(http.statusCode, http.body).toBe(200)
      const remote = await t.call(CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], args, reader.token)
      expect(remote.result?.isError).not.toBe(true); expect(graphRpcValue(remote.result)).toEqual(http.json())
      expect(http.body).not.toContain('CURRENT-PRIVATE-INPUT'); expect(http.body).not.toContain(db.directory)
      expect(http.body).not.toContain(t.writer.token); expect(http.body).not.toContain(t.writer.principal.id)
    }
    const baseline = RepeatGraphSnapshotV3Schema.parse(graphRpcValue((await t.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, request, reader.token)).result))
    expect(baseline.state.occurrences).toEqual([]); expect(baseline.asOfSequence).toBe('1')
    expect(Object.hasOwn(accepted.run, 'repeat')).toBe(false)
    if (form !== 'repeat') {
      expect(Object.hasOwn(saved.value.version.definition, 'repeat')).toBe(false)
      expect(Object.hasOwn(baseline.topology, 'repeat')).toBe(false)
    }
    const stored = (await db.pool.query('select record from runs where id=$1', [accepted.run.id])).rows[0].record
    expect(Object.hasOwn(stored, 'repeat')).toBe(false)
    const detailUrl = `/api/management/workspaces/${t.input.workspaceId}/runs/${accepted.run.id}`
    const detailHttp = await t.app.inject({ method: 'GET', url: detailUrl, headers: graphHeaders(reader.token) })
    expect(detailHttp.statusCode, detailHttp.body).toBe(200)
    const detailMcp = await t.call('run_get', { workspaceId: t.input.workspaceId, runId: accepted.run.id }, reader.token)
    expect(detailMcp.result?.isError).not.toBe(true)
    expect(graphRpcValue(detailMcp.result)).toEqual(detailHttp.json())
    expect(detailHttp.json().run.executionSemanticsVersion).toBe(3)
    expect(Object.hasOwn(detailHttp.json().run, 'repeat')).toBe(false)
    expect(Object.hasOwn(detailHttp.json().run, 'authorizationPrincipalId')).toBe(false)
    expect(Object.hasOwn(detailHttp.json().run, 'executionLocation')).toBe(false)
    const move = { ...t.input, commandId: randomUUID(), expectedRevision: saved.value.revision,
      expectedWorkflowVersionId: saved.value.currentVersionId, graph: { ...saved.value.version.definition,
        nodes: saved.value.version.definition.nodes.map((node) => ({ ...node, position: { x: 81, y: 92 } })) } }
    const moved = await httpSave(t, move)
    expect(moved.statusCode, moved.body).toBe(200)
    expect(CurrentWorkflowSaveResultSchema.parse(moved.json()).value.currentVersionId).toBe(saved.value.currentVersionId)
    expect(await count(t, 'workflow_versions')).toBe(1)
    const meaningful = { ...move, commandId: randomUUID(), expectedRevision: moved.json().value.revision,
      graph: { ...move.graph, nodes: move.graph.nodes.map((node) => ({ ...node, name: 'Meaningful change' })) } }
    expect((await httpSave(t, meaningful)).statusCode).toBe(409)
    const stop = { workspaceId: t.input.workspaceId, runId: accepted.run.id, commandId: randomUUID() }
    expect(graphRpcValue((await t.call('run_stop', stop)).result)).toMatchObject({ error: { code: 'REPEAT_STOP_RUNTIME_UNAVAILABLE' } })
    expect(t.cancel).not.toHaveBeenCalled()
    const stage = { ...meaningful, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID() }
    const staged = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(staged.result?.isError).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
    expect(intent.stops).toHaveLength(1)
    const advance = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId,
      intentId: intent.id, commandId: intent.advanceCommandId, action: 'stop_and_save' }
    const blocked = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json()).toMatchObject({ intent: { state: 'blocked', error: { code: 'REPEAT_STOP_RUNTIME_UNAVAILABLE', uncertain: false } } })
    expect(blocked.json().intent.saveInput).toEqual(intent.saveInput)
    expect(blocked.json().intent.stops).toEqual(intent.stops)
    expect((await db.pool.query(`select 1 from management_command_receipts where principal_id=$1
      and operation='run.stop' and command_id=$2`, [t.writer.principal.id, intent.stops[0]!.input.commandId])).rowCount).toBe(0)
    expect((await db.pool.query(`select 1 from management_audit where principal_id=$1 and action='graph.edit_stop_attempt'
      and target_key=$2`, [t.writer.principal.id, `edit-intent:${intent.id}`])).rowCount).toBe(0)
    expect(await count(t, 'workflow_versions')).toBe(1); expect(t.cancel).not.toHaveBeenCalled()
    await t.access.revoke(t.writer.principal.id)
    expect(graphRpcValue((await t.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, request, reader.token)).result)).toEqual(baseline)
  })
  it('adding then removing repeat preserves ordinary omission and immutable older versions', async () => {
    const t = await fixture('repeat')
    const { repeat, ...ordinary } = t.input.graph
    expect(repeat).toBeDefined()
    const first = CurrentWorkflowSaveResultSchema.parse((await httpSave(t, { ...t.input, graph: ordinary })).json())
    expect(Object.hasOwn(first.value.version.definition, 'repeat')).toBe(false)
    const repeated = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, repeat } }
    const secondRpc = await t.call(CURRENT_WORKFLOW_TOOLS.save, repeated)
    expect(secondRpc.result?.isError).not.toBe(true)
    const second = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(secondRpc.result))
    const { repeat: removed, ...without } = second.value.version.definition; void removed
    const finalInput = { ...t.input, commandId: randomUUID(), expectedRevision: second.value.revision,
      expectedWorkflowVersionId: second.value.currentVersionId, graph: without }
    const finalHttp = await httpSave(t, finalInput)
    expect(finalHttp.statusCode, finalHttp.body).toBe(200)
    const third = CurrentWorkflowSaveResultSchema.parse(finalHttp.json())
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.saved, { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
    expect(Object.hasOwn(CurrentWorkflowReadResultSchema.parse(graphRpcValue(remote.result)).version.definition, 'repeat')).toBe(false)
    const rows = (await db.pool.query('select record from workflow_versions where workflow_id=$1 order by version', [t.input.workflowId])).rows
    expect(rows.map((row) => Object.hasOwn(row.record.definition, 'repeat'))).toEqual([false, true, false])
    expect(rows.map((row) => row.record)).toEqual([first.value.version, second.value.version, third.value.version])
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, finalInput)).result)).toEqual({ ...third, replayed: true })
  })
  it('retired/unknown tags and empty/null plans fail on both authenticated transports without publication', async () => {
    const t = await fixture()
    for (const tag of [1, 2, 4, '3', null]) {
      const input = { ...t.input, executionSemanticsVersion: tag, commandId: randomUUID() }
      const http = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: input })
      expect(http.statusCode).toBe(400)
      const remote = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(remote.error !== undefined || remote.result?.isError === true).toBe(true)
    }
    for (const repeat of [null, { contractVersion: 1, blocks: [] }, { contractVersion: 2, blocks: [] }]) {
      const input = { ...t.input, commandId: randomUUID(), graph: { ...t.input.graph, repeat } }
      expect((await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: input })).statusCode).toBe(400)
      const remote = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(remote.error !== undefined || remote.result?.isError === true).toBe(true)
    }
    expect(await count(t, 'workflow_versions')).toBe(0)
    expect(await count(t, 'runs')).toBe(0)
    expect(t.start).not.toHaveBeenCalled(); expect(t.cancel).not.toHaveBeenCalled()
  })

})
