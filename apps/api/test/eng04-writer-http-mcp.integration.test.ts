import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@graphql/contracts/management'
import { RepeatSaveResultSchema, type RepeatSaveInput } from '@graphql/contracts/wave25'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RepeatAuthoringService } from '../src/modules/repeats/authoring.js'
import { headers, mcp, snapshot, writerDatabase, writerFixture, writerPostgresEnabled,
  type WriterDatabase, type WriterFixture } from './eng04-writer-fixtures.js'

// Real authenticated transports, full application registry and independent PG
// sessions. A skip is NOT a PostgreSQL pass. No native/browser claim is made.
describe.skipIf(!writerPostgresEnabled)('ENG04 typed repeat writer authenticated HTTP/MCP', () => {
  let db: WriterDatabase
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await writerDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(withRun = false) {
    const t = await writerFixture(db, withRun)
    fixtures.push(t)
    return t
  }
  async function save(t: WriterFixture, source: 'http' | 'mcp', input: RepeatSaveInput) {
    if (source === 'http') {
      const response = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: input })
      expect(response.statusCode, response.body).toBe(200)
      return RepeatSaveResultSchema.parse(response.json())
    }
    const response = await mcp(t.app, t.writer.token, 'repeat_update', input)
    expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(true)
    return RepeatSaveResultSchema.parse(response.structuredContent)
  }
  async function readBoth(t: WriterFixture, saved: ReturnType<typeof RepeatSaveResultSchema.parse>) {
    const response = await t.app.inject({ method: 'GET', url: t.url, headers: headers(t.writer.token) })
    expect(response.statusCode, response.body).toBe(200)
    const rpc = await mcp(t.app, t.writer.token, 'repeat_get', { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })
    expect(rpc.isError).not.toBe(true)
    expect(rpc.structuredContent).toEqual(response.json())
    expect(response.json()).toEqual({ contractVersion: 1, executionSemanticsVersion: 3, ...saved.value })
    const stored = (await snapshot(t)).workflow[0]!
    expect(stored).toEqual({ record: saved.value.version.definition, current_version_id: saved.value.currentVersionId,
      revision: String(saved.value.revision) })
  }

  it.each(['http', 'mcp'] as const)('publishes v2->v3 via %s, edits v3->v3 via the other transport and reads persisted history', async (firstSource) => {
    const t = await fixture(), secondSource = firstSource === 'http' ? 'mcp' : 'http'
    const original = await snapshot(t)
    // This remains an ordinary, independent v2 geometry write before publication.
    await db.pool.query(`update workflows set record=jsonb_set(record,'{nodes,0,position}','{"x":137,"y":241}') where id=$1`, [t.input.workflowId])
    const first = await save(t, firstSource, t.input)
    expect(first.replayed).toBe(false)
    expect(first.value.version.executionSemanticsVersion).toBe(3)
    expect(first.value.version.definition.nodes[0]!.position).toEqual({ x: 137, y: 241 })
    expect(first.value.version.approval).toEqual(t.f.version.approval)
    expect(first.value.version.definition.edges).toEqual(t.f.version.definition.edges)
    await readBoth(t, first)
    const firstRows = await snapshot(t)
    expect(firstRows.versions[0]).toEqual(original.versions[0]) // includes xmin/ctid
    const next: RepeatSaveInput = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      repeat: { ...t.input.repeat, blocks: t.input.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 3 })) } }
    const second = await save(t, secondSource, next)
    expect(second.replayed).toBe(false)
    expect(second.value.currentVersionId).not.toBe(first.value.currentVersionId)
    expect(second.value.revision).toBe(first.value.revision + 1)
    expect(second.value.version.version).toBe(first.value.version.version + 1)
    expect(second.value.version.definition.repeat).toEqual(next.repeat)
    expect(second.value.version.definition.edges).toEqual(t.f.version.definition.edges)
    expect(second.value.version.approval).toEqual(t.f.version.approval)
    await readBoth(t, second)
    const beforeReplay = await snapshot(t)
    expect(beforeReplay.versions.slice(0, 2)).toEqual(firstRows.versions)
    expect(await save(t, secondSource, t.input)).toEqual({ ...first, replayed: true })
    expect(await save(t, firstSource, next)).toEqual({ ...second, replayed: true })
    expect(await snapshot(t)).toEqual(beforeReplay)
    expect(beforeReplay.versions).toHaveLength(3)
    expect(beforeReplay.receipts).toHaveLength(2)
    expect(beforeReplay.publications.map((row) => row.source)).toEqual([firstSource, secondSource])
    const audit = await db.pool.query(`select source,outcome,details->>'commandId' as command_id from management_audit
      where principal_id=$1 and action='repeat.save' and outcome='succeeded'`, [t.writer.principal.id])
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows).toEqual(expect.arrayContaining([
      { source: firstSource, outcome: 'succeeded', command_id: t.input.commandId },
      { source: secondSource, outcome: 'succeeded', command_id: next.commandId },
    ]))
  })

  it('preserves the existing explicit Orchestrator approval relationship across both typed publications', async () => {
    const t = await writerFixture(db, false, true)
    fixtures.push(t)
    const original = await snapshot(t)
    const first = await save(t, 'http', t.input)
    expect(first.value.version.approval).toEqual(t.f.version.approval)
    expect(first.value.version.definition.edges.filter((edge) => edge.kind === 'approval'))
      .toEqual(t.f.version.definition.edges.filter((edge) => edge.kind === 'approval'))
    const next = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      repeat: { ...t.input.repeat, blocks: t.input.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 3 })) } }
    const second = await save(t, 'mcp', next)
    await readBoth(t, second)
    expect(second.value.version.approval).toEqual(first.value.version.approval)
    expect(second.value.version.definition.edges).toEqual(first.value.version.definition.edges)
    expect((await snapshot(t)).versions[0]).toEqual(original.versions[0])
  })

  it('retains command conflicts, stale revision and wrong immutable-base rejection without another publication', async () => {
    const t = await fixture()
    const first = await save(t, 'http', t.input), before = await snapshot(t)
    const conflict = { ...t.input, repeat: { ...t.input.repeat,
      blocks: t.input.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 1 })) } }
    const rpc = await mcp(t.app, t.writer.token, 'repeat_update', conflict)
    expect(rpc).toMatchObject({ isError: true, structuredContent: { error: { code: 'COMMAND_ID_CONFLICT' } } })
    for (const [input, code] of [
      [{ ...t.input, commandId: randomUUID() }, 'REVISION_CONFLICT'],
      [{ ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision }, 'WORKFLOW_BASE_CONFLICT'],
    ] as const) {
      const response = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: input })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: { code } })
      expect(await mcp(t.app, t.writer.token, 'repeat_update', input))
        .toMatchObject({ isError: true, structuredContent: { error: { code } } })
    }
    expect(await snapshot(t)).toEqual(before)
  })

  it('serializes competing fresh HTTP/MCP commands at the same revision into one immutable publication', async () => {
    const t = await fixture()
    const [http, rpc] = await Promise.all([
      t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input }),
      mcp(t.app, t.writer.token, 'repeat_update', { ...t.input, commandId: randomUUID() }),
    ])
    expect([http.statusCode === 200, rpc.isError !== true].filter(Boolean)).toHaveLength(1)
    if (http.statusCode !== 200) {
      expect(http.statusCode).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
    } else expect(rpc).toMatchObject({ isError: true, structuredContent: { error: { code: 'REVISION_CONFLICT' } } })
    const state = await snapshot(t)
    expect(state.versions).toHaveLength(2)
    expect(state.publications).toHaveLength(1)
    expect(state.receipts).toHaveLength(1)
  })

  it('denies read-only/wrong-scope callers on HTTP and MCP with denial audit and no database effect', async () => {
    const t = await fixture(), before = await snapshot(t)
    const readOnly = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: t.scope }])
    const wrong = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['other-workspace'] } }])
    for (const credential of [readOnly, wrong]) {
      const response = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(credential.token), payload: t.input })
      expect(response.statusCode).toBe(403)
      expect(await mcp(t.app, credential.token, 'repeat_update', t.input))
        .toMatchObject({ isError: true, structuredContent: { error: { code: 'ACCESS_DENIED' } } })
      expect((await db.pool.query('select source,outcome from management_audit where principal_id=$1', [credential.principal.id])).rows)
        .toEqual(expect.arrayContaining([{ source: 'http', outcome: 'denied' }, { source: 'mcp', outcome: 'denied' }]))
    }
    expect(await snapshot(t)).toEqual(before)
  })

  it('rechecks live grants on an exact historical replay even with an already captured principal', async () => {
    const t = await fixture()
    await save(t, 'mcp', t.input)
    const before = await snapshot(t)
    await db.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [t.writer.principal.id, JSON.stringify([{ actions: ['workflows:read', 'graph:read'], scope: t.scope }])])
    const authoring = new RepeatAuthoringService(db.pool, new PostgresCommandCoordinator(db.pool), true)
    await expect(authoring.save(t.writer.principal, 'http', t.input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect((await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })).statusCode).toBe(403)
    expect(await mcp(t.app, t.writer.token, 'repeat_update', t.input))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'ACCESS_DENIED' } } })
    expect(await snapshot(t)).toEqual(before)
    await t.access.revoke(t.writer.principal.id)
    expect((await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: t.input })).statusCode).toBe(401)
  })

  it('preserves the active-Run/Stop admission barrier and rejects an invalid executable repeat budget', async () => {
    const active = await fixture(true), before = await snapshot(active)
    const run = (await db.pool.query('select record,execution_state from runs where id=$1', [active.f.run.id])).rows
    const response = await active.app.inject({ method: 'PUT', url: active.url, headers: headers(active.writer.token), payload: active.input })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
    expect(await mcp(active.app, active.writer.token, 'repeat_update', active.input))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'WORKFLOW_RUNS_UNSETTLED' } } })
    expect(await snapshot(active)).toEqual(before)
    expect((await db.pool.query('select record,execution_state from runs where id=$1', [active.f.run.id])).rows).toEqual(run)
    const t = await fixture(), initial = await snapshot(t)
    const invalid = { ...t.input, repeat: { ...t.input.repeat, blocks: t.input.repeat.blocks.map((block) => ({ ...block, maxOccurrences: 4 })) } }
    const invalidHttp = await t.app.inject({ method: 'PUT', url: t.url, headers: headers(t.writer.token), payload: invalid })
    expect(invalidHttp.statusCode).toBe(409)
    expect(invalidHttp.json()).toMatchObject({ error: { code: 'REPEAT_INVALID' } })
    expect(await mcp(t.app, t.writer.token, 'repeat_update', invalid))
      .toMatchObject({ isError: true, structuredContent: { error: { code: 'REPEAT_INVALID' } } })
    expect(await snapshot(t)).toEqual(initial)
  })
})
