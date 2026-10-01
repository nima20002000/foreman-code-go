import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import { activitySnapshotMigration } from '../src/infrastructure/activitySnapshotMigration.js'

// Orchestrator executes against its owned disposable TEST_DATABASE_URL. No provider I/O.
const connectionString = process.env.TEST_DATABASE_URL
describe.skipIf(!connectionString)('activity transaction fencing in PostgreSQL', () => {
  let admin: pg.Pool; let pool: pg.Pool; let repository: PostgresOperatorActivityRepository; let schema: string
  beforeEach(async () => {
    admin = new pg.Pool({ connectionString }); schema = `activity_${randomUUID().replaceAll('-', '')}`
    await admin.query(`create schema "${schema}"`)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` }); repository = new PostgresOperatorActivityRepository(pool)
    await pool.query(`create table operator_conversations (id text primary key, active_request_id text, native_session_id text,
      active_native_turn_id text, deleted_at timestamptz, revision bigint not null default 0,
      kind text not null default 'agent', record jsonb not null default '{}', active_phase text, cancel_requested boolean not null default false,
      turn_state text not null default 'idle', last_error text, last_result jsonb, pending_interaction jsonb, updated_at timestamptz not null default now());
      create table operator_conversation_turns (conversation_id text, request_id text, intent text, delivery text, updated_at timestamptz);
      create table operator_conversation_activity (conversation_id text, request_id text, activity_id text,
        record jsonb not null, sequence bigint generated always as identity, revision bigint not null default 0,
        unique(conversation_id,request_id,activity_id));`)
    await pool.query(activitySnapshotMigration.sql)
    await pool.query(`insert into operator_conversations (id,active_request_id,native_session_id,active_native_turn_id)
      values ('conversation','A','session','turn-A')`)
  })
  afterEach(async () => { await pool?.end(); if (admin) { await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end() } })
  const value = (status: 'running' | 'completed', title = 'Tool') => ({ id: 'tool', requestId: 'A', kind: 'tool' as const, title, status })
  const fence = (sequence: string) => ({ nativeSessionId: 'session', nativeTurnId: 'turn-A', source: { eventId: `event-${sequence}`, sequence } })
  it('claim start time remains immutable through activity revisions and repeated claims', async () => {
    await pool.query(`update operator_conversations set active_request_id=null,active_native_turn_id=null where id='conversation';
      insert into operator_conversation_turns (conversation_id,request_id,intent,delivery) values ('conversation','A','next_turn','queued')`)
    const chat = new PostgresAgentChatRepository(pool)
    expect(await chat.claim('conversation', 'A')).toBe(true)
    const start = (await pool.query('select started_at from operator_conversation_turns')).rows[0].started_at
    expect(start).toBeInstanceOf(Date)
    await repository.append('conversation', 'A', value('running'))
    expect(await chat.claim('conversation', 'A')).toBe(false)
    expect((await pool.query('select started_at from operator_conversation_turns')).rows[0].started_at).toEqual(start)
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('2')
  })
  it('duplicates and stale same-status content do not mutate item or scope revisions', async () => {
    await repository.append('conversation', 'A', value('completed'), fence('2'))
    const before = await pool.query(`select c.revision::text as scope,a.revision::text as item,a.record from operator_conversations c cross join operator_conversation_activity a`)
    expect(await repository.append('conversation', 'A', value('completed'), fence('2'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('completed', 'old payload'), fence('1'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('completed', 'unsequenced payload'))).toBeUndefined()
    expect((await pool.query(`select c.revision::text as scope,a.revision::text as item,a.record from operator_conversations c cross join operator_conversation_activity a`)).rows).toEqual(before.rows)
  })
  it('parent cancellation retains unknown unresolved child outcome', async () => {
    await repository.append('conversation', 'A', value('running'), fence('1'))
    const client = await pool.connect()
    try { await client.query('begin'); await repository.finish('conversation', 'A', true, client); await client.query('commit') } finally { client.release() }
    expect((await pool.query('select record from operator_conversation_activity')).rows[0].record.status).toBe('unknown')
  })
  it('rejects stale owner and exact native turn before insertion', async () => {
    expect(await repository.append('conversation', 'A', value('running'), { nativeTurnId: 'previous-turn' })).toBeUndefined()
    await pool.query(`update operator_conversations set active_request_id='B' where id='conversation'`)
    expect(await repository.append('conversation', 'A', value('running'), fence('1'))).toBeUndefined()
    expect((await pool.query('select * from operator_conversation_activity')).rowCount).toBe(0)
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('0')
  })
  it('advances source watermark for identical payload without changing revisions', async () => {
    await repository.append('conversation', 'A', value('running'), fence('2'))
    expect(await repository.append('conversation', 'A', value('running', 'ambiguous unsequenced'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('running'), fence('5'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('running', 'stale'), fence('4'))).toBeUndefined()
    const item = (await pool.query('select revision::text,source_provenance,record from operator_conversation_activity')).rows[0]
    expect(item.revision).toBe('0'); expect(item.source_provenance.sequence).toBe('5'); expect(item.record.title).toBe('Tool')
    expect((await pool.query('select revision::text from operator_conversations')).rows[0].revision).toBe('1')
  })
  it('requires explicit ordered reconciliation to correct a terminal payload', async () => {
    await repository.append('conversation', 'A', value('completed'), fence('2'))
    expect(await repository.append('conversation', 'A', value('completed', 'late'), fence('3'))).toBeUndefined()
    expect(await repository.append('conversation', 'A', value('completed', 'reconciled'), { ...fence('3'), authoritativeReconciliation: true })).toBeDefined()
    expect((await pool.query('select record from operator_conversation_activity')).rows[0].record.title).toBe('reconciled')
  })
})
