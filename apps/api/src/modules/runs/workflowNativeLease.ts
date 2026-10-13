import { beforeGraphCommit, assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import type { RunOwnership } from './ownership.js'
import { DomainError } from '../errors.js'

type Lane = NonNullable<WorkflowNativeCapture['lane']>
interface LockedLane {
  owner: RunOwnership
  token: string
  generation: number
  leaseOwner: string
  agentId: string
  harness: string
  sessionId: string
  leaseMs: number
  expiresAt: string
}
const lockedLanes = new WeakMap<GraphTransactionSql, Map<string, LockedLane>>()

function lost(): never {
  throw new DomainError('SESSION_LANE_LEASE_LOST', 'The native publication lane changed owners.', 409)
}

/** Called only after physical capture validation has locked a live lane. */
export async function holdWorkflowNativePublicationLease(sql: GraphTransactionSql, owner: RunOwnership,
  capture: WorkflowNativeCapture, lane: Lane): Promise<void> {
  assertGraphTransaction(sql)
  let lanes = lockedLanes.get(sql)
  const previous = lanes?.get(lane.id)
  if (previous) {
    if (previous.owner !== owner || previous.token !== lane.token || previous.generation !== lane.connectionGeneration
      || previous.agentId !== capture.execution.agentId || previous.harness !== capture.session.harness
      || previous.sessionId !== capture.session.nativeSessionId) return lost()
    await renewWorkflowNativePublicationLease(sql, owner, lane.id)
    return
  }
  const row = (await sql.query<{ lease_owner: string; lease_ms: number; expires_at: string }>(
    `select record->>'leaseOwner' as lease_owner,record->>'leaseExpiresAt' as expires_at,
      greatest(1,extract(epoch from ((record->>'leaseExpiresAt')::timestamptz-updated_at))*1000)::float8 as lease_ms
      from native_session_lanes where id=$1 and record->>'leaseToken'=$2
      and record->>'connectionGeneration'=$3 and owner_agent_id=$4 and harness=$5 and native_session_id=$6
      and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp() for update`,
    [lane.id, lane.token, String(lane.connectionGeneration), capture.execution.agentId,
      capture.session.harness, capture.session.nativeSessionId])).rows[0]
  if (!row?.lease_owner) return lost()
  if (!lanes) { lanes = new Map(); lockedLanes.set(sql, lanes) }
  lanes.set(lane.id, { owner, token: lane.token, generation: lane.connectionGeneration,
    leaseOwner: row.lease_owner, agentId: capture.execution.agentId, harness: capture.session.harness,
    sessionId: capture.session.nativeSessionId, leaseMs: row.lease_ms, expiresAt: row.expires_at })
  beforeGraphCommit(sql, () => renewWorkflowNativePublicationLease(sql, owner, lane.id))
}

/** The row remains locked continuously; renew the same fence that independent heartbeats cannot reach. */
export async function renewWorkflowNativePublicationLease(sql: GraphTransactionSql, owner: RunOwnership,
  laneId: string): Promise<void> {
  assertGraphTransaction(sql)
  const lane = lockedLanes.get(sql)?.get(laneId)
  if (!lane) return
  if (lane.owner !== owner) return lost()
  await owner.readOneShotFence(sql)
  const renewed = await sql.query<{ expires_at: string }>(`update native_session_lanes set revision=revision+1,updated_at=clock_timestamp(),
    record=jsonb_set(jsonb_set(record,'{revision}',to_jsonb((revision+1)::bigint)),
      '{leaseExpiresAt}',to_jsonb(to_char((clock_timestamp()+($4 * interval '1 millisecond')) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    where id=$1 and record->>'leaseToken'=$2 and record->>'connectionGeneration'=$3
      and record->>'leaseOwner'=$5 and owner_agent_id=$6 and harness=$7 and native_session_id=$8
      and record->>'leaseExpiresAt'=$9 returning record->>'leaseExpiresAt' as expires_at`,
  [laneId, lane.token, String(lane.generation), lane.leaseMs, lane.leaseOwner, lane.agentId, lane.harness, lane.sessionId, lane.expiresAt])
  if (renewed.rowCount !== 1) return lost()
  lane.expiresAt = renewed.rows[0]!.expires_at
}
