import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { counts, event, forcedRace, nextSequence, withSharedAllocationDatabase } from './pr17-native-event-allocation.test-support.js'

describe('PostgreSQL native event allocation races', () => {
  const database = withSharedAllocationDatabase()

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

  it('publishes Activity in commit order across different executions of the same Run', async () => {
    await database(async (pool) => {
      await forcedRace(pool, event(), event(0, { executionId: 'other-execution' }))
      const activity = await pool.query<{ sequence: string; harness_execution_id: string }>(`
        select sequence::text, harness_execution_id from run_activity
        where run_id='run' and kind='harness_output' order by run_activity.sequence`)
      expect(activity.rows.map((row) => row.harness_execution_id)).toEqual(['execution', 'other-execution'])
      expect(BigInt(activity.rows[0]!.sequence)).toBeLessThan(BigInt(activity.rows[1]!.sequence))
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      const events = await pool.query(`select execution_id, sequence from harness_native_events order by execution_id`)
      expect(events.rows).toEqual([
        { execution_id: 'execution', sequence: 0 },
        { execution_id: 'other-execution', sequence: 0 },
      ])
    })
  }, 20_000)

  it('does not serialize different executions when native events produce no Activity', async () => {
    await database(async (pool) => {
      const a = await pool.connect()
      const b = await pool.connect()
      const payload = { nativeMethod: 'item/agentMessage/delta', text: 'stream chunk' }
      try {
        await a.query('begin')
        await appendNativeEvent(a, event(17, { payload }))
        await b.query('begin')
        await b.query("set local lock_timeout='2s'")
        await appendNativeEvent(b, event(0, { executionId: 'other-execution', payload }))
        await b.query('commit') // Must finish while a still owns its execution row.
        expect(await counts(pool)).toEqual({ events: 1, activity: 0 })
        await a.query('commit')
        expect(await counts(pool)).toEqual({ events: 2, activity: 0 })
      } finally {
        await a.query('rollback')
        await b.query('rollback')
        a.release()
        b.release()
      }
    })
  })

})
