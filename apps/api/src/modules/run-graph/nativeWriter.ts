import {
  NativeGraphActivityRecordSchema, NativeGraphCorrelationRecordSchema, GraphSequenceSchema,
  assertNativeGraphProjectionAuthority, canonicalGraphJson, sameGraphScope,
  type NativeGraphActivityRecord, type NativeGraphCorrelationRecord, type NativeGraphProjectionKey,
  type RunGraphScope,
} from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, poisonGraphTransaction, type GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'
import { assertRunGraphPublication } from './publication.js'
import {
  readNativeGraphActivity, readNativeGraphCorrelation,
  type NativeGraphProjectionGuard, type NativeGraphProjectionWriter,
} from './records.js'

/** The G1 writer port. All methods require the caller's Run -> head -> domain lock order. */
export class PostgresNativeGraphProjectionWriter implements NativeGraphProjectionWriter {
  private async authorize(sql: GraphTransactionSql, scope: RunGraphScope, key: NativeGraphProjectionKey, guard: NativeGraphProjectionGuard): Promise<void> {
    assertGraphTransaction(sql)
    assertRunGraphPublication(sql, scope)
    if (!guard || typeof guard.readCurrentLocked !== 'function' || !sameGraphScope(guard.expected.scope, scope)
      || canonicalGraphJson(guard.expected.key) !== canonicalGraphJson(key)) throw new RunGraphError('GRAPH_AUTHORITY_INVALID')
    assertNativeGraphProjectionAuthority(guard.expected, await guard.readCurrentLocked(sql, scope, key))
  }
  async persistActivity(sql: GraphTransactionSql, scope: RunGraphScope, previousRevision: string | null,
    input: NativeGraphActivityRecord, guard: NativeGraphProjectionGuard): Promise<void> {
    try {
      const next = NativeGraphActivityRecordSchema.parse(input)
      await this.authorize(sql, scope, next.key, guard)
      const previous = await readNativeGraphActivity(sql, scope, next.key)
      assertRevision(previousRevision, previous?.projectionRevision, next.projectionRevision)
      if (next.activity.execution && canonicalGraphJson(next.activity.execution) !== canonicalGraphJson(next.key.execution)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      if (previous?.lastNativeSequence !== undefined && previous.lastNativeSequence !== null
        && (next.lastNativeSequence === null || BigInt(next.lastNativeSequence) < BigInt(previous.lastNativeSequence))) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      if (previous?.terminalNativeSequence !== undefined && previous.terminalNativeSequence !== null
        && (next.terminalNativeSequence !== previous.terminalNativeSequence || ['active', 'stale'].includes(next.activity.status))) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      if (['active', 'stale'].includes(next.activity.status)) {
        const closed = await sql.query<{ stopped: boolean; execution_state: string; work_closed: boolean }>(
          `select r.stop_requested_at is not null as stopped,r.execution_state,
            case when $3='workflow' then e.record->>'state'='completed'
              else exists(select 1 from review_jobs j where j.id=$4 and j.execution_id=e.id
                and (j.record->>'state'='completed' or j.record->'cleanup'->>'completedAt' is not null)) end as work_closed
           from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2`,
          [scope.runId, next.key.execution.executionId, next.key.workKind, next.key.workId])
        const row = closed.rows[0]
        if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        if (row.stopped) throw new RunGraphError('GRAPH_STOP_CONFLICT')
        // Settlement may continue after a Run outcome; it must not be advertised as fresh native work.
        if (row.work_closed || ['completed', 'interrupted'].includes(row.execution_state)) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      }
      const values = [scope.runId, next.key.execution.executionId, next.key.execution.workflowNodeId,
        next.key.execution.attempt, next.key.workKind, next.key.workId, next.lastNativeSequence,
        next.terminalNativeSequence, next.projectionRevision, canonicalGraphJson(next.activity)]
      const result = previousRevision === null
        ? await sql.query(`insert into run_native_activity(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,
            last_native_sequence,terminal_native_sequence,projection_revision,activity)
          values($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9::bigint,$10::jsonb)
          on conflict(run_id,execution_id,work_kind,work_id) do nothing returning execution_id`, values)
        : await sql.query(`update run_native_activity set last_native_sequence=$7::bigint,terminal_native_sequence=$8::bigint,
            projection_revision=$9::bigint,activity=$10::jsonb
          where run_id=$1 and execution_id=$2 and workflow_node_id=$3 and attempt=$4 and work_kind=$5 and work_id=$6
            and projection_revision=$11::bigint returning execution_id`, [...values, previousRevision])
      if (result.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
  async persistCorrelation(sql: GraphTransactionSql, scope: RunGraphScope, previousRevision: string | null,
    input: NativeGraphCorrelationRecord, guard: NativeGraphProjectionGuard): Promise<void> {
    try {
      const next = NativeGraphCorrelationRecordSchema.parse(input)
      await this.authorize(sql, scope, next.key, guard)
      if (String(next.connectionGeneration) !== guard.expected.connectionGeneration) throw new RunGraphError('GRAPH_STALE_GENERATION')
      const previous = await readNativeGraphCorrelation(sql, scope, next.key, next.correlationKey)
      assertRevision(previousRevision, previous?.metadataRevision, next.metadataRevision)
      const host = await sql.query<{ session: string | null; provider: string | null; interaction_id: string | null; turn_id: string | null }>(
        `select case when $3='review' then j.record->>'nativeSessionId' else e.record->>'nativeSessionId' end as session,
          case when $3='review' then j.record->>'provider' else c.record->'harness'->>'harness' end as provider,
          j.interaction_id, j.record->>'providerTurnOrMessageId' as turn_id
         from harness_executions e join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
         left join review_jobs j on $3='review' and j.id=$4 and j.execution_id=e.id
         where e.run_id=$1 and e.id=$2`, [scope.runId, next.key.execution.executionId, next.key.workKind, next.key.workId])
      const row = host.rows[0]
      if (!row || row.session !== next.nativeSessionId || row.provider !== next.provider
        || (next.key.workKind === 'review' && (row.interaction_id !== next.interactionId
          || (row.turn_id !== null && next.nativeTurnId !== row.turn_id)))) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      if (previous) {
        if (next.connectionGeneration !== previous.connectionGeneration) {
          const activity = await readNativeGraphActivity(sql, scope, next.key)
          // The owner must publish an unknown/none activity fence BEFORE rotating
          // the correlation. A transport-open or reconnect cannot preserve old work.
          if (activity && ['active', 'stale'].includes(activity.activity.status)) throw new RunGraphError('GRAPH_STALE_GENERATION')
        }
        if (previous.nativeSessionId !== next.nativeSessionId || previous.provider !== next.provider
          || previous.interactionId !== next.interactionId || previous.reviewJobId !== next.reviewJobId
          || (previous.nativeTurnId !== null && previous.nativeTurnId !== next.nativeTurnId)
          || (previous.nativeRequestId !== null && previous.nativeRequestId !== next.nativeRequestId)
          || BigInt(next.firstNativeSequence) > BigInt(previous.firstNativeSequence)
          || BigInt(next.lastNativeSequence) < BigInt(previous.lastNativeSequence)
          || next.connectionGeneration < previous.connectionGeneration) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
        if (previous.terminalNativeSequence !== null && previous.terminalNativeSequence !== next.terminalNativeSequence) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      }
      const values = [scope.runId, next.key.execution.executionId, next.key.execution.workflowNodeId, next.key.execution.attempt,
        next.key.workKind, next.key.workId, next.correlationKey, next.provider, next.nativeSessionId, next.connectionId,
        next.connectionGeneration, next.nativeTurnId, next.nativeRequestId, next.interactionId, next.reviewJobId,
        next.firstNativeSequence, next.lastNativeSequence, next.terminalNativeSequence, next.metadataRevision]
      const result = previousRevision === null
        ? await sql.query(`insert into run_native_correlations(run_id,execution_id,workflow_node_id,attempt,work_kind,work_id,
            correlation_key,provider,native_session_id,connection_id,connection_generation,native_turn_id,native_request_id,
            interaction_id,review_job_id,first_native_sequence,last_native_sequence,terminal_native_sequence,metadata_revision)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::bigint,$17::bigint,$18::bigint,$19::bigint)
          on conflict(run_id,execution_id,work_kind,work_id,correlation_key) do nothing returning execution_id`, values)
        : await sql.query(`update run_native_correlations set connection_id=$10,connection_generation=$11,native_turn_id=$12,
            native_request_id=$13,first_native_sequence=$16::bigint,last_native_sequence=$17::bigint,
            terminal_native_sequence=$18::bigint,metadata_revision=$19::bigint
          where run_id=$1 and execution_id=$2 and workflow_node_id=$3 and attempt=$4 and work_kind=$5 and work_id=$6
            and correlation_key=$7 and provider=$8 and native_session_id=$9 and interaction_id is not distinct from $14
            and review_job_id is not distinct from $15 and metadata_revision=$20::bigint returning execution_id`, [...values, previousRevision])
      if (result.rowCount !== 1) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
}
function assertRevision(expected: string | null, actual: string | undefined, next: string): void {
  if ((actual ?? null) !== expected || (expected !== null && !GraphSequenceSchema.safeParse(expected).success)
    || BigInt(next) !== (expected === null ? 0n : BigInt(expected) + 1n)) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
}
