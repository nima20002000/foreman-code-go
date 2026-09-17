import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { it } from 'vitest'
import { HarnessNativeEventSchema, type NativeHarnessEvent } from '@graphql/contracts'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { normalizedHistory } from '../src/modules/harnesses/opencodeProtocol.js'
import { openCodeFixture, start } from './fixtures/pr17-native-runtime.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'

it('F1: appends real OpenCode manager events after durable-execution reattachment and keeps exact replay idempotent', async () => {
  const schema = `opencode_identity_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  let created = false
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await admin.query(`create schema "${schema}"`)
    created = true
    await applyApplicationMigrations(pool)
    await pool.query("insert into workspaces(id,record) values('workspace','{}')")
    await pool.query("insert into agents(id,workspace_id,record) values('agent','workspace','{}')")
    await pool.query("insert into workflows(id,workspace_id,record) values('workflow','workspace','{}')")
    await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record)
      values('version','workspace','workflow',1,'node','{}')`)
    await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
      values('run','workspace','workflow','version','running','{}')`)
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values('execution','run','node','agent',1,'{}')`)

    const first = openCodeFixture()
    const session = await first.manager.createSession(start)
    const firstState = first.seam.sessions.get(session.nativeSessionId)!
    const before = [
      first.seam.recordSynthetic(firstState, 'message.part.updated', { text: 'before recovery' }),
      first.seam.recordSynthetic(firstState, 'interaction.pending', { nativeRequestId: 'permission-1' }),
    ]
    const authoritative = normalizedHistory([{ info: { id: 'message-1', role: 'user', sessionID: session.nativeSessionId,
      time: { created: 1 } }, parts: [] }], false)
    const persist = (native: NativeHarnessEvent) => appendNativeEvent(pool, HarnessNativeEventSchema.parse({ executionId: 'execution', ...native }))
    for (const event of [...before, ...authoritative]) await persist(event)

    const recovered = openCodeFixture()
    await recovered.manager.attachSession(session, start)
    const after = recovered.seam.recordSynthetic(recovered.seam.sessions.get(session.nativeSessionId)!, 'message.part.updated', { text: 'after recovery' })
    assert.equal(after.sequence, 0)
    assert.notEqual(after.connectionId, before[0]!.connectionId)
    await persist(after)
    for (const event of [...before, ...authoritative, after]) await persist(structuredClone(event))
    // Historical re-fetch must retain exactly the same identity and payload.
    for (const event of normalizedHistory([{ info: { id: 'message-1', role: 'user', sessionID: session.nativeSessionId,
      time: { created: 1 } }, parts: [] }], false)) await persist(event)

    const rows = await pool.query<{ sequence: number; connection_id: string; source_sequence: number }>(
      'select sequence,connection_id,source_sequence from harness_native_events order by sequence',
    )
    assert.deepEqual(rows.rows.map((row) => row.sequence), [0, 1, 2, 3])
    assert.deepEqual(rows.rows.map((row) => row.source_sequence), [0, 1, 0, 0])
    assert.equal(new Set(rows.rows.map((row) => `${row.connection_id}:${row.source_sequence}`)).size, 4)
    assert.equal((await pool.query<{ count: number }>("select count(*)::integer as count from run_activity where kind='harness_output'")).rows[0]!.count, 4)
    assert.equal((await pool.query<{ value: string }>("select native_event_next_sequence::text as value from harness_executions where id='execution'")).rows[0]!.value, '4')
    await assert.rejects(persist({ ...after, payload: { text: 'conflicting replay' } }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'NATIVE_EVENT_IDENTITY_CONFLICT')
    await first.manager.dispose()
    await recovered.manager.dispose()
  } finally {
    await pool.end()
    try { if (created) await admin.query(`drop schema "${schema}" cascade`) } finally { await admin.end() }
  }
}, 20_000)
