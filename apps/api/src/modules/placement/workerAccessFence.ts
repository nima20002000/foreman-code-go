import type pg from 'pg'
import { readAcceptedPlacement } from './persistence.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'

/** Existing worker authentication AND mutation transactions call this with their
 * own connection. Same-transaction registration SHARE locks prevent revocation
 * from racing an App decision/command. No worker gets database credentials. */
export async function assertActiveWorkerPlacement(sql: Pick<pg.PoolClient, 'query'>, executionId: string): Promise<void> {
  const row = (await sql.query<{ run_id: string; workflow_node_id: string }>('select run_id,workflow_node_id from harness_executions where id=$1', [executionId])).rows[0]
  if (!row) throw new DomainError('AUTH_REVOKED', 'The original execution is unavailable.', 401)
  const placement = await readAcceptedPlacement(sql, row.run_id, row.workflow_node_id)
  if (!placement || placement.hostRef.kind === 'main') return // original unplaced/main-local behavior
  if (!placement.registration) throw new DomainError('AUTH_REVOKED', 'The accepted execution has no device authority.', 401)
  const registration = await assertDeviceHostInstallation(sql, placement.hostRef, placement.registration.workerInstallationId)
  if (!registration || registration.keyRevision !== placement.registration.keyRevision || registration.authorizationRevision !== placement.registration.authorizationRevision) {
    throw new DomainError('AUTH_REVOKED', 'The accepted device grant is no longer active.', 401)
  }
}
