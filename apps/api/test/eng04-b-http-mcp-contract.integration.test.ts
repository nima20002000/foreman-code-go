import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@graphql/contracts/management'
import {
  RepeatEditReadResultSchema, RepeatSaveResultSchema, RepeatRunReadbackSchema,
  type RepeatSaveInput, type RepeatEditStageInput,
} from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { createRepeatServices } from '../src/modules/repeats/composition.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue, type GraphTestDatabase } from './eng04-graph-composition-fixture.js'

/** REAL typed writer, PostgreSQL, principals, command coordinator, repeat/edit
 * services, Run repository and RunManagementService over BOTH authenticated
 * transports. The native object is a rejection trap, ONLY for negative gates.
 * It has no successful response and is not native Start/Stop/cleanup evidence.
 * Qualified positive lifecycle/replay belongs to A's real native gate suite.
 */
describe.skipIf(!postgresEnabled)('ENG04-B HTTP/Operator authoring and closed native admission', () => {
  let db: GraphTestDatabase
  const fixtures: Array<{ app: { close(): Promise<void> } }> = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })

  async function fixture(insertRun = false) {
    // This helper already saves via authenticated eng04_publish_repeat_workflow
    // and uses insertRepeatRun + repeatStartPublication, never raw v3 publication.
    const t = await graphFixture(db, { insert: insertRun, qualifiedReads: true })
    await t.app.close()
    // Start/Stage read location authority at WORKSPACE scope. The graph fixture
    // publisher has workflow-scoped grants; explicitly issue the additional
    // workspace-location grant rather than weakening the production policy.
    const writer = await t.credential([{ actions: ['capabilities:read'], scope: {} }, {
      actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope: t.grantScope,
    }, { actions: ['workspace_locations:read'], scope: { workspaceIds: [t.scope.workspaceId] } }])
    const nativeCalls: string[] = []
    const forbidden = (name: string) => () => {
      nativeCalls.push(name)
      throw new Error(`Negative admission test unexpectedly dispatched native ${name}`)
    }
    const native = { start: forbidden('start'), cancel: forbidden('cancel'), finishRunLifecycle: forbidden('finishRunLifecycle') }
    const locations = new WorkspaceLocationService(db.pool, t.commands, db.directory, 'local', db.directory)
    const repository = new PostgresRunRepository(db.pool, new PostgresWorkflowRepository(db.pool), locations)
    const runs = new RunManagementService(db.pool, t.commands, repository, native as unknown as LangGraphWorkflowEngine, locations)
    const repeats = createRepeatServices(db.pool, t.commands)
    const services = { commands: t.commands, repeats, runGraph: t.graph, runs } as unknown as OperatorServices
    const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
      checkpoints: { ping: async () => undefined } }, operator: { access: t.access, services } })
    await app.ready()
    const value = { ...t, writer, app, runs, repeats, nativeCalls }
    fixtures.push(value)
    return value
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const scope = (t: Fixture) => ({ workspaceId: t.scope.workspaceId, workflowId: t.scope.workflowId })
  const repeatUrl = (t: Fixture) => `/api/management/workspaces/${t.scope.workspaceId}/workflows/${t.scope.workflowId}/repeat`
  const startUrl = (t: Fixture) => `/api/management/workspaces/${t.scope.workspaceId}/workflows/${t.scope.workflowId}/runs`
  const stopUrl = (t: Fixture) => `/api/management/workspaces/${t.scope.workspaceId}/runs/${t.scope.runId}/stop`
  const call = async (t: Fixture, name: string, args: unknown, token = t.writer.token) => {
    const response = await graphRpc(t.app, token, 'tools/call', { name, arguments: args })
    return { ...response, value: graphRpcValue(response.result) }
  }
  const saveInput = (t: Fixture, cap = 2): RepeatSaveInput => ({ ...scope(t), commandId: randomUUID(),
    expectedRevision: t.accepted.snapshot.workflow.revision, expectedWorkflowVersionId: t.version.id,
    executionSemanticsVersion: 3, repeat: { ...t.version.definition.repeat,
      blocks: t.version.definition.repeat.blocks.map((block) => ({ ...block, maxOccurrences: cap })) } })
  const stageInput = (t: Fixture): RepeatEditStageInput => ({ ...saveInput(t), action: 'stage_edits', draftId: `editor-${randomUUID()}`,
    expectedAgentConfigurationVersionIds: t.version.agentConfigurationVersionIds, expectedLocationRevision: t.run.executionLocation.locationRevision })
  const versions = async (t: Fixture) => Number((await db.pool.query('select count(*)::text as n from workflow_versions where workflow_id=$1', [t.scope.workflowId])).rows[0]!.n)
  const receipts = async (t: Fixture, operation: string) => (await db.pool.query(
    'select command_id,input_hash,target_key,result from management_command_receipts where principal_id=$1 and operation=$2 order by command_id',
    [t.writer.principal.id, operation])).rows

  it('saves an existing v3 plan through MCP, replays via HTTP, rejects command conflicts, and reads the persisted version on both', async () => {
    const t = await fixture(), input = saveInput(t), before = await versions(t)
    const saved = await call(t, 'repeat_update', input)
    expect(saved.result?.isError, JSON.stringify(saved.value)).not.toBe(true)
    const value = RepeatSaveResultSchema.parse(saved.value)
    expect(value.replayed).toBe(false)
    expect(value.value.currentVersionId).not.toBe(t.version.id)
    expect(value.value.version.agentConfigurationVersionIds).toEqual(t.version.agentConfigurationVersionIds)
    const replay = await t.app.inject({ method: 'PUT', url: repeatUrl(t), headers: graphHeaders(t.writer.token), payload: input })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(RepeatSaveResultSchema.parse(replay.json())).toEqual({ ...value, replayed: true })
    const conflict = await call(t, 'repeat_update', { ...saveInput(t, 1), commandId: input.commandId })
    expect(conflict.value).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const stale = await call(t, 'repeat_update', { ...input, commandId: randomUUID() })
    expect(stale.value).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
    const http = await t.app.inject({ method: 'GET', url: repeatUrl(t), headers: graphHeaders(t.writer.token) })
    const mcp = await call(t, 'repeat_get', scope(t))
    expect(http.statusCode).toBe(200)
    expect(mcp.value).toEqual(http.json())
    expect(http.json()).toMatchObject({ revision: value.value.revision, currentVersionId: value.value.currentVersionId,
      version: { definition: { repeat: input.repeat } } })
    expect(await versions(t)).toBe(before + 1)
    expect((await receipts(t, 'repeat.save')).filter((item) => item.command_id === input.commandId)).toHaveLength(1)
    expect((await db.pool.query(`select source,outcome from management_audit where principal_id=$1 and action='repeat.save' and details->>'commandId'=$2`,
      [t.writer.principal.id, input.commandId])).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'mcp', outcome: 'succeeded' }), expect.objectContaining({ source: 'mcp', outcome: 'failed' }),
    ]))
    expect(t.nativeCalls).toEqual([])
  })

  it('validates exact Stage version/revision/configuration/location pins without a publication or native side effect', async () => {
    const t = await fixture(), before = await versions(t)
    const cases = [
      { patch: { expectedRevision: t.accepted.snapshot.workflow.revision + 1 }, code: 'REVISION_CONFLICT' },
      { patch: { expectedWorkflowVersionId: t.f.version.id }, code: 'WORKFLOW_BASE_CONFLICT' },
      { patch: { expectedAgentConfigurationVersionIds: {} }, code: 'AGENT_CONFIGURATION_CONFLICT' },
      { patch: { expectedLocationRevision: t.run.executionLocation.locationRevision + 1 }, code: 'LOCATION_REVISION_CONFLICT' },
    ]
    for (const item of cases) {
      const input = { ...stageInput(t), ...item.patch }
      const http = await t.app.inject({ method: 'POST', url: repeatUrl(t) + '/edits', headers: graphHeaders(t.writer.token), payload: input })
      const mcp = await call(t, 'repeat_update', input)
      expect(http.statusCode).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: item.code } })
      expect(mcp.result?.isError).toBe(true)
      expect(mcp.value).toMatchObject({ error: { code: item.code } })
    }
    const invalid = saveInput(t)
    invalid.repeat.blocks[0]!.repeatOutcome = 'undeclared'
    const rejected = await call(t, 'repeat_update', invalid)
    expect(rejected.value).toMatchObject({ error: { code: 'REPEAT_INVALID' } })
    expect(await versions(t)).toBe(before)
    expect(await receipts(t, 'graph.stage_edits')).toEqual([])
    expect(t.nativeCalls).toEqual([])
  })

  it('stages once, reopens exact commands on either transport, and discards without changing a live v3 Run or the saved version', async () => {
    const t = await fixture(true), input = stageInput(t), before = await versions(t)
    const response = await t.app.inject({ method: 'POST', url: repeatUrl(t) + '/edits', headers: graphHeaders(t.writer.token), payload: input })
    expect(response.statusCode, response.body).toBe(200)
    const staged = RepeatEditReadResultSchema.parse(response.json())
    expect(staged.intent?.state).toBe('staged')
    const retry = await call(t, 'repeat_update', input)
    expect(RepeatEditReadResultSchema.parse(retry.value)).toEqual(staged)
    const intent = staged.intent!
    const read = { ...scope(t), action: 'read_edits', draftId: input.draftId, intentId: intent.id }
    const reopened = await call(t, 'repeat_get', read)
    const httpRead = await t.app.inject({ method: 'GET', url: repeatUrl(t) + '/edits?' + new URLSearchParams({ draftId: input.draftId, intentId: intent.id }),
      headers: graphHeaders(t.writer.token) })
    expect(reopened.value).toEqual(httpRead.json())
    expect(httpRead.body).not.toContain(db.directory)
    const advance = { ...scope(t), action: 'stop_and_save', draftId: input.draftId, intentId: intent.id, commandId: intent.advanceCommandId }
    const blocked = await call(t, 'repeat_update', advance)
    expect(blocked.result?.isError).not.toBe(true)
    expect(RepeatEditReadResultSchema.parse(blocked.value).intent).toMatchObject({ id: intent.id, state: 'blocked', saveAttempted: false,
      advanceCommandId: intent.advanceCommandId, saveInputHash: intent.saveInputHash, error: { code: 'REPEAT_STOP_NOT_READY', uncertain: false } })
    expect(await receipts(t, 'run.stop')).toEqual([])
    const discard = { ...scope(t), action: 'discard_edits', draftId: input.draftId, intentId: intent.id, commandId: intent.discardCommandId }
    const discarded = await t.app.inject({ method: 'POST', url: repeatUrl(t) + '/edits', headers: graphHeaders(t.writer.token), payload: discard })
    expect(discarded.statusCode, discarded.body).toBe(200)
    expect(RepeatEditReadResultSchema.parse(discarded.json()).intent?.state).toBe('discarded')
    expect((await call(t, 'repeat_update', discard)).value).toEqual(discarded.json())
    expect(await versions(t)).toBe(before)
    expect((await db.pool.query('select execution_state,stop_requested_at from runs where id=$1', [t.run.id])).rows[0])
      .toEqual({ execution_state: 'queued', stop_requested_at: null })
    expect(t.nativeCalls).toEqual([])
  })

  it('saves an exact staged plan only when there is no affected Run, then replays the durable result across transports', async () => {
    const t = await fixture(), input = stageInput(t), before = await versions(t)
    const staged = RepeatEditReadResultSchema.parse((await call(t, 'repeat_update', input)).value)
    expect(staged.current).toEqual([])
    const intent = staged.intent!
    const advance = { ...scope(t), action: 'stop_and_save', draftId: input.draftId, intentId: intent.id, commandId: intent.advanceCommandId }
    const response = await t.app.inject({ method: 'POST', url: repeatUrl(t) + '/edits', headers: graphHeaders(t.writer.token), payload: advance })
    expect(response.statusCode, response.body).toBe(200)
    const saved = RepeatEditReadResultSchema.parse(response.json())
    expect(saved.intent).toMatchObject({ state: 'saved', saveAttempted: true, stops: [], result: { revision: input.expectedRevision + 1 } })
    expect(saved.intent?.result?.version.definition.repeat).toEqual(input.repeat)
    expect((await call(t, 'repeat_update', advance)).value).toEqual(saved)
    expect(await versions(t)).toBe(before + 1)
    expect(await receipts(t, 'run.stop')).toEqual([])
    expect((await receipts(t, 'repeat.save')).filter((item) => item.command_id === intent.saveInput.commandId)).toHaveLength(1)
    expect(t.nativeCalls).toEqual([])
  })

  it('routes strict v3 manual Start to the same explicit runtime gate, audits failure, and creates no Run or receipt', async () => {
    const t = await fixture(), input = t.accepted.snapshot.request
    const before = (await db.pool.query('select count(*)::text as n from runs where workflow_id=$1', [t.scope.workflowId])).rows
    for (let retry = 0; retry < 2; retry++) {
      const http = await t.app.inject({ method: 'POST', url: startUrl(t), headers: graphHeaders(t.writer.token), payload: input })
      const mcp = await call(t, 'run_start', input)
      expect(http.statusCode, http.body).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: 'REPEAT_START_RUNTIME_UNAVAILABLE' } })
      expect(mcp.result?.isError).toBe(true)
      expect(mcp.value).toMatchObject({ error: { code: 'REPEAT_START_RUNTIME_UNAVAILABLE' } })
    }
    expect(await receipts(t, 'run.start')).toEqual([])
    expect((await db.pool.query('select count(*)::text as n from runs where workflow_id=$1', [t.scope.workflowId])).rows).toEqual(before)
    expect((await db.pool.query('select 1 from run_graph_heads where run_id=$1', [t.run.id])).rowCount).toBe(0)
    const audit = (await db.pool.query(`select source,outcome,details->>'code' as code from management_audit
      where principal_id=$1 and action='run.start' and details->>'commandId'=$2`, [t.writer.principal.id, input.commandId])).rows
    expect(audit).toHaveLength(4)
    expect(audit.every((row) => row.outcome === 'failed' && row.code === 'REPEAT_START_RUNTIME_UNAVAILABLE')).toBe(true)
    expect(new Set(audit.map((row) => row.source))).toEqual(new Set(['http', 'mcp']))
    expect(t.nativeCalls).toEqual([])
    // A rejected command has no success receipt: changed rejected input is NOT
    // claimed to be a receipt conflict. Positive Start replay needs A's real run.
  })

  it('keeps manual v3 Stop out of legacy cleanup, rechecks live authority, and reads persisted occurrence metadata', async () => {
    const t = await fixture(true), input = { workspaceId: t.scope.workspaceId, runId: t.run.id, commandId: randomUUID() }
    const before = (await db.pool.query('select record,stop_requested_at from runs where id=$1', [t.run.id])).rows
    const http = await t.app.inject({ method: 'POST', url: stopUrl(t), headers: graphHeaders(t.writer.token), payload: input })
    const mcp = await call(t, 'run_stop', input)
    expect(http.statusCode).toBe(409)
    expect(http.json()).toMatchObject({ error: { code: 'REPEAT_STOP_RUNTIME_UNAVAILABLE' } })
    expect(mcp.result?.isError).toBe(true)
    expect(mcp.value).toMatchObject({ error: { code: 'REPEAT_STOP_RUNTIME_UNAVAILABLE' } })
    expect(await receipts(t, 'run.stop')).toEqual([])
    expect((await db.pool.query('select record,stop_requested_at from runs where id=$1', [t.run.id])).rows).toEqual(before)
    expect((await db.pool.query('select 1 from run_cleanup_intents where run_id=$1', [t.run.id])).rowCount).toBe(0)
    const readInput = { ...scope(t), runId: t.run.id }
    const read = await t.app.inject({ method: 'GET', url: repeatUrl(t).replace(/\/repeat$/, '') + `/runs/${t.run.id}/repeats`, headers: graphHeaders(t.writer.token) })
    expect(read.statusCode, read.body).toBe(200)
    expect(RepeatRunReadbackSchema.parse((await call(t, 'repeat_run_get', readInput)).value)).toEqual(read.json())
    expect(read.json()).toMatchObject({ executionSemanticsVersion: 3, runId: t.run.id, items: [] })
    await t.access.revoke(t.writer.principal.id)
    // Stale in-memory principal cannot read a receipt or invoke Stop after the
    // database authority changed; this exercises the command-level fence too.
    await expect(t.runs.stop(t.writer.principal, 'http', input)).rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 403 })
    expect(t.nativeCalls).toEqual([])
  })

  it('denies read-only and wrong-scope authoring/Start/Stop and audits each transport without widening grants', async () => {
    const t = await fixture(true)
    const readOnly = await t.credential([{ actions: ['capabilities:read'], scope: {} }, {
      actions: ['workflows:read', 'graph:read', 'agents:read', 'workspace_locations:read', 'runs:read'], scope: t.grantScope,
    }])
    const wrong = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['other-workspace'] } }])
    const operations = [
      { method: 'PUT' as const, url: repeatUrl(t), tool: 'repeat_update', input: saveInput(t) },
      { method: 'POST' as const, url: repeatUrl(t) + '/edits', tool: 'repeat_update', input: stageInput(t) },
      { method: 'POST' as const, url: startUrl(t), tool: 'run_start', input: t.accepted.snapshot.request },
      { method: 'POST' as const, url: stopUrl(t), tool: 'run_stop', input: { workspaceId: t.scope.workspaceId, runId: t.run.id, commandId: randomUUID() } },
    ]
    for (const caller of [readOnly, wrong]) {
      for (const operation of operations) {
        const http = await t.app.inject({ method: operation.method, url: operation.url, headers: graphHeaders(caller.token), payload: operation.input })
        const count = async () => Number((await db.pool.query(
          `select count(*)::text as n from management_audit where principal_id=$1 and source='mcp' and target_key=$2 and outcome='denied'`,
          [caller.principal.id, `mcp:${operation.tool}`])).rows[0]!.n)
        const before = await count()
        const mcp = await call(t, operation.tool, operation.input, caller.token)
        expect(http.statusCode).toBe(403)
        expect(mcp.result?.isError).toBe(true)
        expect(mcp.value).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        expect(await count()).toBe(before + 1)
      }
      const audit = (await db.pool.query('select source,outcome from management_audit where principal_id=$1', [caller.principal.id])).rows
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'http', outcome: 'denied' }),
        expect.objectContaining({ source: 'mcp', outcome: 'denied' })]))
    }
    expect(t.nativeCalls).toEqual([])
  })
})
