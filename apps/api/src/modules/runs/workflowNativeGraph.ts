import { DurableInteractionSchema, HarnessExecutionSchema, type DurableInteraction, type HarnessNativeEvent,
  type NativeSessionReference } from '@graphql/contracts'
import { RunGraphScopeSchema, WorkflowRunV2Schema, type NativeGraphProjectionKey } from '@graphql/contracts/wave25'
import type { RunOwnership } from './ownership.js'
import { withRunGraphPublication } from '../run-graph/publication.js'
import { appendNativeGraphEvent, nativeGraphSource } from '../run-graph/nativeIngestion.js'
import { nativeDisconnectObservation, normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import { appendNormalizedNativeEvent } from './nativeEvents.js'
import { readNativeGraphCorrelation, type NativeGraphProjectionGuard } from '../run-graph/records.js'
import { PostgresNativeGraphProjectionWriter } from '../run-graph/nativeWriter.js'
import { DomainError } from '../errors.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import { matchingDeliveryEvidence, type NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import { recordWorkerResumption } from '../interactions/wave25/resume.js'
import type { NativeHistory } from '../harnesses/port.js'
import { nativeProjectionId } from '../run-graph/nativeProjection.js'

export interface WorkflowNativeLease {
  id: string
  token: string
  providerId?: string
  live: boolean
}
export interface WorkflowApprovalCorrelation { interaction: DurableInteraction; nativeTurnId: string }
export interface WorkflowContinuationProof {
  session: NativeSessionReference
  providerId: string
  correlationId: string
  responseDeliveries: readonly NativeResponseDeliveryEvidence[]
}

/** The existing Run owner and native writer supply separate live fences. A
 * history replay without the original writer can retain raw history, but cannot
 * invent a fresh graph correlation or promote a previous connection to current. */
export async function appendWorkflowNativeGraphEvent(owner: RunOwnership, input: HarnessNativeEvent,
  lease?: WorkflowNativeLease, approval?: WorkflowApprovalCorrelation,
  continuation?: WorkflowContinuationProof): Promise<void> {
  owner.assertOwned()
  const found = (await owner.client.query<{ record: unknown }>('select record from runs where id=$1', [owner.runId])).rows[0]
  const run = WorkflowRunV2Schema.parse(found?.record)
  const scope = RunGraphScopeSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 2 })
  const normalized = normalizeNativeProducerEvent(input)
  await withRunGraphPublication(owner.oneShotConnection(), scope, async (publication) => {
    const sql = publication.sql
    const stored = (await sql.query<{ record: unknown }>(
      'select record from harness_executions where id=$1 and run_id=$2 for update', [input.executionId, owner.runId])).rows[0]
    const execution = HarnessExecutionSchema.parse(stored?.record)
    const key: NativeGraphProjectionKey = { execution: { workflowNodeId: execution.workflowNodeId,
      executionId: execution.id, agentId: execution.agentId,
      agentConfigurationVersionId: execution.agentConfigurationVersionId!, attempt: execution.attempt },
    workKind: 'workflow', workId: execution.id }
    const terminal = continuation && ['turn.completed', 'turn/completed'].includes(normalized.event.type)
      && normalized.event.payload.turnId === continuation.providerId
      && continuation.correlationId === `execution:${execution.id}`
      && continuation.session.nativeSessionId === execution.nativeSessionId
    const delivered = terminal ? (await sql.query<{ record: unknown }>(`select record from durable_interactions
      where run_id=$1 and execution_id=$2 and status='delivered' order by id limit 1001 for update`,
    [scope.runId, execution.id])).rows.map((row) => DurableInteractionSchema.parse(row.record)) : []
    const approvalRecord = approval ? DurableInteractionSchema.parse((await sql.query<{ record: unknown }>(
      'select record from durable_interactions where id=$1 for update', [approval.interaction.id])).rows[0]?.record) : undefined
    if (delivered.length > 1000 || continuation && continuation.responseDeliveries.length > 1000) {
      throw new DomainError('GRAPH_RESUME_LIMIT', 'The native continuation evidence exceeds the Run bound.', 409)
    }
    const raw = await appendNormalizedNativeEvent(sql, normalized)
    if (raw.rejected || !lease || execution.state === 'completed' || !execution.nativeSessionId) return
    const lane = (await sql.query<{ record: { leaseToken?: string; leaseExpiresAt?: string; connectionGeneration: number;
      currentTurnOrMessageId?: string }; harness: string; native_session_id: string; owner_agent_id: string }>(
      'select record,harness,native_session_id,owner_agent_id from native_session_lanes where id=$1 for update', [lease.id])).rows[0]
    if (!lane || lane.record.leaseToken !== lease.token || !lane.record.leaseExpiresAt
      || Date.parse(lane.record.leaseExpiresAt) <= Date.now() || lane.owner_agent_id !== execution.agentId
      || lane.native_session_id !== execution.nativeSessionId) throw new DomainError('SESSION_LANE_LEASE_LOST',
      'The native writer is no longer the current workflow owner.', 409)
    const ownerFence = await owner.readOneShotFence(sql)
    const generation = String(lane.record.connectionGeneration)
    const guard: NativeGraphProjectionGuard = { expected: { scope, key, ownerId: lease.token,
      fence: ownerFence.fence, connectionGeneration: generation },
    readCurrentLocked: async (transaction) => {
      const currentFence = await owner.readOneShotFence(transaction)
      const currentExecution = (await transaction.query<{ record: unknown }>(
        'select record from harness_executions where id=$1 and run_id=$2 for update', [execution.id, owner.runId])).rows[0]
      const current = HarnessExecutionSchema.parse(currentExecution?.record)
      const currentLane = (await transaction.query<{ record: { leaseToken?: string; leaseExpiresAt?: string;
        connectionGeneration: number }; harness: string; native_session_id: string; owner_agent_id: string }>(
        'select record,harness,native_session_id,owner_agent_id from native_session_lanes where id=$1 for update', [lease.id])).rows[0]
      const currentKey: NativeGraphProjectionKey = { execution: { workflowNodeId: current.workflowNodeId,
        executionId: current.id, agentId: current.agentId,
        agentConfigurationVersionId: current.agentConfigurationVersionId!, attempt: current.attempt },
      workKind: 'workflow', workId: current.id }
      const held = !!currentLane && currentLane.record.leaseToken === lease.token
        && !!currentLane.record.leaseExpiresAt && Date.parse(currentLane.record.leaseExpiresAt) > Date.now()
        && currentLane.owner_agent_id === current.agentId && currentLane.native_session_id === current.nativeSessionId
        && current.state !== 'completed'
      return { scope, key: currentKey, ownerId: currentLane?.record.leaseToken ?? 'lost', fence: currentFence.fence,
        connectionGeneration: String(currentLane?.record.connectionGeneration ?? 0), ownership: held ? 'held' : 'lost',
        access: held ? 'project' : 'observe' }
    } }
    beforeGraphCommit(sql, async () => {
      await owner.readOneShotFence(sql)
      const held = await sql.query(`select 1 from native_session_lanes where id=$1
        and record->>'leaseToken'=$2 and (record->>'leaseExpiresAt')::timestamptz>clock_timestamp()
        and record->>'connectionGeneration'=$3`, [lease.id, lease.token, generation])
      if (held.rowCount !== 1) throw new DomainError('SESSION_LANE_LEASE_LOST',
        'The native writer lease expired before graph publication committed.', 409)
    })
    const correlationKey = `execution:${execution.id}`
    const prior = await readNativeGraphCorrelation(sql, scope, key, correlationKey)
    if (!prior && !lease.live) return
    if (prior && (prior.connectionId !== (normalized.event.connectionId ?? null)
      || String(prior.connectionGeneration) !== generation)) return
    if (!prior) {
      await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, scope, null, {
        key, correlationKey, provider: lane.harness as 'codex' | 'opencode', nativeSessionId: execution.nativeSessionId,
        connectionId: normalized.event.connectionId ?? null, connectionGeneration: lane.record.connectionGeneration,
        nativeTurnId: lease.providerId ?? null, nativeRequestId: null,
        interactionId: null, reviewJobId: null, firstNativeSequence: String(normalized.event.sequence),
        lastNativeSequence: String(normalized.event.sequence), terminalNativeSequence: null, metadataRevision: '0',
      }, guard)
    }
    if (prior && !prior.nativeTurnId && lease.providerId) {
      await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, scope, prior.metadataRevision, {
        ...prior, nativeTurnId: lease.providerId,
        metadataRevision: String(BigInt(prior.metadataRevision) + 1n),
      }, guard)
    }
    if (approval) {
      const current = approvalRecord!
      if (current.runId !== scope.runId || current.executionId !== execution.id
        || current.nativeSessionId !== execution.nativeSessionId
        || current.nativeRequestId !== approval.interaction.nativeRequestId
        || current.graphThreadId !== scope.runId || !approval.nativeTurnId
        || lease.providerId && lease.providerId !== approval.nativeTurnId) {
        throw new DomainError('GRAPH_SCOPE_MISMATCH', 'The approval does not belong to the current native turn.', 409)
      }
      const anchored = await readNativeGraphCorrelation(sql, scope, key, correlationKey)
      if (!anchored || anchored.connectionId !== (normalized.event.connectionId ?? null)
        || String(anchored.connectionGeneration) !== generation) {
        throw new DomainError('GRAPH_STALE_GENERATION', 'The approval source has no current native correlation.', 409)
      }
      const approvalKey = `approval:${current.id}`
      const saved = await readNativeGraphCorrelation(sql, scope, key, approvalKey)
      if (!saved) await new PostgresNativeGraphProjectionWriter().persistCorrelation(sql, scope, null, {
        key, correlationKey: approvalKey, provider: anchored.provider, nativeSessionId: anchored.nativeSessionId,
        connectionId: anchored.connectionId, connectionGeneration: anchored.connectionGeneration,
        nativeTurnId: approval.nativeTurnId, nativeRequestId: current.nativeRequestId,
        interactionId: current.id, reviewJobId: null, firstNativeSequence: anchored.firstNativeSequence,
        lastNativeSequence: anchored.lastNativeSequence, terminalNativeSequence: null, metadataRevision: '0',
      }, guard)
      else if (saved.interactionId !== current.id || saved.nativeRequestId !== current.nativeRequestId
        || saved.nativeTurnId !== approval.nativeTurnId || saved.connectionId !== anchored.connectionId) {
        throw new DomainError('GRAPH_SOURCE_CONFLICT', 'The approval native correlation changed.', 409)
      }
    }
    const observation = nativeDisconnectObservation(scope, key, normalized.event, generation)
    await appendNativeGraphEvent(publication, normalized.event, [{ guard, correlationKey,
      ...(observation ? { observation } : {}) }])
    if (terminal) {
      const currentRun = (await sql.query<{ open: boolean }>(`select stop_requested_at is null
        and execution_state in ('running','waiting','queued') as open from runs where id=$1`, [scope.runId])).rows[0]
      if (!currentRun?.open) return
      const history: NativeHistory = { events: [], pendingInteractions: [],
        responseDeliveries: continuation.responseDeliveries }
      for (const interaction of delivered) {
        if (!matchingDeliveryEvidence(interaction, continuation.session, history)) continue
        const receipt = await sql.query(`select 1 from run_graph_effects where run_id=$1
          and effect_kind='graph.resume' and entity_id=$2`, [scope.runId, interaction.id])
        if (!receipt.rowCount) continue
        await recordWorkerResumption(publication, { type: 'worker.resumed', interactionId: interaction.id,
          requester: key.execution, acknowledgementId: nativeProjectionId('continuation-ack',
            interaction.id, normalized.event.executionId, normalized.event.connectionId ?? null,
            normalized.event.sequence) }, nativeGraphSource(normalized.event), guard)
      }
    }
  })
}
