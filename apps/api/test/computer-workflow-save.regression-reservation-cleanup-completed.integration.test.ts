import { expect, it, vi } from 'vitest'
import { reservationCleanupWorkflow, completeReservationCleanupWorkflow } from './helpers/reservationCleanupWorkflow.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'
import type { SourceReservation } from '../src/modules/sources/reservations.js'

it('defers reservation cleanup without waiting on a locked completed Run', async () => {
  const fixture = await reservationCleanupWorkflow()
  try {
    const started = await fixture.start()
    const runId = started.run.id
    const completed = await completeReservationCleanupWorkflow(fixture, runId)
    expect(completed.run.outcome).toBe('succeeded')
    const owner = await RunOwnership.acquire(fixture.db.pool, runId, () => {})
    try { expect(owner).toBeDefined() } finally { await owner?.release() }
    const reservation = (await fixture.db.pool.query<{ record: SourceReservation; state: string }>(
      `select s.record,s.state from source_storage_reservations s
       join execution_dispatch_intents i on i.operation_id=s.owner_id
       where i.run_id=$1 and s.owner_kind='materialization' and s.state<>'reclaimed'`, [runId])).rows[0]
    expect(reservation).toBeDefined()
    if (!reservation) throw new Error('The completed workflow has no retained source reservation.')
    await fixture.db.pool.query("update source_storage_reservations set state='uncertain' where reservation_id=$1",
      [reservation.record.reservationId])
    const transaction = await fixture.db.pool.connect()
    try {
      await transaction.query('begin')
      await transaction.query('select id from runs where id=$1 for update', [runId])
      const reclaim = vi.fn(async () => ({ closures: [] }))
      const cleanup = new MaterializationReservationCleanup(fixture.db.pool, reclaim)
      expect(await cleanup.reconcile()).toBe(0)
      expect(reclaim).not.toHaveBeenCalled()
      const retained = await transaction.query<{ state: string; record: SourceReservation }>(
        'select state,record from source_storage_reservations where reservation_id=$1',
        [reservation.record.reservationId])
      expect(retained.rows[0]).toEqual({ state: 'uncertain', record: reservation.record })
    } finally {
      try { await transaction.query('rollback') } finally { transaction.release() }
      await fixture.db.pool.query('update source_storage_reservations set state=$2 where reservation_id=$1',
        [reservation.record.reservationId, reservation.state])
    }
  } finally {
    await fixture.close()
  }
}, 240_000)
