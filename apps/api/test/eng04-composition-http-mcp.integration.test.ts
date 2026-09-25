import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { ManagementActionSchema, REPEAT_OPERATOR_TOOL_NAMES, type ManagementGrant } from '@graphql/contracts/management'
import { makeWave25Fixture, RepeatSaveResultSchema, WorkflowVersionV2Schema, type RepeatSaveInput } from '@graphql/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { createRepeatServices } from '../src/modules/repeats/composition.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

// Authenticated bearer HTTP + real stateless MCP transport, actual commands,
// audit, migrations and PostgreSQL. Explicit existing disposable loopback gate.
// No native manager, fake runtime host, browser identity, or production DB.
describe.skipIf(!postgresEnabled)('ENG04 composition authenticated HTTP/MCP publication', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  const apps: FastifyInstance[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
  afterAll(async () => { await db?.close() })

  async function fixture(withRun = false) {
    const f = makeWave25Fixture(randomUUID())
    const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
    f.version = WorkflowVersionV2Schema.parse({ ...f.version, definition: { ...f.version.definition,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 }, nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }],
    } })
    await seedAgent3(db.pool, db.directory, f, { run: withRun })
    const access = new PostgresAccessService(db.pool), commands = new PostgresCommandCoordinator(db.pool)
    const scope = { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] }
    async function credential(grants: ManagementGrant[]) {
      return access.issue({ name: 'Synthetic ENG04 composition Operator', audience: 'operator',
        expiresAt: new Date(Date.now() + 300000), grants })
    }
    const writer = await credential([{ actions: ['capabilities:read'], scope: {} },
      { actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope }])
    // Unrelated management services are not invoked by this isolated endpoint
    // suite. Repeat services, access, commands and policy are real, not mocked.
    const services = { commands, repeats: createRepeatServices(db.pool, commands) } as OperatorServices
    const app = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
      checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    apps.push(app)
    await app.ready()
    const revision = Number((await db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!.revision)
    const input: RepeatSaveInput = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      commandId: randomUUID(), expectedRevision: revision, expectedWorkflowVersionId: f.version.id, executionSemanticsVersion: 3,
      repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] } }
    const url = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/repeat`
    return { f, app, access, writer, credential, scope, input, url }
  }
  function headers(token?: string) {
    return { host: 'localhost', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  }
  const rpcOrigins = new WeakMap<FastifyInstance, Promise<string>>()
  async function rpc(app: FastifyInstance, token: string, method: string, params: Record<string, unknown> = {}) {
    let origin = rpcOrigins.get(app)
    if (!origin) {
      origin = app.listen({ host: '127.0.0.1', port: 0 })
      rpcOrigins.set(app, origin)
    }
    const response = await fetch(new URL('/mcp/operator', await origin), {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    // The SDK may use a JSON reply or an SSE message, both on the same endpoint.
    const message: unknown = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
      : JSON.parse(body)
    return message as { result: { tools?: Array<{ name: string }>; isError?: boolean; structuredContent: Record<string, unknown> } }
  }
  async function call(t: Awaited<ReturnType<typeof fixture>>, token: string, name: string, args: unknown) {
    return (await rpc(t.app, token, 'tools/call', { name, arguments: args })).result
  }
  async function versionCount(t: Awaited<ReturnType<typeof fixture>>) {
    return Number((await db.pool.query<{ n: string }>('select count(*)::text as n from workflow_versions where workflow_id=$1', [t.input.workflowId])).rows[0]!.n)
  }

  it('lists callable repeat tools, returns a truthful gate, saves over HTTP, and replays the same command over MCP', async () => {
    const t = await fixture()
    const list = await rpc(t.app, t.writer.token, 'tools/list')
    expect(list.result.tools!.filter((tool) => REPEAT_OPERATOR_TOOL_NAMES.some((name) => name === tool.name)).map((tool) => tool.name).sort())
      .toEqual([...REPEAT_OPERATOR_TOOL_NAMES].sort())
    const httpGate = await t.app.inject({ method: 'GET', url: '/api/management/repeats/capabilities', headers: headers(t.writer.token) })
    expect(httpGate.statusCode).toBe(200)
    const mcpGate = await call(t, t.writer.token, 'repeat_capabilities_get', {})
    expect(mcpGate.structuredContent).toEqual(httpGate.json())
    expect(httpGate.json()).toMatchObject({ supported: false, availability: { runtimeAdmission: false, meaningfulEdit: false, persistedReadback: true } })
    const geometry = { ...t.f.version.definition, nodes: t.f.version.definition.nodes.map((node, index) =>
      index === 0 ? { ...node, position: { x: 137, y: 241 } } : node) }
    await db.pool.query('update workflows set record=$2::jsonb where id=$1', [t.input.workflowId, JSON.stringify(geometry)])
    const save = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })
    expect(save.statusCode, save.body).toBe(200)
    const saved = RepeatSaveResultSchema.parse(save.json())
    expect(saved.replayed).toBe(false)
    expect(saved.value.version.executionSemanticsVersion).toBe(3)
    expect(saved.value.version.definition.nodes[0]!.position).toEqual({ x: 137, y: 241 })
    expect(saved.value.currentVersionId).not.toBe(t.f.version.id)
    const retry = await call(t, t.writer.token, 'repeat_update', t.input)
    expect(retry.isError).not.toBe(true)
    expect(RepeatSaveResultSchema.parse(retry.structuredContent)).toEqual({ ...saved, replayed: true })
    const httpRead = await t.app.inject({ method: 'GET', url: t.url, headers: headers(t.writer.token) })
    const mcpRead = await call(t, t.writer.token, 'repeat_get', { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
    expect(httpRead.statusCode).toBe(200)
    expect(mcpRead.structuredContent).toEqual(httpRead.json())
    expect(httpRead.json()).toMatchObject({ currentVersionId: saved.value.currentVersionId, revision: saved.value.revision,
      version: { definition: { repeat: t.input.repeat } } })
    expect(await versionCount(t)).toBe(2)
    expect((await db.pool.query(`select command_id from management_command_receipts where principal_id=$1 and operation='repeat.save' and command_id=$2`,
      [t.writer.principal.id, t.input.commandId])).rowCount).toBe(1)
    const audit = await db.pool.query<{ source: string; outcome: string }>(
      `select source,outcome from management_audit where principal_id=$1 and action='repeat.save'`, [t.writer.principal.id])
    expect(audit.rows).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'http', outcome: 'succeeded' })]))
  })
  it('publishes over MCP and replays over HTTP; conflicting command reuse and stale revisions cannot publish twice', async () => {
    const t = await fixture()
    const save = await call(t, t.writer.token, 'repeat_update', t.input)
    expect(save.isError, JSON.stringify(save.structuredContent)).not.toBe(true)
    const retry = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })
    expect(RepeatSaveResultSchema.parse(retry.json()).replayed).toBe(true)
    const changed = { ...t.input, repeat: { ...t.input.repeat, blocks: t.input.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 1 })) } }
    const conflict = await call(t, t.writer.token, 'repeat_update', changed)
    expect(conflict).toMatchObject({ isError: true, structuredContent: { error: { code: 'COMMAND_ID_CONFLICT' } } })
    const stale = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: { ...t.input, commandId: randomUUID() } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
    expect(await versionCount(t)).toBe(2)
  })
  it('denies unauthenticated, revoked, read-only and wrong-scope callers; hidden MCP writes are audited', async () => {
    const t = await fixture()
    const readOnly = await t.credential([{ actions: ['workflows:read', 'graph:read', 'runs:read'], scope: t.scope }])
    const wrongScope = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['other-workspace'] } }])
    const noAuth = await t.app.inject({ method: 'GET', url: t.url, headers: headers() })
    expect(noAuth.statusCode).toBe(401)
    const list = await rpc(t.app, readOnly.token, 'tools/list')
    expect(list.result.tools!.map((tool) => tool.name)).not.toContain('repeat_update')
    for (const credential of [readOnly, wrongScope]) {
      const deniedHttp = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(credential.token), payload: t.input })
      expect(deniedHttp.statusCode).toBe(403)
      const deniedMcp = await call(t, credential.token, 'repeat_update', t.input)
      expect(deniedMcp).toMatchObject({ isError: true, structuredContent: { error: { code: 'ACCESS_DENIED' } } })
      const audit = await db.pool.query<{ source: string; outcome: string }>(
        'select source,outcome from management_audit where principal_id=$1', [credential.principal.id])
      expect(audit.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'http', outcome: 'denied' }), expect.objectContaining({ source: 'mcp', outcome: 'denied' }),
      ]))
    }
    await t.access.revoke(t.writer.principal.id)
    const revoked = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })
    expect(revoked.statusCode).toBe(401)
    expect(await versionCount(t)).toBe(1)
  })
  it('retains the active-Run barrier on both transports and never turns direct update into Stop', async () => {
    const t = await fixture(true)
    const http = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })
    const mcp = await call(t, t.writer.token, 'repeat_update', t.input)
    expect(http.statusCode).toBe(409)
    expect(http.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
    expect(mcp).toMatchObject({ isError: true, structuredContent: { error: { code: 'WORKFLOW_RUNS_UNSETTLED' } } })
    const run = (await db.pool.query<{ execution_state: string; record: unknown }>(
      'select execution_state,record from runs where id=$1', [t.f.run.id])).rows[0]!
    expect(run).toEqual({ execution_state: 'queued', record: t.f.run })
    expect(await versionCount(t)).toBe(1)
    expect((await db.pool.query(`select command_id from management_command_receipts where principal_id=$1 and operation='repeat.save'`,
      [t.writer.principal.id])).rowCount).toBe(0)
  })
  it('rejects mismatched URL scope and ambiguous detail flags, and calls the scoped Run reader rather than an unknown MCP tool', async () => {
    const t = await fixture()
    const mismatch = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token),
      payload: { ...t.input, workflowId: 'different-workflow' } })
    expect(mismatch.statusCode).toBe(400)
    expect(mismatch.json()).toMatchObject({ error: { code: 'RESOURCE_ID_MISMATCH' } })
    const runUrl = t.url.replace(/\/repeat$/, '/runs/missing-run/repeats')
    for (const query of ['includeResultData=TRUE', 'includeResultData=1', 'limit=101', 'cursor=', 'workflowId=other']) {
      expect((await t.app.inject({ method: 'GET', url: `${runUrl}?${query}`, headers: headers(t.writer.token) })).statusCode).toBe(400)
    }
    const input = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, runId: 'missing-run' }
    const missing = await call(t, t.writer.token, 'repeat_run_get', input)
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'RUN_NOT_FOUND' } } })
    expect(await versionCount(t)).toBe(1)
  })
})
