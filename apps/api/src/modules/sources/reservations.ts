import { randomUUID } from 'node:crypto'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { isDeepStrictEqual } from 'node:util'
import { DomainError } from '../errors.js'

export type SourceReservation = { reservationId: string; scopeId: string; ownerKind: 'capture' | 'transfer' | 'materialization'; ownerId: string; reservedBytes: number }
export const SOURCE_AGGREGATE_LIMITS = Object.freeze({ bytes: 1024 * 1024 * 1024, preparing: 4, materializations: 2 })
/** All main processes serialize reservations for one attested host/filesystem.
 * Staging and retained copies remain charged until physical reclamation proof.
 * Expiry/disconnect never frees an execution reservation or a pending capture.
 */
export class PostgresSourceReservations {
  async reserve(sql: GraphSqlClient, request: Omit<SourceReservation, 'reservationId'>): Promise<SourceReservation> {
    if (!Number.isSafeInteger(request.reservedBytes) || request.reservedBytes < 0 || request.reservedBytes > SOURCE_AGGREGATE_LIMITS.bytes)
      throw new DomainError('SOURCE_CAPACITY', 'Invalid source disk reservation.', 409)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${request.scopeId}`])
    const existing = (await sql.query<{ record: SourceReservation; state: string }>(
      'select record,state from source_storage_reservations where owner_kind=$1 and owner_id=$2 for update', [request.ownerKind, request.ownerId])).rows[0]
    if (existing) {
      if (!isDeepStrictEqual({ ...existing.record, reservationId: undefined }, { ...request, reservationId: undefined }) || existing.state === 'reclaimed')
        throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'The source reservation identity or retained bytes changed.', 409)
      return existing.record
    }
    const totals = (await sql.query<{ bytes: string; preparing: string; materializations: string }>(`select
      coalesce(sum(reserved_bytes),0) as bytes,
      count(*) filter(where state='preparing') as preparing,
      count(*) filter(where owner_kind='materialization' and state in ('preparing','owned','uncertain')) as materializations
      from source_storage_reservations where scope_id=$1 and state<>'reclaimed'`, [request.scopeId])).rows[0]!
    if (Number(totals.bytes) + request.reservedBytes > SOURCE_AGGREGATE_LIMITS.bytes || Number(totals.preparing) >= SOURCE_AGGREGATE_LIMITS.preparing
      || (request.ownerKind === 'materialization' && Number(totals.materializations) >= SOURCE_AGGREGATE_LIMITS.materializations))
      throw new DomainError('SOURCE_CAPACITY', 'Aggregate source staging, retained copies or active materializations exhaust this host/filesystem budget.', 409)
    const reservation = { ...request, reservationId: randomUUID() }
    await sql.query(`insert into source_storage_reservations(reservation_id,scope_id,owner_kind,owner_id,reserved_bytes,state,record)
      values($1,$2,$3,$4,$5,'preparing',$6::jsonb)`, [reservation.reservationId, request.scopeId, request.ownerKind, request.ownerId, request.reservedBytes, JSON.stringify(reservation)])
    return reservation
  }
  async retain(sql: GraphSqlClient, reservation: SourceReservation, state: 'retained' | 'owned' | 'uncertain', accountedBytes = reservation.reservedBytes): Promise<void> {
    if (!Number.isSafeInteger(accountedBytes) || accountedBytes < 0 || accountedBytes > reservation.reservedBytes) throw new DomainError('SOURCE_CAPACITY', 'Invalid verified source footprint.', 409)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${reservation.scopeId}`])
    const result = await sql.query(`update source_storage_reservations set state=$2,reserved_bytes=$3 where reservation_id=$1 and state<>'reclaimed'`, [reservation.reservationId, state, accountedBytes])
    if (result.rowCount !== 1) throw new DomainError('SOURCE_RESERVATION_CONFLICT', 'Source reservation is not retained.', 409)
  }
  /** Authoritative physical deletion AND execution closure must precede this.
   * No automatic timer or client input can provide that proof. */
  async reclaimed(sql: GraphSqlClient, reservation: SourceReservation, prove: () => Promise<boolean>): Promise<void> {
    if (!await prove()) throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'Physical source reclamation is not confirmed.', 409)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${reservation.scopeId}`])
    await sql.query(`update source_storage_reservations set state='reclaimed' where reservation_id=$1`, [reservation.reservationId])
  }
}
