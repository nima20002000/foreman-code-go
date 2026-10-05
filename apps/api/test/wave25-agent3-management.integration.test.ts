import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSchema } from '@foreman-code/contracts'
import { ManagementActionSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema,
  CurrentWorkflowReadResultSchema, SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture,
  CurrentEditReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { currentDatabase as agent3Database, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphRpc, graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { insertCurrentRunFixture as insertFixtureRepeatRun } from './helpers/eng04CurrentRunFixture.js'

/** Ports management invariants to current definitions and private edit intents.
 * V1/V2 migration, Apply/revert and legacy node-copy scenarios were compatibility-only.
 * Every test owns a migrated schema. Real issued bearer auth, typed writer, command/audit and
 * stateless Operator MCP. The engine below is a FAILING tripwire only for denied
 * admission tests; this suite does not claim native execution or native closure. */
describe.skipIf(!postgresEnabled)('Current authenticated management editing parity', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const apps: ReturnType<typeof buildApp>[] = []
  beforeEach(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    await db?.close()
  })
  async function fixture(form: 'single' | 'sequential' = 'sequential') {
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
    const repository = new PostgresRunRepository(db.pool, workflowRepository, locations, { runtimeRoot: db.directory,
      ...createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify) })
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
  it('persists repeated Agent nodes over MCP and HTTP with one exact immutable configuration', async () => {
    const t = await fixture()
    const input = structuredClone(t.input)
    const [first, second] = input.graph.nodes
    if (!first || !second || first.kind === 'job' || second.kind === 'job') throw new Error('Two Agent nodes expected')
    delete input.expectedAgentConfigurationVersionIds[second.agentId]
    second.agentId = first.agentId
    input.graph.requiredAgentCount = 1
    const saved = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
    expect(saved.result?.isError).not.toBe(true)
    const value = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(saved.result)).value
    expect(value.version.definition.nodes.map((node) => node.id)).toEqual([first.id, second.id])
    expect(value.version.agentConfigurationVersionIds).toEqual(input.expectedAgentConfigurationVersionIds)
    expect(CurrentWorkflowSaveResultSchema.parse((await httpSave(t, input)).json()).replayed).toBe(true)
    const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
    const read = await t.call(CURRENT_WORKFLOW_TOOLS.saved, scope)
    expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue(read.result)).version).toEqual(value.version)
    const http = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(http.statusCode, http.body).toBe(200)
    expect(CurrentWorkflowReadResultSchema.parse(http.json()).version).toEqual(value.version)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(await count(t, 'runs')).toBe(0)
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
    expect((await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders('invalid'), payload: t.input })).statusCode).toBe(401)
    await t.access.revoke(t.writer.principal.id)
    expect((await httpSave(t)).statusCode).toBe(401)
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)).status).toBe(401)
    expect(await count(t, 'workflow_versions')).toBe(0)
  })
  async function agentStage(t: Fixture, first: Awaited<ReturnType<typeof save>>) {
    const original = (await db.pool.query('select record,metadata_revision::text from agents where id=$1', [t.configurations[0]!.agentId])).rows[0]!
    const agent = AgentSchema.parse(original.record)
    return { ...t.input, action: 'stage_edits' as const, draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: first.value.version.definition, stagedAgents: [{ agent: { ...agent, name: 'Private new name',
        prompt: { ...agent.prompt, system: 'Use the staged instructions.' } }, baseRevision: Number(original.metadata_revision) }] }
  }
  it('MCP stages Agent configuration privately then atomically publishes exact resulting snapshots, and HTTP replay does not write twice', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const before = (await db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]
    const staged = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(staged.result?.isError, JSON.stringify(staged)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
    expect(intent.saveInput.expectedAgentConfigurationVersionIds).toEqual(stage.expectedAgentConfigurationVersionIds)
    expect(intent.saveInput.resultantAgentConfigurationVersionIds?.[stage.stagedAgents[0]!.agent.id]).not.toBe(stage.stagedAgents[0]!.agent.configurationVersionId)
    expect((await db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]).toEqual(before)
    const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id,
      action: 'stop_and_save', commandId: intent.advanceCommandId }
    const execute = t.commands.execute.bind(t.commands)
    vi.spyOn(t.commands, 'execute').mockImplementationOnce(async (request) => {
      await execute(request)
      throw new Error('SIMULATED_LOST_REPLY_AFTER_COMMIT')
    })
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)
    const finished = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result))
    expect(finished.intent?.state, JSON.stringify(finished.intent?.error)).toBe('saved')
    expect(finished.intent?.result?.agents).toHaveLength(1)
    const snapshot = finished.intent!.result!.agents![0]!
    expect(snapshot.agent.name).toBe('Private new name')
    expect(snapshot.metadataRevision).toBe(stage.stagedAgents[0]!.baseRevision + 1)
    expect(finished.intent!.result!.version.agentConfigurationVersionIds).toEqual(intent.saveInput.resultantAgentConfigurationVersionIds)
    const persisted = (await db.pool.query('select record,metadata_revision::text from agents where id=$1', [snapshot.agent.id])).rows[0]!
    expect(persisted.record).toEqual(snapshot.agent); expect(Number(persisted.metadata_revision)).toBe(snapshot.metadataRevision)
    const retry = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })
    expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toEqual(finished)
    const read = await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...advance, action: 'read_edits', commandId: undefined })
    expect(graphRpcValue(read.result)).toEqual(finished)
    expect(await count(t, 'workflow_versions')).toBe(2)
    expect((await db.pool.query('select 1 from agent_configuration_versions where agent_id=$1', [snapshot.agent.id])).rowCount).toBe(2)
  })
  it('active Run Stage and Discard never mutate Agents or stop the Run; unqualified Stop retains the same payload', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    const accepted = await insertFixtureRepeatRun(db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, first.value, t.writer.principal.id)
    const original = (await db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]
    const staged = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(staged.result?.isError, JSON.stringify(staged)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
    expect(intent.affected.map((pin) => pin.runId)).toEqual([accepted.run.id])
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    const advance = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId })
    expect(CurrentEditReadResultSchema.parse(graphRpcValue(advance.result)).intent).toMatchObject({ state: 'blocked', saveInput: intent.saveInput })
    const discard = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...scope, action: 'discard_edits', commandId: intent.discardCommandId })
    expect(CurrentEditReadResultSchema.parse(graphRpcValue(discard.result)).intent?.state).toBe('discarded')
    expect((await db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]).toEqual(original)
    expect((await db.pool.query('select execution_state,stop_requested_at from runs where id=$1', [accepted.run.id])).rows[0]).toMatchObject({ execution_state: 'queued', stop_requested_at: null })
    expect(t.cancel).not.toHaveBeenCalled(); expect(await count(t, 'workflow_versions')).toBe(1)
  })
  it('a changed Agent metadata head after Stage blocks publication and preserves original payload and pins', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    await db.pool.query('update agents set metadata_revision=metadata_revision+1 where id=$1', [stage.stagedAgents[0]!.agent.id])
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { workspaceId: stage.workspaceId, workflowId: stage.workflowId,
      draftId: stage.draftId, intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId })
    const blocked = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result)).intent!
    expect(blocked).toMatchObject({ state: 'blocked', error: { code: 'AGENT_REVISION_CONFLICT' }, saveInput: intent.saveInput,
      agentPins: intent.agentPins, stops: intent.stops })
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect((await db.pool.query('select 1 from agent_configuration_versions where agent_id=$1', [stage.stagedAgents[0]!.agent.id])).rowCount).toBe(1)
  })
  it('staged shared Agent edits include exact affected Runs and location pins from another workflow', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    const created = await t.app.inject({ method: 'POST', url: `/api/management/workspaces/${stage.workspaceId}/workflows`,
      headers: graphHeaders(t.writer.token), payload: { workspaceId: stage.workspaceId, commandId: randomUUID(), name: 'Other workflow' } })
    const other = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
    const otherInput = { ...t.input, workflowId: other.workflow.id, commandId: randomUUID(), expectedRevision: other.revision,
      graph: { ...t.input.graph, id: other.workflow.id, version: other.workflow.version,
        createdAt: other.workflow.createdAt, updatedAt: other.workflow.updatedAt, name: other.workflow.name } }
    const otherSaved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, otherInput)).result)).value
    const accepted = await insertFixtureRepeatRun(db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, otherSaved, t.writer.principal.id)
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(remote.result?.isError, JSON.stringify(remote)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result)).intent!
    expect(intent.affected).toHaveLength(1)
    expect(intent.affected[0]).toMatchObject({ runId: accepted.run.id, workflowId: other.workflow.id })
    expect(intent.stagedDraft.runLocationPins.map((pin) => pin.runId)).toEqual([accepted.run.id])
    expect(intent.stops[0]!.input.runId).toBe(accepted.run.id)
  })
  it('MCP rejects a missing Agent mutation grant and stale displayed metadata before Stage', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const denied = await t.credential([{ actions: ManagementActionSchema.options.filter((action) => action !== 'agents:update'), scope: { workspaceIds: [stage.workspaceId] } }])
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, denied.token)
    expect(graphRpcValue(remote.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const stale = { ...stage, stagedAgents: stage.stagedAgents.map((item) => ({ ...item, baseRevision: item.baseRevision + 1 })) }
    const http = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stale })
    expect(http.statusCode, http.body).toBe(409); expect(http.json()).toMatchObject({ error: { code: 'AGENT_REVISION_CONFLICT' } })
    expect((await db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [stage.workflowId])).rowCount).toBe(0)
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

  it('serializes concurrent Saves at the displayed version and replays the winning exact command', async () => {
    const t = await fixture(), first = await save(t)
    const candidates = ['First writer', 'Second writer'].map((name) => ({ ...t.input, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...first.value.version.definition, name } }))
    const replies = await Promise.all(candidates.map((input) => httpSave(t, input)))
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409])
    const winnerIndex = replies.findIndex((reply) => reply.statusCode === 200)
    const winner = CurrentWorkflowSaveResultSchema.parse(replies[winnerIndex]!.json())
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, candidates[winnerIndex]!)).result)).toEqual({ ...winner, replayed: true })
    const rows = (await db.pool.query('select record from workflow_versions where workflow_id=$1 order by version', [t.input.workflowId])).rows
    expect(rows.map((row) => row.record)).toEqual([first.value.version, winner.value.version])
  })
  it('a private Stage prevents an intervening meaningful Save from changing its accepted base', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    const next = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, name: 'Concurrent saved head' } }
    const rejected = await httpSave(t, next)
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ error: { code: 'WORKFLOW_EDITS_UNRESOLVED' } })
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, next)).result)).toMatchObject({ error: { code: 'WORKFLOW_EDITS_UNRESOLVED' } })
    const read = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(CurrentWorkflowReadResultSchema.parse(read.json()).version).toEqual(first.value.version)
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    const reopened = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' })).result)).intent!
    expect(reopened.saveInput).toEqual(intent.saveInput)
    expect(reopened.agentPins).toEqual(intent.agentPins)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(t.cancel).not.toHaveBeenCalled()
  })
  it('active meaningful edits retain exact Stop plans across transport retries without fabricated receipts', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    const accepted = await insertFixtureRepeatRun(db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, first.value, t.writer.principal.id)
    const before = (await db.pool.query('select record,stop_requested_at from runs where id=$1', [accepted.run.id])).rows[0]
    const direct = await httpSave(t, { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, name: 'Active meaningful edit' } })
    expect(direct.statusCode).toBe(409)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    expect(intent.affected).toHaveLength(1)
    expect(intent.affected[0]).toMatchObject({ runId: accepted.run.id, workflowVersionId: first.value.currentVersionId,
      agentConfigurationVersionIds: first.value.version.agentConfigurationVersionIds })
    const advance = { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId }
    for (const reply of [
      graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result),
      (await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })).json(),
    ]) {
      expect(CurrentEditReadResultSchema.parse(reply).intent).toMatchObject({ state: 'blocked',
        error: { code: 'REPEAT_STOP_RUNTIME_UNAVAILABLE', uncertain: false }, saveInput: intent.saveInput, stops: intent.stops })
    }
    expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'", [t.writer.principal.id])).rowCount).toBe(0)
    const discard = { ...scope, action: 'discard_edits', commandId: intent.discardCommandId }
    const dropped = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, discard)).result))
    expect(dropped.intent?.state).toBe('discarded')
    expect((await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: discard })).json()).toEqual(dropped)
    expect((await db.pool.query('select record,stop_requested_at from runs where id=$1', [accepted.run.id])).rows[0]).toEqual(before)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(t.cancel).not.toHaveBeenCalled(); expect(t.start).not.toHaveBeenCalled()
  })
  it('denies worker credentials and revalidates withdrawn Stop grants before any intent effect', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    await insertFixtureRepeatRun(db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, first.value, t.writer.principal.id)
    const worker = await t.access.issue({ name: 'Worker has no management authority', audience: 'worker', agentId: t.configurations[0]!.agentId,
      grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 300000) })
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, worker.token)).status).toBe(403)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [t.writer.principal.id,
      JSON.stringify([{ actions: ManagementActionSchema.options.filter((action) => action !== 'runs:stop'), scope: { workspaceIds: [stage.workspaceId] } }])])
    const advance = { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId }
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result?.isError).toBe(true)
    expect((await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })).statusCode).toBe(403)
    const read = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' })).result))
    expect(read.intent?.saveInput).toEqual(intent.saveInput)
    expect(read.intent?.stops).toEqual(intent.stops)
    expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'", [t.writer.principal.id])).rowCount).toBe(0)
    expect(t.cancel).not.toHaveBeenCalled(); expect(await count(t, 'workflow_versions')).toBe(1)
  })
  it('location drift blocks the private publication while preserving its original displayed location pin', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    await db.pool.query('update workspaces set location_revision=location_revision+1 where id=$1', [stage.workspaceId])
    const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
      intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
    const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })
    expect(response.statusCode, response.body).toBe(200)
    const blocked = CurrentEditReadResultSchema.parse(response.json()).intent!
    expect(blocked.state).toBe('blocked')
    expect(blocked.error?.code).toBe('CURRENT_EDIT_LOCATION_CONFLICT')
    expect(blocked.saveInput).toEqual(intent.saveInput)
    expect(blocked.stagedDraft).toEqual(intent.stagedDraft)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(t.cancel).not.toHaveBeenCalled()
  })
})
