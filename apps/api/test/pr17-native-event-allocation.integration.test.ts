import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HarnessNativeEventSchema, type HarnessNativeEvent } from '@graphql/contracts'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { nativeEventSequenceMigration } from '../src/infrastructure/nativeEventSequenceMigration.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
const timestamp = '2026-09-17T00:00:00.000Z'

async function database(test: (pool: pg.Pool) => Promise<void>, existingPR17 = false) {
  const schema = `event_allocation_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 })
  try {
    if (existingPR17) {
      // Execute the actual historical migration objects with their original
      // versions, transaction and advisory lock. No synthetic schema/downgrade.
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select pg_advisory_xact_lock($1)', [810_001])
        for (const migration of migrations) {
          if (migration.version === nativeEventSequenceMigration.version) continue
          await client.query(migration.sql)
          await client.query('insert into application_migrations(version) values($1)', [migration.version])
        }
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally { client.release() }
      expect((await pool.query('select version from application_migrations where version=1701')).rowCount).toBe(1)
      expect((await pool.query("select to_regprocedure('append_harness_native_event(jsonb)') as fn")).rows[0].fn).toBeNull()
    } else {
      await applyApplicationMigrations(pool)
    }
    await seed(pool)
    await test(pool)
  } finally {
    await pool.end()
    try { await admin.query(`drop schema "${schema}" cascade`) } finally { await admin.end() }
  }
}

async function seed(pool: pg.Pool) {
  await pool.query("insert into workspaces(id,record) values('workspace','{}')")
  await pool.query("insert into agents(id,workspace_id,record) values('agent','workspace','{}')")
  await pool.query("insert into workflows(id,workspace_id,record) values('workflow','workspace','{}')")
  await pool.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record)
    values('version','workspace','workflow',1,'node','{}')`)
  await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
    values('run','workspace','workflow','version','running','{}')`)
  await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
    values('execution','run','node','agent',1,'{}'),('other-execution','run','other-node','agent',1,'{}')`)
}

function event(sequence = 17, overrides: Partial<HarnessNativeEvent> = {}): HarnessNativeEvent {
  return HarnessNativeEventSchema.parse({ executionId: 'execution', connectionId: 'connection-1', sequence,
    type: 'assistant.delta', occurredAt: timestamp, payload: { text: `event-${sequence}` }, ...overrides })
}

async function nextSequence(pool: pg.Pool) {
  return (await pool.query<{ value: string }>(
    "select native_event_next_sequence::text as value from harness_executions where id='execution'",
  )).rows[0]!.value
}

async function counts(pool: pg.Pool) {
  return (await pool.query<{ events: number; activity: number }>(`select
    (select count(*)::integer from harness_native_events) as events,
    (select count(*)::integer from run_activity where kind='harness_output') as activity`)).rows[0]
}

async function waitForBlocked(pool: pg.Pool, waiter: number, holder: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(`select
      $2::integer=any(pg_blocking_pids($1::integer)) and
      exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') as blocked`, [waiter, holder])
    if (result.rows[0]?.blocked) return
    await delay(10)
  }
  throw new Error('The second PostgreSQL transaction never reached the forced execution-lock wait.')
}

/** Start the second statement BEFORE the first commits and prove its database lock wait. */
async function forcedRace(pool: pg.Pool, first: HarnessNativeEvent, second: HarnessNativeEvent) {
  const a = await pool.connect(); const b = await pool.connect()
  let secondWrite: Promise<void> | undefined
  try {
    const holder = (await a.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    const waiter = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    expect(holder).not.toBe(waiter)
    await a.query('begin isolation level read committed')
    await b.query('begin isolation level read committed')
    await b.query("set local statement_timeout='10s'")
    await appendNativeEvent(a, first)
    secondWrite = appendNativeEvent(b, second)
    void secondWrite.catch(() => undefined) // Observe failures while the test polls the independent observer.
    await waitForBlocked(pool, waiter, holder)
    await a.query('commit')
    await secondWrite
    await b.query('commit')
  } finally {
    // Release the holder BEFORE awaiting the waiter, including on a failed assertion.
    await a.query('rollback')
    await secondWrite?.catch(() => undefined)
    await b.query('rollback')
    a.release(); b.release()
  }
}

describe('PR17 F10 PostgreSQL event allocation', () => {
  it('forces the stale-snapshot race; stores both events and their Activity references exactly once', async () => {
    await database(async (pool) => {
      const first = event(17); const second = event(18)
      await forcedRace(pool, first, second)
      const stored = await pool.query<{ sequence: number; source_sequence: number; record: HarnessNativeEvent; activity_count: number }>(`select
        n.sequence,n.source_sequence,n.record,count(a.sequence)::integer as activity_count
        from harness_native_events n left join run_activity a on a.harness_execution_id=n.execution_id
          and (a.payload->>'nativeEventSequence')::integer=n.sequence and a.kind='harness_output'
        group by n.execution_id,n.sequence order by n.sequence`)
      expect(stored.rows.map((row) => row.sequence)).toEqual([0, 1])
      expect(stored.rows.map((row) => row.source_sequence)).toEqual([17, 18])
      for (const row of stored.rows) {
        expect(row.record.sequence).toBe(row.sequence)
        expect(row.activity_count).toBe(1)
      }
      const before = await nextSequence(pool)
      await appendNativeEvent(pool, first)
      await appendNativeEvent(pool, second)
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe(before)
      for (const original of [first, second]) {
        await expect(appendNativeEvent(pool, { ...original, payload: { text: 'different history' } }))
          .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT', status: 409 })
      }
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe(before)
    })
  }, 20_000)

  it('forces concurrent exact replay to remain a no-op after waiting for the first commit', async () => {
    await database(async (pool) => {
      const original = event()
      await forcedRace(pool, original, original)
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      expect(await nextSequence(pool)).toBe('1')
    })
  }, 20_000)

  it('distinguishes connections even when their source sequence restarts at the same value', async () => {
    await database(async (pool) => {
      await forcedRace(pool, event(0), event(0, { connectionId: 'connection-2' }))
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect((await pool.query('select sequence from harness_native_events order by sequence')).rows).toEqual([{ sequence: 0 }, { sequence: 1 }])
    })
  }, 20_000)

  it('does not serialize different executions, even in the same Run', async () => {
    await database(async (pool) => {
      const a = await pool.connect(); const b = await pool.connect()
      try {
        await a.query('begin')
        await appendNativeEvent(a, event())
        await b.query('begin')
        await b.query("set local lock_timeout='2s'")
        await appendNativeEvent(b, event(0, { executionId: 'other-execution' }))
        await b.query('commit') // Must finish while a still owns its execution row.
        expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
        await a.query('commit')
        expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      } finally {
        await a.query('rollback'); await b.query('rollback')
        a.release(); b.release()
      }
    })
  })

  it('keeps event, counter and Activity atomic in caller-owned and autocommit transactions', async () => {
    await database(async (pool) => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await appendNativeEvent(client, event())
        expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
        await client.query('rollback')
        expect(await nextSequence(pool)).toBe('0')
        // Exercise an autocommit Client, not just a Pool or an explicit transaction.
        await appendNativeEvent(client, event())
        expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      } finally { await client.query('rollback'); client.release() }
      await pool.query("alter table run_activity add constraint reject_fixture_activity check (payload->>'nativeEventType' <> 'fixture.reject')")
      await expect(appendNativeEvent(pool, event(18, { type: 'fixture.reject' }))).rejects.toMatchObject({ code: '23514' })
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      expect(await nextSequence(pool)).toBe('1')
    })
  })

  it('preserves legacy identity, rejects changed legacy history, and advances the high-water mark', async () => {
    await database(async (pool) => {
      const legacy = event(41)
      delete legacy.connectionId
      await appendNativeEvent(pool, legacy)
      await appendNativeEvent(pool, legacy)
      await expect(appendNativeEvent(pool, { ...legacy, payload: { text: 'conflict' } }))
        .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
      await appendNativeEvent(pool, event(0))
      expect((await pool.query('select sequence from harness_native_events order by sequence')).rows).toEqual([{ sequence: 41 }, { sequence: 42 }])
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe('43')
    })
  })

  it('fails closed at integer sequence exhaustion without wrapping, while exact replay still works', async () => {
    await database(async (pool) => {
      await pool.query("update harness_executions set native_event_next_sequence=2147483647 where id='execution'")
      await appendNativeEvent(pool, event())
      await appendNativeEvent(pool, event())
      await expect(appendNativeEvent(pool, event(18))).rejects.toMatchObject({ code: '22003' })
      expect(await nextSequence(pool)).toBe('2147483648')
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
    })
  })
})

describe('PR17 F10 migration 1702', () => {
  it('applies on a fresh database and is a receipt-controlled no-op on restart', async () => {
    await database(async (pool) => {
      expect(await nextSequence(pool)).toBe('0')
      const receipts = (await pool.query('select * from application_migrations order by version')).rows
      await appendNativeEvent(pool, event())
      await applyApplicationMigrations(pool)
      expect((await pool.query('select * from application_migrations order by version')).rows).toEqual(receipts)
      expect(await nextSequence(pool)).toBe('1')
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      const fn = await pool.query("select provolatile,prosecdef from pg_proc where oid='append_harness_native_event(jsonb)'::regprocedure")
      expect(fn.rows).toEqual([{ provolatile: 'v', prosecdef: false }])
    })
  })

  it('upgrades the actual existing PR17 migration level without changing event history; rollback is restart-safe', async () => {
    await database(async (pool) => {
      const legacy = event(7); delete legacy.connectionId
      const connected = event(41, { connectionId: 'previous-connection' })
      await pool.query(`insert into harness_native_events(execution_id,sequence,record,connection_id,source_sequence)
        values('execution',7,$1::jsonb,null,null),('execution',41,$2::jsonb,'previous-connection',3)`, [JSON.stringify(legacy), JSON.stringify(connected)])
      for (const sequence of [7, 41]) {
        await pool.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          values('run','harness','harness_output','execution',$1,jsonb_build_object('nativeEventSequence',$2::integer,'nativeEventType','assistant.delta'))`, [timestamp, sequence])
      }
      const oldEvents = (await pool.query('select * from harness_native_events order by sequence')).rows
      const oldActivity = (await pool.query('select * from run_activity order by sequence')).rows
      const oldReceipts = (await pool.query('select * from application_migrations order by version')).rows
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select pg_advisory_xact_lock($1)', [810_001])
        await client.query(nativeEventSequenceMigration.sql)
        await client.query('insert into application_migrations(version) values(1702)')
        await client.query('rollback') // Simulated failed deployment: DDL/backfill/receipt all roll back.
      } finally { await client.query('rollback'); client.release() }
      expect((await pool.query("select to_regprocedure('append_harness_native_event(jsonb)') as fn")).rows[0].fn).toBeNull()
      expect((await pool.query('select * from application_migrations order by version')).rows).toEqual(oldReceipts)
      await applyApplicationMigrations(pool)
      expect(await nextSequence(pool)).toBe('42')
      expect((await pool.query('select * from harness_native_events order by sequence')).rows).toEqual(oldEvents)
      expect((await pool.query('select * from run_activity order by sequence')).rows).toEqual(oldActivity)
      await appendNativeEvent(pool, legacy)
      await appendNativeEvent(pool, { ...connected, sequence: 3 })
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      await appendNativeEvent(pool, event(0))
      expect(await nextSequence(pool)).toBe('43')
      await applyApplicationMigrations(pool)
      expect(await nextSequence(pool)).toBe('43')
      expect((await pool.query('select * from application_migrations where version<>1702 order by version')).rows).toEqual(oldReceipts)
      expect((await pool.query('select version from application_migrations where version=1702')).rowCount).toBe(1)
      expect(await counts(pool)).toEqual({ events: 3, activity: 3 })
    }, true)
  })
})
