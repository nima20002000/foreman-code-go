import { WorkRequestSchema } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatConflict, sameRepeatValue, type RepeatScope } from './repeatResolution.js'

/** Recheck the resolved request against persisted activation ancestry. */
export async function readWorkReturnRequestLocked(context: { sql: GraphTransactionSql; scope: RepeatScope },
  activationId: string, requestId: string | undefined) {
  if (requestId === undefined) return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const row = (await context.sql.query<{ record: unknown; parent_id: string | null }>(
    `select record,work_parent_request($1,$3) as parent_id
      from run_work_requests where run_id=$1 and request_id=$2 for share`,
    [context.scope.runId, requestId, activationId])).rows[0]
  if (!row) return repeatConflict('WORK_RETURN_REQUEST_MISSING')
  const request = WorkRequestSchema.parse(row.record)
  if (request.requestId !== requestId || !sameRepeatValue(request.scope, context.scope)
    || request.destinationActivationId !== activationId && row.parent_id !== requestId) {
    return repeatConflict('WORK_RETURN_ANCESTRY_CONFLICT')
  }
  return request
}
