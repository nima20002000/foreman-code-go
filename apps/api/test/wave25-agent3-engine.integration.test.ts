import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepeatGraphBatchV3Schema, reduceRepeatGraphPageV3 } from '@graphql/contracts/wave25'
import { readRepeatGraphPage, readRepeatGraphSnapshot } from '../src/modules/run-graph/repeatReader.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { br1002Response } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

/** Actual engine, SQL owners, coordinator, capture and approval services.
 * Only external provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('Current production engine provider wiring', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each([1, 2] as const)('executes %i approval branches through exact native claims and terminal receipts', async (branches) => {
    const t = await checkpointRuntimeFixture(branches)
    try {
      await t.engine.start(t.f.run.id)
      expect((await t.runs.get(t.f.run.id))?.executionState).toBe('waiting')
      const pending = await t.pending(); expect(pending).toHaveLength(branches)
      for (const interaction of pending) await t.service.respond({ kind: 'user', principal: t.principal }, br1002Response(interaction))
      await expect.poll(async () => (await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
      expect(t.provider.counts).toMatchObject({ sessions: branches + 1, starts: branches + 1, responses: branches })
      const effects = await t.db.pool.query<{ effect_kind: string; count: string }>(
        'select effect_kind,count(*)::text as count from run_graph_effects where run_id=$1 group by effect_kind', [t.f.run.id])
      expect(Object.fromEntries(effects.rows.map((row) => [row.effect_kind, Number(row.count)])))
        .toMatchObject({ 'execution.launch': branches + 1, 'result.accept': branches + 1 })
      const bodies = await t.db.pool.query<{ payload: string }>("select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [t.f.run.id])
      expect(bodies.rows.flatMap((row) => RepeatGraphBatchV3Schema.parse(JSON.parse(row.payload)).events)
        .some((event) => event.fact.type === 'repeat.run.state' && event.fact.state.executionState === 'completed')).toBe(true)
    } finally { await t.close() }
  }, 60000)
  it('terminal Start replay leaves accepted results and provider calls unchanged', async () => {
    const t = await checkpointRuntimeFixture()
    try {
      await t.engine.start(t.f.run.id)
      await t.service.respond({ kind: 'user', principal: t.principal }, br1002Response((await t.pending())[0]!))
      await expect.poll(() => t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
      const accepted = () => t.db.pool.query("select entity_id,effect_digest,first_sequence::text from run_graph_effects where run_id=$1 and effect_kind='result.accept' order by entity_id", [t.f.run.id]).then((result) => result.rows)
      const receipts = await accepted(), counts = { ...t.provider.counts }
      await t.engine.start(t.f.run.id)
      expect(t.provider.counts).toEqual(counts)
      expect(await accepted()).toEqual(receipts)
      await expect.poll(async () => (await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
    } finally { await t.close() }
  }, 60000)
  it('an uncommitted Stop cannot cancel a waiting native session', async () => {
    const t = await checkpointRuntimeFixture()
    try {
      await t.engine.start(t.f.run.id)
      const cancel = vi.spyOn(t.native, 'cancelRun')
      await expect(t.engine.cancel(t.f.run.id)).rejects.toMatchObject({ code: 'REPEAT_STOP_AUTHORIZATION_REQUIRED' })
      expect(cancel).not.toHaveBeenCalled()
      expect((await t.runs.get(t.f.run.id))?.executionState).toBe('waiting')
      const request = { scope: t.f.scope, protocolVersion: 1 }
      const before = await readRepeatGraphSnapshot(t.db.pool, request, async () => undefined)
      await t.stop()
      expect(await t.engine.cancel(t.f.run.id)).toBe(true)
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('canceled')
      expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
      const after = await readRepeatGraphSnapshot(t.db.pool, request, async () => undefined)
      const page = await readRepeatGraphPage(t.db.pool, { ...request, afterSequence: before.asOfSequence }, async () => undefined)
      if (page.kind !== 'page') throw new Error('Unexpected Stop graph reset')
      expect(reduceRepeatGraphPageV3(before, page)).toEqual(after)
      expect(after.state.interactions).toEqual([])
    } finally { await t.close() }
  }, 60000)
})
