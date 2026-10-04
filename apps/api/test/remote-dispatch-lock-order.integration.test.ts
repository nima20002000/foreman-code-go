import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DispatchIntentSchema } from '@graphql/contracts/node-placement'
import { readReconciledDispatchIntent } from '../src/modules/runs/remote/persistence.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('remote dispatch and worker credential lock ordering', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  const schema = `dispatch_locks_${randomUUID().replaceAll('-', '')}`
  const intent = DispatchIntentSchema.parse({
    schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(), runId: 'run', nodeId: 'node',
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: randomUUID(), operationId: randomUUID(), bindingHash: 'a'.repeat(64),
    inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: randomUUID(), epoch: '1' },
  })

  beforeAll(async () => {
    database = await agent3Database()
    await database.pool.query(`create schema ${schema}`)
    await database.pool.query(`create table ${schema}.runs(id text primary key)`)
    await database.pool.query(`create table ${schema}.execution_dispatch_intents(operation_id text primary key,run_id text,record jsonb)`)
    await database.pool.query(`create table ${schema}.remote_execution_owner_reconciliations(operation_id text,ordinal integer,transition jsonb)`)
    await database.pool.query(`insert into ${schema}.runs values($1)`, [intent.runId])
    await database.pool.query(`insert into ${schema}.execution_dispatch_intents values($1,$2,$3::jsonb)`,
      [intent.operationId, intent.runId, JSON.stringify(intent)])
  })
  afterAll(async () => {
    if (!database) return
    try { await database.pool.query(`drop schema if exists ${schema} cascade`) }
    finally { await database.close() }
  })

  it('lets credential authorization finish while physical readback waits for the same Run', async () => {
    const reader = await database.pool.connect()
    const credentials = await database.pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      for (const sql of [reader, credentials]) {
        await sql.query('begin')
        await sql.query(`set local search_path to ${schema}`)
        await sql.query("set local lock_timeout='2s'")
      }
      const readerPid = (await reader.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      await credentials.query('select id from runs where id=$1 for update', [intent.runId])
      pending = (async () => {
        const value = await readReconciledDispatchIntent(reader, intent.operationId, true)
        await reader.query('select id from runs where id=$1 for share', [intent.runId])
        return value
      })()
      void pending.catch(() => undefined) // Joined below before either connection is released.
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting = (await database.pool.query<{ waiting: boolean }>(
          'select cardinality(pg_blocking_pids($1))>0 as waiting', [readerPid],
        )).rows[0]!.waiting
        if (waiting) break
        await delay(10)
      }
      expect(waiting).toBe(true)
      expect(await readReconciledDispatchIntent(credentials, intent.operationId, true)).toEqual(intent)
      await credentials.query('commit')
      expect(await pending).toEqual(intent)
      await reader.query('commit')
    } finally {
      await credentials.query('rollback')
      await pending?.catch(() => undefined)
      await reader.query('rollback')
      reader.release()
      credentials.release()
    }
  })
})
