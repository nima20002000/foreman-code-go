import type pg from 'pg'
import { DomainError } from '../errors.js'
import { PostgresSourceReservations, type SourceReservation } from './reservations.js'
import type { PrivateSourceSnapshotStore } from './store.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'

/** Failed commands cannot resume capture. Keep their files and charge their measured footprint. */
export async function reconcileFailedCaptures(
  pool: pg.Pool,
  store: Pick<PrivateSourceSnapshotStore, 'retainedCaptureBytes' | 'manifest'>,
  report: (error: unknown) => void,
): Promise<void> {
  const candidates = await pool.query<{ snapshot_id: string; requested_by: string; command_id: string }>(`select
    a.snapshot_id,a.requested_by,a.command_id from source_approvals a
    join source_storage_reservations r on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
    where (a.state='failed' and r.state='uncertain')
      or (a.state='capturing' and r.state in ('preparing','uncertain')) order by a.snapshot_id limit 100`)
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
        const row = (await sql.query<{ record: SourceReservation; state: string; workspace_id: string }>(
          `select r.record,a.state,a.workspace_id
          from source_approvals a join source_storage_reservations r
            on r.owner_kind='capture' and r.owner_id=a.snapshot_id::text
              and r.reservation_id::text=(a.origin#>>'{reservation,reservationId}')
          where a.snapshot_id=$1 and ((a.state='failed' and r.state='uncertain')
            or (a.state='capturing' and r.state in ('preparing','uncertain')))
            and not exists(select 1 from source_snapshots s where s.snapshot_id=a.snapshot_id)
          for update of a,r`, [candidate.snapshot_id])).rows[0]
        if (row) {
          if (row.record.ownerKind !== 'capture' || row.record.ownerId !== candidate.snapshot_id) {
            throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'Failed capture reservation changed.', 409)
          }
          if (row.state === 'capturing') {
            try {
              const principal = await readLiveManagementPrincipal(sql, candidate.requested_by)
              const scope = { workspaceId: row.workspace_id }
              requireAuthorization(principal, 'sources:approve', scope)
              requireAuthorization(principal, 'sources:read', scope)
              requireAuthorization(principal, 'workspace_locations:read', scope)
              // The original live caller can still replay and adopt the committed snapshot.
              await sql.query('commit')
              continue
            } catch (error) {
              if (!(error instanceof DomainError) || error.status !== 403) throw error
            }
            try {
              await store.manifest(candidate.snapshot_id)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              // Without a finalized manifest, another capture writer may still own these bytes.
              await sql.query('commit')
              continue
            }
            await sql.query("update source_approvals set state='failed' where snapshot_id=$1 and state='capturing'",
              [candidate.snapshot_id])
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
