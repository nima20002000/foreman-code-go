import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import type pg from 'pg'
import { CURRENT_NATIVE_ACTIVITIES_SQL } from '../../src/modules/run-graph/currentActivity.js'
import { measureGraphStorage } from '../../src/modules/run-graph/measurements.js'
import type { SeededGraph } from './postgresFixture.js'

interface Plan { name: string; relations: string[]; explain: unknown }
function relations(input: unknown, found = new Set<string>()): string[] {
  if (input && typeof input === 'object') {
    const object = input as Record<string, unknown>
    if (typeof object['Relation Name'] === 'string') found.add(object['Relation Name'])
    for (const value of Object.values(object)) if (value && typeof value === 'object') relations(value, found)
  }
  return [...found].sort()
}
async function samples(read: () => Promise<unknown>) {
  const values: number[] = []
  for (let index = 0; index < 20; index++) {
    const start = performance.now()
    await read()
    values.push(performance.now() - start)
  }
  const sorted = [...values].sort((a, b) => a - b)
  return { unit: 'milliseconds', count: values.length, samples: values, median: sorted[10], p95: sorted[18] }
}

/** EXPLICIT qualification only. Never invoke on production or from a product polling path. */
export async function qualifyLongHistory(pool: pg.Pool, fixture: SeededGraph, read: () => Promise<unknown>) {
  const current = (await pool.query<{ schema: string }>('select current_schema() as schema')).rows[0]?.schema
  if (process.env.RUN_WAVE25_A5_LONG_HISTORY !== '1' || !/^wave25_a5_[0-9a-f]{32}$/.test(current ?? '')) {
    throw new Error('Long-history qualification requires the isolated A5 disposable schema')
  }
  const before = await samples(read), storageBefore = await measureGraphStorage(pool)
  const client = await pool.connect()
  try {
    await client.query('begin')
    // Direct synthetic inserts intentionally do not publish graph facts. No model,
    // native process, historical handoff backfill, or source renumbering is involved.
    await client.query(`insert into harness_native_events(execution_id,sequence,connection_id,source_sequence,record)
      select $1,1000000+n,'a5-history',n,jsonb_build_object('executionId',$1::text,
        'sequence',1000000+n,'connectionId','a5-history','type','message.delta',
        'occurredAt',$2::text,'payload',jsonb_build_object('text',repeat('synthetic ',32)))
      from generate_series(1,100000) as series(n)`, [fixture.key.workId, fixture.createdAt])
    await client.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      select $1,'harness','harness_output',$2,$3::timestamptz,
        jsonb_build_object('nativeEventSequence',1000000+n,'nativeEventType','message.delta')
      from generate_series(1,100000) as series(n)`, [fixture.run.id, fixture.key.workId, fixture.createdAt])
    await client.query('update harness_executions set native_event_next_sequence=greatest(native_event_next_sequence,1100001) where id=$1', [fixture.key.workId])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  for (const table of ['harness_native_events', 'run_activity', 'run_native_activity', 'run_graph_batches', 'run_graph_sources']) {
    // Table names are a fixed local allowlist, never caller input.
    await pool.query(`analyze ${table}`)
  }
  const statements: { name: string; sql: string; values: unknown[] }[] = [
    { name: 'actual-current-native-activities', sql: CURRENT_NATIVE_ACTIVITIES_SQL, values: [fixture.run.id, null, 3001] },
    { name: 'G1-complete-batch-metadata', sql: `select b.sequence::text,b.kind,b.payload_bytes from run_graph_batches b
      where b.run_id=$1 and b.sequence>$2::bigint and b.sequence<=$3::bigint order by b.sequence limit $4`,
      values: [fixture.run.id, '0', '9223372036854775807', 16] },
    { name: 'G1-node-resolutions', sql: 'select record from run_node_resolutions where run_id=$1 order by workflow_node_id limit 1001', values: [fixture.run.id] },
    { name: 'G1-input-bindings', sql: 'select record from run_input_bindings where run_id=$1 order by recipient_execution_id,input_ordinal limit 8001', values: [fixture.run.id] },
    { name: 'current-execution-identities', sql: `select e.id,e.workflow_node_id,e.record->>'agentId' as agent_id,
      e.record->>'agentConfigurationVersionId' as configuration_id,e.attempt,e.record->>'state' as state
      from harness_executions e where e.run_id=$1 order by e.workflow_node_id,e.id limit $2`, values: [fixture.run.id, 1001] },
  ]
  const plans: Plan[] = []
  for (const statement of statements) {
    const plan = (await pool.query(`explain (analyze,buffers,format json) ${statement.sql}`, statement.values)).rows[0]?.['QUERY PLAN'] as unknown
    plans.push({ name: statement.name, relations: relations(plan), explain: plan })
  }
  const history = await pool.query<{ count: string }>(
    "select count(*)::text as count from harness_native_events where execution_id=$1 and connection_id='a5-history'", [fixture.key.workId])
  const report = { kind: 'synthetic-disposable-database-evidence', rawHistoryRows: Number(history.rows[0]!.count),
    before, after: await samples(read), plans, storageBefore, storageAfter: await measureGraphStorage(pool),
    qualification: 'Representative current queries and local samples, not a production throughput guarantee or renderer profile.' }
  const output = process.env.WAVE25_A5_EVIDENCE_PATH
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return report
}
