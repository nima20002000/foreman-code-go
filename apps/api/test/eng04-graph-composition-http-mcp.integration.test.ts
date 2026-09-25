import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS, RepeatGraphPageV3Schema, RepeatGraphSnapshotV3Schema,
  reduceRepeatGraphPageV3, makeWave25Fixture, RunGraphSnapshotSchema, RunGraphEventsResponseSchema,
} from '@graphql/contracts/wave25'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import {
  graphFixture, graphUrl, graphHeaders, graphRpc, graphRpcValue, changeRunState, privateCanary,
  type GraphFixture, type GraphTestDatabase,
} from './eng04-graph-composition-fixture.js'

/** Real bearer authentication and actual stateless Operator MCP HTTP transport,
 * using the same PostgreSQL/publisher/read service. No mock principal, browser
 * identity, native harness, engine adapter or bypass of the disposable DB gate.
 */
describe.skipIf(!postgresEnabled)('ENG04 graph composition / authenticated HTTP and Operator MCP', () => {
  let db: GraphTestDatabase
  const fixtures: GraphFixture[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(qualifiedReads = true) {
    const t = await graphFixture(db, { qualifiedReads }); fixtures.push(t); return t
  }
  const http = (t: GraphFixture, kind: 'current' | 'snapshot' | 'events', after?: string, token = t.writer.token) =>
    t.app.inject({ method: 'GET', url: graphUrl(t, kind, after), headers: graphHeaders(token) })
  const mcp = (t: GraphFixture, kind: 'current' | 'snapshot' | 'events', after?: string, token = t.writer.token) =>
    graphRpc(t.app, token, 'tools/call', { name: CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], arguments: {
      ...t.readRequest, ...(after === undefined ? {} : { afterSequence: after }),
    } })

  it('lists canonical current and returns equal current/snapshot/complete-delta cuts on both authenticated transports', async () => {
    const t = await fixture()
    const list = await graphRpc(t.app, t.writer.token, 'tools/list')
    expect(list.status).toBe(200)
    expect(list.result?.tools?.map((tool) => tool.name)).toContain(CANONICAL_RUN_GRAPH_MCP_TOOLS.current)
    const baseline = await http(t, 'snapshot')
    expect(baseline.statusCode, baseline.body).toBe(200)
    const initial = RepeatGraphSnapshotV3Schema.parse(baseline.json())
    await changeRunState(db, t, 'running')
    await changeRunState(db, t, 'waiting')
    for (const kind of ['current', 'snapshot', 'events'] as const) {
      const cursor = kind === 'events' ? initial.asOfSequence : undefined
      const read = await http(t, kind, cursor), remote = await mcp(t, kind, cursor)
      expect(read.statusCode, read.body).toBe(200)
      expect(remote.status).toBe(200)
      expect(remote.result?.isError).not.toBe(true)
      expect(graphRpcValue(remote.result)).toEqual(read.json())
      expect(read.headers['cache-control']).toBe('private, no-store')
      expect(read.headers.vary).toBe('Authorization, Cookie')
      expect(read.body).not.toContain(privateCanary)
      expect(read.body).not.toContain(db.directory)
      expect(read.body).not.toContain(t.writer.principal.id)
    }
    const page = RepeatGraphPageV3Schema.parse((await http(t, 'events', initial.asOfSequence)).json())
    expect(reduceRepeatGraphPageV3(initial, page)).toEqual((await http(t, 'snapshot')).json())
    expect(page.hasMore).toBe(false)
  })

  it('registers real v3 reads but leaves them unavailable by default and does not advertise v3 qualification', async () => {
    const t = await fixture(false)
    for (const kind of ['current', 'snapshot', 'events'] as const) {
      const after = kind === 'events' ? '0' : undefined
      const read = await http(t, kind, after), remote = await mcp(t, kind, after)
      expect(read.statusCode).not.toBe(200)
      expect(read.json()).toMatchObject({ error: { code: 'GRAPH_NOT_INITIALIZED' } })
      expect(remote.result?.isError).toBe(true)
      expect(graphRpcValue(remote.result)).toMatchObject({ error: { code: 'GRAPH_NOT_INITIALIZED' } })
    }
    const capabilities = await t.app.inject({ method: 'GET', url: '/api/capabilities/run-graph/v1', headers: graphHeaders(t.writer.token) })
    expect(capabilities.statusCode).toBe(200)
    expect(capabilities.json().executionSemanticsVersions).toEqual([2])
    expect(capabilities.json().authoringSemanticsVersions).toEqual([2])
  })

  it('denies missing, revoked, wrong-scope and missing-runs:read credentials and audits both transport denials', async () => {
    const t = await fixture()
    const missing = await t.app.inject({ method: 'GET', url: graphUrl(t, 'snapshot'), headers: graphHeaders() })
    expect(missing.statusCode).toBe(401)
    const wrong = await t.credential([{ actions: ['capabilities:read'], scope: {} },
      { actions: ['runs:read'], scope: { workspaceIds: ['another-workspace'] } }])
    const noRead = await t.credential([{ actions: ['capabilities:read'], scope: {} }])
    for (const credential of [wrong, noRead]) {
      const deniedHttp = await http(t, 'snapshot', undefined, credential.token)
      const deniedMcp = await mcp(t, 'snapshot', undefined, credential.token)
      expect(deniedHttp.statusCode).toBe(403)
      expect(deniedHttp.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(deniedMcp.result?.isError).toBe(true)
      expect(graphRpcValue(deniedMcp.result)).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
      const audit = (await db.pool.query('select source,outcome from management_audit where principal_id=$1', [credential.principal.id])).rows
      expect(audit).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'http', outcome: 'denied' }), expect.objectContaining({ source: 'mcp', outcome: 'denied' }),
      ]))
    }
    await t.access.revoke(t.writer.principal.id)
    expect((await http(t, 'snapshot')).statusCode).toBe(401)
    expect((await mcp(t, 'snapshot')).status).toBe(401)
  })

  it('rejects unknown semantics, extra fields, malformed cursors and mismatched exact scope without coercion', async () => {
    const t = await fixture()
    for (const text of ['01', '-1', '1e0', '9223372036854775808']) {
      const bad = await http(t, 'events', text)
      expect(bad.statusCode).not.toBe(200)
      expect(bad.json()).toMatchObject({ error: { code: 'GRAPH_INVALID_CURSOR' } })
      const remote = await mcp(t, 'events', text)
      expect(remote.error !== undefined || remote.result?.isError === true).toBe(true)
    }
    for (const query of ['executionSemanticsVersion=4', 'executionSemanticsVersion=03', 'executionSemanticsVersion=3&extra=1']) {
      const url = graphUrl(t, 'snapshot').replace('executionSemanticsVersion=3', query)
      expect((await t.app.inject({ method: 'GET', url, headers: graphHeaders(t.writer.token) })).statusCode).not.toBe(200)
    }
    for (const scope of [{ ...t.scope, executionSemanticsVersion: 4 }, { ...t.scope, executionSemanticsVersion: '3' },
      { ...t.scope, workflowVersionId: 'different-pin' }, { ...t.scope, workspaceId: 'wrong-workspace' }]) {
      const result = await graphRpc(t.app, t.writer.token, 'tools/call', {
        name: CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, arguments: { protocolVersion: 1, scope },
      })
      expect(result.error !== undefined || result.result?.isError === true).toBe(true)
    }
  })

  it('keeps semantics-2 snapshot and delta output equal across the original endpoint/tool names', async () => {
    const t = await fixture()
    const legacy = makeWave25Fixture(randomUUID())
    await seedAgent3(db.pool, db.directory, legacy)
    const credential = await t.credential([{ actions: ['runs:read'], scope: {
      workspaceIds: [legacy.scope.workspaceId], workflowIds: [legacy.scope.workflowId],
    } }])
    for (const kind of ['snapshot', 'events'] as const) {
      const scope = legacy.scope
      const query = new URLSearchParams({ workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: '2',
        ...(kind === 'events' ? { afterSequence: '0' } : {}) })
      const url = `/api/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/${scope.runId}/graph/v1/${kind}?${query}`
      const read = await t.app.inject({ method: 'GET', url, headers: graphHeaders(credential.token) })
      const remote = await graphRpc(t.app, credential.token, 'tools/call', { name: CANONICAL_RUN_GRAPH_MCP_TOOLS[kind], arguments: {
        protocolVersion: 1, scope, ...(kind === 'events' ? { afterSequence: '0' } : {}),
      } })
      expect(read.statusCode, read.body).toBe(200)
      expect(remote.result?.isError).not.toBe(true)
      expect(graphRpcValue(remote.result)).toEqual(read.json())
      expect((kind === 'snapshot' ? RunGraphSnapshotSchema : RunGraphEventsResponseSchema).safeParse(read.json()).success).toBe(true)
    }
  })
})
