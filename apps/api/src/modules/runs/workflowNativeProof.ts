import { assertOriginalWorkflowTerminal } from '../interactions/workflowTerminalSource.js'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { DurableInteractionSchema, HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution, type HarnessNativeEvent } from '@graphql/contracts'
import { canonicalGraphJson, type GraphEvidence, type NativeGraphProjectionKey, type AcceptedWorkflowRunV3 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { currentRunGraphPublication } from '../run-graph/publication.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { WorkflowNativeCapture, WorkflowNativeVerificationPort } from '../interactions/workflowNativeCapture.js'
import { assertRepeatNativeUpdate } from '../interactions/repeatNativeEvidence.js'
import { readRepeatExecutionLocked, type StoredRepeatExecution } from './repeatPostgres.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { prepareRepeatNativeUpdate } from './repeatNode.js'
import type { RepeatNativeBoundaryEvidence, RepeatNativeEvidence } from './repeatNativeRepository.js'
import { assertWorkflowNativeEntryPermitLocked, readWorkflowNativeEntryLocked, workflowNativeReservation } from './workflowNativeEntry.js'
import { repeatDigest, repeatExecutionIdentity, repeatId, sameRepeatValue, type RepeatNodeRef, type RepeatScope } from './repeatResolution.js'
import type { RunOwnership } from './ownership.js'
import { matchingDeliveryEvidence } from '../interactions/delivery.js'
import { recordWorkerResumption } from '../interactions/wave25/resume.js'
import type { NativeGraphProjectionGuard } from '../run-graph/records.js'
import { createRequestLocked } from '../interactions/wave25/decisions.js'
import { nativeApprovalContext } from '../interactions/nativeApprovalContext.js'
import { appendWorkflowNativeGraphEventLocked, type WorkflowApprovalCorrelation, type WorkflowContinuationProof, type WorkflowNativeLease } from './workflowNativeGraph.js'

/** Durable private ORIGINAL-source record. No payload/session/token reaches the
 * graph feed: G1 publishes only its immutable digest and ordinary graph facts. */
export interface WorkflowNativeProofRecord {
  proofId: string
  scope: RepeatScope
  ref: RepeatNodeRef
  execution: ReturnType<typeof repeatExecutionIdentity>
  inputDigest: string
  commandId: string
  session: WorkflowNativeCapture['session']
  original: WorkflowNativeCapture['source']
  observedAt: string
  ownerId: string
  ownerFence: string
  lifetimeGeneration: number
  closureGeneration: string
  lane: WorkflowNativeCapture['lane']
}
function fail(code = 'NATIVE_SOURCE_IDENTITY_CONFLICT'): never {
  throw new DomainError(code, 'The original native source does not match the owned execution and physical evidence.', 409)
}
function immutableExecution(execution: HarnessExecution) {
  return { identity: repeatExecutionIdentity(execution), runId: execution.runId, input: execution.input,
    createdAt: execution.createdAt, workingDirectory: execution.workingDirectory, runtimeDirectory: execution.runtimeDirectory }
}
function originalIdentity(capture: WorkflowNativeCapture): unknown {
  switch (capture.source.type) {
    case 'session_created': return ['session', capture.session]
    case 'event': return ['event', capture.source.event.connectionId ?? null, capture.source.event.sequence]
    case 'history': return ['history', repeatDigest(capture.source.history, 4 * 1024 * 1024)]
    case 'boundary': return fail('NATIVE_SOURCE_NOT_CAPTURED')
  }
}
function sourceIdentity(record: WorkflowNativeProofRecord): unknown {
  return { scope: record.scope, ref: record.ref, execution: record.execution, inputDigest: record.inputDigest,
    session: record.session, commandId: record.commandId, original: record.original }
}

/** Real SQL proof consumer paired with exactly one coordinator capture channel.
 * No native I/O, Pool acquisition, credentials, caller proof JSON, or guessed
 * no-submission/close evidence occurs inside these methods. */
export class WorkflowNativeProofServices {
  constructor(private readonly captures: WorkflowNativeVerificationPort,
    private readonly assertAdditionalPhysical?: (sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture) => Promise<void>,
    private readonly afterPersistOriginalLocked?: (sql: GraphTransactionSql, evidence: RepeatNativeEvidence, proof: WorkflowNativeProofRecord) => Promise<void>) {}

  private async current(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, executionId: string,
    owner: RunOwnership): Promise<{ stored: StoredRepeatExecution; scope: RepeatScope }> {
    assertGraphTransaction(sql); owner.assertOwned()
    if (owner.runId !== run.id) return fail('RUN_OWNERSHIP_LOST')
    const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
    if (!sameRepeatValue(snapshot.run, run)) return fail('RUN_PIN_CONFLICT')
    const stored = await readRepeatExecutionLocked(sql, snapshot, executionId)
    return { stored, scope: { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
      workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 } }
  }

  private async physical(sql: GraphTransactionSql, scope: RepeatScope, stored: StoredRepeatExecution,
    capture: WorkflowNativeCapture, owner: RunOwnership): Promise<void> {
    capture.assertCurrent(); owner.assertOwned()
    await this.assertAdditionalPhysical?.(sql, owner, capture)
    if (capture.owner !== owner || !isDeepStrictEqual(immutableExecution(capture.execution), immutableExecution(stored.execution))) return fail()
    const reservation = workflowNativeReservation(scope, stored.ref, stored.execution, stored.inputDigest)
    const entry = await readWorkflowNativeEntryLocked(sql, reservation)
    if (entry.phase !== 'entered' || !entry.transition || entry.transition.phase !== 'entered'
      || !entry.source_id || !entry.source_digest) return fail('NATIVE_ENTRY_CONFLICT')
    await assertRepeatCanonicalReceiptLocked(sql, { scope,
      evidence: { sourceKind: 'execution', sourceId: entry.source_id, sourceRevision: '1' },
      sourceDigest: entry.source_digest, effect: null })
    const sessionRow = (await sql.query<{ reference: unknown }>(
      'select reference from execution_native_sessions where execution_id=$1 for update', [stored.execution.id])).rows[0]
    if (sessionRow ? !sameRepeatValue(NativeSessionReferenceSchema.parse(sessionRow.reference), capture.session)
      : capture.source.type !== 'session_created') return fail()
    if (stored.execution.nativeSessionId !== undefined && stored.execution.nativeSessionId !== capture.session.nativeSessionId) return fail()
    const configuration = (await sql.query<{ harness: string }>(
      "select record#>>'{harness,harness}' as harness from agent_configuration_versions where id=$1 and agent_id=$2 and workspace_id=$3 for share",
      [stored.execution.agentConfigurationVersionId, stored.execution.agentId, scope.workspaceId])).rows[0]
    if (configuration?.harness !== capture.session.harness) return fail()
    if (!capture.closureGeneration && capture.source.type !== 'boundary') return fail()
    const closure = (await sql.query<{ generation: string; expected_reference: unknown; closed: boolean }>(
      `select generation::text,expected_reference,(closed_at is not null or detached_at is not null) as closed from execution_native_closures
       where execution_id=$1 order by generation desc limit 1 for update`, [stored.execution.id])).rows[0]
    if (capture.closureGeneration && (!closure || closure.generation !== capture.closureGeneration || closure.closed
      || closure.expected_reference !== null && !sameRepeatValue(closure.expected_reference, capture.session))) return fail('NATIVE_LIFETIME_CHANGED')
    if (capture.lane) {
      const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string;
        generation: string; token: string | null; correlation: string | null; provider_id: string | null; held: boolean }>(
        `select owner_agent_id,harness,native_session_id,record->>'connectionGeneration' as generation,
          record->>'leaseToken' as token,record->>'correlationId' as correlation,
          record->>'currentTurnOrMessageId' as provider_id,
          coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as held
         from native_session_lanes where id=$1 for update`, [capture.lane.id])).rows[0]
      if (!lane || lane.owner_agent_id !== stored.execution.agentId || lane.harness !== capture.session.harness
        || lane.native_session_id !== capture.session.nativeSessionId || lane.token !== capture.lane.token || !lane.held
        || lane.generation !== String(capture.lane.connectionGeneration)
        || lane.correlation !== `execution:${stored.execution.id}`
        || lane.provider_id !== null && capture.lane.providerId !== null && lane.provider_id !== capture.lane.providerId) return fail('SESSION_LANE_LEASE_LOST')
    } else if (capture.source.type === 'event' || capture.source.type === 'history') return fail('SESSION_LANE_LEASE_LOST')
    capture.assertCurrent()
  }

  async assertNativeBoundaryLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, execution: HarnessExecution,
    ref: RepeatNodeRef, evidence: RepeatNativeBoundaryEvidence, owner: RunOwnership): Promise<void> {
    assertGraphTransaction(sql)
    try {
      const { stored, scope } = await this.current(sql, run, execution.id, owner)
      if (!sameRepeatValue(stored.execution, execution) || !sameRepeatValue(stored.ref, ref)) return fail()
      if (evidence.kind === 'first_launch') {
        if (execution.nativeSessionId) return fail('NATIVE_ENTRY_CONFLICT')
        await assertWorkflowNativeEntryPermitLocked(sql, owner, evidence.permit,
          workflowNativeReservation(scope, ref, execution, stored.inputDigest))
        return
      }
      const capture = this.captures.read(evidence), fence = await owner.readOneShotFence(sql)
      await this.physical(sql, scope, stored, capture, owner)
      beforeGraphCommit(sql, async () => {
        try {
          if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) return fail('RUN_OWNERSHIP_LOST')
          await this.physical(sql, scope, stored, capture, owner)
        } catch (error) { poisonGraphTransaction(sql); throw error }
      })
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }

  private validateObservation(capture: WorkflowNativeCapture, previous: HarnessExecution, incoming: HarnessExecution): void {
    assertRepeatNativeUpdate(previous, incoming)
    if (incoming.nativeSessionId !== capture.session.nativeSessionId) return fail()
    const source = capture.source
    if (source.type === 'session_created') {
      if (previous.nativeSessionId || previous.state !== 'starting' || incoming.state !== 'running'
        || incoming.result || incoming.finishedAt || capture.kind !== 'live') return fail()
      return
    }
    if (source.type !== 'history' || !capture.lane) return fail('NATIVE_ORIGINAL_HISTORY_REQUIRED')
    const history = source.history, command = `execution:${incoming.id}`
    if (incoming.state === 'completed') {
      assertOriginalWorkflowTerminal(incoming, capture.session, history)
      const terminal = history.terminalTurn
      if (!terminal || terminal.correlationId !== command || history.correlationId !== command
        || !terminal.providerId || terminal.providerId !== history.nativeTurnId
        || terminal.providerId !== capture.lane.providerId || history.pendingInteraction
        || history.pendingInteractions.length || !sameRepeatValue(terminal.result, incoming.result)
        || incoming.finishedAt !== capture.observedAt) return fail('NATIVE_TERMINAL_EVIDENCE_MISMATCH')
    } else if (incoming.state === 'waiting') {
      if (!history.pendingInteractions.length || incoming.result || incoming.finishedAt
        || history.correlationId !== undefined && history.correlationId !== command
        || history.pendingInteractions.some((pending) => !sameRepeatValue(pending.session, capture.session)
          || !capture.lane!.providerId || pending.turn.nativeTurnId !== capture.lane!.providerId)) return fail('NATIVE_APPROVAL_EVIDENCE_MISMATCH')
    } else return fail('NATIVE_OBSERVATION_UNSUPPORTED')
  }

  /** Store the capture before normalizing the first terminal. Same-source retry
   * retains its first immutable owner/lease receipt; current authority is checked
   * independently. A reused event ID with changed original bytes is a conflict. */
  async persistOriginalLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    evidence: RepeatNativeEvidence, owner: RunOwnership,
    approval?: WorkflowApprovalCorrelation): Promise<WorkflowNativeProofRecord> {
    assertGraphTransaction(sql)
    try {
      const capture = this.captures.read(evidence)
      const { stored, scope } = await this.current(sql, run, capture.execution.id, owner)
      await this.physical(sql, scope, stored, capture, owner)
      const fence = await owner.readOneShotFence(sql)
      if (capture.source.type === 'session_created') {
        const bound = await sql.query(`insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)
          on conflict(execution_id) do update set reference=execution_native_sessions.reference
          where execution_native_sessions.reference=excluded.reference returning execution_id`,
        [stored.execution.id, canonicalGraphJson(capture.session)])
        if (bound.rowCount !== 1) return fail('NATIVE_SESSION_IDENTITY_MISMATCH')
        // Preflight issued this execution's token before its native ID existed.
        // Bind it on the SAME original-session publication, not in a second
        // transaction or at authentication. Never rebind an old/revoked token.
        const lane = (await sql.query<{ generation: string | null }>(
          `select record->>'connectionGeneration' as generation from native_session_lanes
           where harness=$1 and native_session_id=$2 and owner_agent_id=$3 for update`,
          [capture.session.harness, capture.session.nativeSessionId, stored.execution.agentId])).rows[0]
        if (!lane?.generation || !/^(0|[1-9][0-9]*)$/.test(lane.generation)) return fail('APPROVAL_SESSION_LANE_MISSING')
        await sql.query(`update worker_credential_bindings b
          set approval_native_session_id=$2,approval_connection_generation=$3::bigint
          from management_principals p where b.execution_id=$1 and b.purpose='workflow'
            and b.run_id=$4 and b.workspace_id=$5 and b.workflow_id=$6 and b.agent_id=$7
            and b.environment_variable='GRAPHQL_MCP_TOKEN'
            and b.approval_native_session_id is null and b.approval_connection_generation is null
            and b.revoked_at is null and p.id=b.principal_id and p.revoked_at is null
            and p.expires_at>clock_timestamp() and p.audience='worker' and p.agent_id=b.agent_id`,
          [stored.execution.id, capture.session.nativeSessionId, lane.generation,
            scope.runId, scope.workspaceId, scope.workflowId, stored.execution.agentId])
      }
      const proofId = repeatId('workflow-native-source', stored.execution.id, repeatDigest(originalIdentity(capture)))
      const proposed: WorkflowNativeProofRecord = { proofId, scope, ref: stored.ref,
        execution: repeatExecutionIdentity(stored.execution), inputDigest: stored.inputDigest, commandId: `execution:${stored.execution.id}`, session: capture.session,
        original: capture.source, observedAt: capture.observedAt, ownerId: fence.ownerId, ownerFence: fence.fence,
        lifetimeGeneration: capture.lifetimeGeneration, closureGeneration: capture.closureGeneration!, lane: capture.lane }
      const existing = (await sql.query<{ record: WorkflowNativeProofRecord; source_digest: string; identity_digest: string }>(
        'select record,source_digest,identity_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 for share',
        [proofId, run.id])).rows[0]
      const identityDigest = repeatDigest(sourceIdentity(proposed), 4 * 1024 * 1024)
      if (existing && (existing.identity_digest !== identityDigest || repeatDigest(existing.record, 4 * 1024 * 1024) !== existing.source_digest
        || !sameRepeatValue(sourceIdentity(existing.record), sourceIdentity(proposed)))) return fail('NATIVE_SOURCE_CONFLICT')
      const record = existing?.record ?? proposed
      if (!existing) {
        const recordJson = canonicalGraphJson(record, 4 * 1024 * 1024)
        await sql.query(`insert into workflow_native_proofs(proof_id,run_id,execution_id,identity_digest,source_digest,record,record_json)
          values($1,$2,$3,$4,$5,$6::jsonb,$7::text)`,
        [proofId, run.id, stored.execution.id, identityDigest, repeatDigest(record, 4 * 1024 * 1024), recordJson, recordJson])
      }
      const publication = currentRunGraphPublication(sql, scope)
      const receipt = await publication.retainNativeSource(owner, proofId)
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, ...receipt, effect: null })
      const history = capture.source.type === 'history' ? capture.source.history : undefined
      const terminal = history?.terminalTurn
      const continuation: WorkflowContinuationProof | undefined = terminal ? { session: capture.session,
        providerId: terminal.providerId, correlationId: terminal.correlationId,
        responseDeliveries: history!.responseDeliveries ?? [], historyEvents: history!.events } : undefined
      const lease = capture.lane ? { id: capture.lane.id, token: capture.lane.token,
        live: capture.kind === 'live', ...(capture.lane.providerId ? { providerId: capture.lane.providerId } : {}) } : undefined
      const events = capture.source.type === 'event' ? [capture.source.event]
        : history?.events.map((event) => ({ ...event, executionId: stored.execution.id })) ?? []
      for (const event of events) {
        await this.physical(sql, scope, stored, capture, owner)
        await appendWorkflowNativeGraphEventLocked(sql, owner, event, lease, approval, continuation)
      }
      if (history?.terminalTurn && capture.lane) {
        await this.publishContinuations(sql, run, stored, scope, capture, record, owner)
      }
      beforeGraphCommit(sql, async () => {
        try {
          if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) return fail('RUN_OWNERSHIP_LOST')
          await this.physical(sql, scope, stored, capture, owner)
        } catch (error) { poisonGraphTransaction(sql); throw error }
      })
      await this.afterPersistOriginalLocked?.(sql, evidence, structuredClone(record))
      return structuredClone(record)
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }

  async appendEventLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, event: HarnessNativeEvent,
    evidence: RepeatNativeEvidence, owner: RunOwnership, lease?: WorkflowNativeLease,
    approval?: WorkflowApprovalCorrelation, continuation?: WorkflowContinuationProof): Promise<void> {
    const capture = this.captures.read(evidence)
    if (capture.source.type !== 'event' || !sameRepeatValue(capture.source.event, event)
      || lease && (!capture.lane || lease.id !== capture.lane.id || lease.token !== capture.lane.token
        || (lease.providerId ?? null) !== capture.lane.providerId || lease.live !== (capture.kind === 'live'))
      || continuation !== undefined || approval !== undefined) return fail('NATIVE_SOURCE_NOT_CAPTURED')
    // Pending approvals and continuation ACKs originate only in complete captured
    // history. A loose correlation object cannot enrich a raw event's authority.
    await this.persistOriginalLocked(sql, run, evidence, owner)
  }

  private async publishContinuations(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    stored: StoredRepeatExecution, scope: RepeatScope, capture: WorkflowNativeCapture,
    original: WorkflowNativeProofRecord, owner: RunOwnership): Promise<void> {
    if (capture.source.type !== 'history' || !capture.lane) return fail('NATIVE_ORIGINAL_HISTORY_REQUIRED')
    const history = capture.source.history, terminal = history.terminalTurn
    if (!terminal || history.correlationId !== `execution:${stored.execution.id}` || terminal.correlationId !== history.correlationId
      || terminal.providerId !== history.nativeTurnId || terminal.providerId !== capture.lane.providerId
      || history.pendingInteraction || history.pendingInteractions.length) return
    assertOriginalWorkflowTerminal(stored.execution, capture.session, history)
    const publication = currentRunGraphPublication(sql, scope)
    const rows = (await sql.query<{ record: unknown }>(`select record from durable_interactions
      where run_id=$1 and execution_id=$2 and status='delivered' order by id limit 1001 for update`,
    [run.id, stored.execution.id])).rows
    if (rows.length > 1000) return fail('GRAPH_RESUME_LIMIT')
    const fence = await owner.readOneShotFence(sql)
    const key: NativeGraphProjectionKey = { execution: repeatExecutionIdentity(stored.execution),
      workKind: 'workflow', workId: stored.execution.id }
    const guard: NativeGraphProjectionGuard = {
      expected: { scope, key, ownerId: capture.lane.token, fence: fence.fence,
        connectionGeneration: String(capture.lane.connectionGeneration) },
      readCurrentLocked: async (transaction) => {
        if (transaction !== sql) return fail('GRAPH_TRANSACTION_CONTEXT_REQUIRED')
        await this.physical(sql, scope, stored, capture, owner)
        const current = await owner.readOneShotFence(sql)
        return { scope, key, ownerId: capture.lane!.token, fence: current.fence,
          connectionGeneration: String(capture.lane!.connectionGeneration), ownership: 'held', access: 'project' }
      },
    }
    const source: GraphEvidence = { sourceKind: 'native_event', sourceId: original.proofId, sourceRevision: '1' }
    for (const row of rows) {
      const interaction = DurableInteractionSchema.parse(row.record)
      if (!matchingDeliveryEvidence(interaction, capture.session, history)) continue
      if ((await sql.query(`select 1 from run_graph_effects where run_id=$1
        and effect_kind='graph.resume' and entity_id=$2`, [run.id, interaction.id])).rowCount !== 1) continue
      await recordWorkerResumption(publication, { type: 'worker.resumed', interactionId: interaction.id,
        requester: key.execution, acknowledgementId: repeatId('native-approval-ack', interaction.id, original.proofId) },
      source, guard, original.proofId)
    }
  }

  async assertNativeUpdateLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    previous: HarnessExecution, incoming: HarnessExecution, ref: RepeatNodeRef,
    evidence: RepeatNativeEvidence, owner: RunOwnership): Promise<WorkflowNativeProofRecord> {
    assertGraphTransaction(sql)
    try {
      const capture = this.captures.read(evidence)
      const { stored, scope } = await this.current(sql, run, previous.id, owner)
      if (!sameRepeatValue(stored.execution, previous) || !sameRepeatValue(stored.ref, ref)) return fail()
      this.validateObservation(capture, previous, incoming)
      const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
      const expected = prepareRepeatNativeUpdate(snapshot.version, scope, ref, previous, incoming)
      const source = await this.persistOriginalLocked(sql, run, evidence, owner)
      if (incoming.state === 'waiting' && capture.source.type === 'history') {
        const history = capture.source.history
        if (run.approval.handler === 'orchestrator' && run.approval.designatedOrchestratorAgentId === incoming.agentId) {
          return fail('ORCHESTRATOR_BOOTSTRAP_APPROVAL_UNSUPPORTED')
        }
        const ids = new Set<string>()
        for (const request of history.pendingInteractions) {
          if (!request.turn.nativeRequestId || ids.has(request.turn.nativeRequestId)) return fail('NATIVE_APPROVAL_EVIDENCE_MISMATCH')
          ids.add(request.turn.nativeRequestId)
          await createRequestLocked(currentRunGraphPublication(sql, scope), DurableInteractionSchema.parse({
            id: `interaction-${randomUUID()}`, revision: 0, workspaceId: run.workspaceId, workflowId: run.workflowId,
            runId: run.id, executionId: incoming.id, requestingAgentId: incoming.agentId,
            harness: capture.session.harness, providerVersion: capture.session.providerVersion,
            nativeSessionId: capture.session.nativeSessionId, nativeRequestId: request.turn.nativeRequestId,
            nativeRequestType: request.nativeRequestType, graphThreadId: run.id,
            request: request.request, responseOptions: request.responseOptions, approval: run.approval,
            reviewContext: nativeApprovalContext(request, history.events), status: 'pending', deliveryState: 'not_started',
            createdAt: source.observedAt, updatedAt: source.observedAt,
          }), source.proofId)
        }
      }
      beforeGraphCommit(sql, async () => {
        try {
          const row = (await sql.query<{ record: unknown }>('select record from harness_executions where id=$1 and run_id=$2',
            [incoming.id, run.id])).rows[0]
          if (!row || !sameRepeatValue(HarnessExecutionSchema.parse(row.record), expected)) return fail('NATIVE_SOURCE_DOMAIN_MISMATCH')
        } catch (error) { poisonGraphTransaction(sql); throw error }
      })
      return source
    } catch (error) { poisonGraphTransaction(sql); throw error }
  }
}
