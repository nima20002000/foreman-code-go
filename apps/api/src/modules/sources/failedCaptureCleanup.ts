import type pg from 'pg'
import { DomainError } from '../errors.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { PrivateSourceSnapshotStore } from './store.js'

/** Failed commands cannot resume capture. Keep their files and charge their measured footprint. */
export async function reconcileFailedCaptures(
  pool: pg.Pool,
  store: Pick<PrivateSourceSnapshotStore, 'retainedCaptureBytes'>,
  report: (error: unknown) => void,
): Promise<void> {
  const candidates = await pool.query<{ snapshot_id: string; requested_by: string; command_id: string }>(`select
    a.snapshot_id,a.requested_by,a.command_id from source_approvals a
    join source_storage_reservations r on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
    where a.state='failed' and r.state='uncertain' order by a.snapshot_id limit 100`)
  const reservations = new PostgresSourceReservations()
  for (const candidate of candidates.rows) {
    const sql = await pool.connect()
    try {
      await sql.query('begin')
      const lock = (await sql.query<{ locked: boolean }>(
        'select pg_try_advisory_xact_lock(hashtext($1)) as locked',
        [`command:${candidate.requested_by}:source.approve:${candidate.command_id}`],
      )).rows[0]
      if (lock?.locked) {
        const row = (await sql.query<{ record: SourceReservation }>(`select r.record
          from source_approvals a join source_storage_reservations r
            on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
              and r.reservation_id::text=(a.origin#>>'{reservation,reservationId}')
          where a.snapshot_id=$1 and a.state='failed' and r.state='uncertain'
            and not exists(select 1 from source_snapshots s where s.snapshot_id=a.snapshot_id)
          for update of a,r`, [candidate.snapshot_id])).rows[0]
        if (row) {
          if (row.record.ownerKind !== 'capture' || row.record.ownerId !== candidate.snapshot_id) {
            throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'Failed capture reservation changed.', 409)
          }
          const bytes = await store.retainedCaptureBytes(candidate.snapshot_id)
          await reservations.retain(sql, row.record, 'retained', bytes + 16 * 1024)
        }
      }
      await sql.query('commit')
    } catch (error) {
      await sql.query('rollback')
      report(error)
    } finally { sql.release() }
  }
}
