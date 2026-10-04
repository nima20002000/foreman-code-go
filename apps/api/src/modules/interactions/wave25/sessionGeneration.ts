import { GraphSequenceSchema, assertNativeGraphProjectionAuthority, sameGraphScope } from '@foreman-code/contracts/wave25'
import type { NativeGraphProjectionGuard } from '../../run-graph/records.js'
import type { RunGraphPublication } from '../../run-graph/publication.js'
import type { WriterFence } from '../coordination.js'
import { fail } from './context.js'

/** Called by the existing native owner BEFORE issuing a replacement attachment's
 * credential. It changes an existing session fence, not its identity or grants.
 * Never call this from a ping, reconnect timer or unqualified observation. */
export async function advanceApprovalSessionGeneration(publication: RunGraphPublication, writer: WriterFence,
  nextGeneration: string, guard: NativeGraphProjectionGuard): Promise<void> {
  GraphSequenceSchema.parse(nextGeneration)
  if (!sameGraphScope(publication.scope, guard.expected.scope)
    || BigInt(nextGeneration) !== BigInt(guard.expected.connectionGeneration) + 1n
    || BigInt(nextGeneration) > 2147483647n) return fail('GRAPH_STALE_GENERATION')
  const sql = publication.sql, key = guard.expected.key
  assertNativeGraphProjectionAuthority(guard.expected, await guard.readCurrentLocked(sql, publication.scope, key))
  const changed = await sql.query(`update native_session_lanes l set revision=revision+1,
    record=jsonb_set(jsonb_set(record,'{revision}',to_jsonb(revision+1)),
      '{connectionGeneration}',to_jsonb($3::integer)),updated_at=clock_timestamp()
    where l.id=$1 and l.record->>'leaseToken'=$2 and (l.record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
      and l.record->>'connectionGeneration'=$4 and exists(
        select 1 from execution_native_sessions s join harness_executions e on e.id=s.execution_id
        where e.id=$5 and e.run_id=$6 and e.workflow_node_id=$7 and e.attempt=$8
          and e.agent_id=l.owner_agent_id and e.record->>'agentConfigurationVersionId'=$9
          and s.reference->>'nativeSessionId'=l.native_session_id and s.reference->>'harness'=l.harness)`,
  [writer.id, writer.token, nextGeneration, guard.expected.connectionGeneration, key.execution.executionId,
    publication.scope.runId, key.execution.workflowNodeId, key.execution.attempt, key.execution.agentConfigurationVersionId])
  if (changed.rowCount !== 1) return fail('SESSION_LANE_LEASE_LOST')
  // Existing credentials deliberately retain their old session/generation pins.
  // A newly qualified owner must issue its own credential; old replies stay denied.
}
