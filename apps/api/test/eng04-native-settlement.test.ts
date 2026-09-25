import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, type DurableInteraction, type HarnessExecution } from '@graphql/contracts'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { decisionDigest } from '../src/modules/interactions/wave25/publication.js'
import { settleRepeatNativeExecutionLocked } from '../src/modules/interactions/repeatNativeSettlement.js'
import { nativeAt, nativeCompleted, nativeFixture } from './eng04-native-fixtures.js'

/** A scripted pg-shaped transaction, NOT a PostgreSQL/native integration test.
 * It executes the real settlement and readWorkflowClosure functions. Unknown
 * queries fail rather than returning empty rows, so newly added gates require
 * an explicit fixture update. No fake Worker acknowledgement is written. */
class NativePgShape {
  readonly fixture = nativeFixture()
  execution = nativeCompleted(this.fixture.execution)
  semantics = '3'
  negativeCleanup = false
  session = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: this.execution.nativeSessionId! }
  hasSession = true
  finalized = false
  hasClosure = true
  generation = '17'
  priorUnclosed = false
  closed = true
  closureIdentity: Record<string, unknown> | null = null
  replaceGenerationOnSecondRead = false
  closureReads = 0
  resourcesOutstanding = false
  possibleSubmission = false
  configurationPinned = true
  updateCount = 0
  casMatches = true
  interactions: Array<{ value: DurableInteraction; retired: boolean }> = []
  resume: { state: string; approval_native_ack_id: string | null } | null = { state: 'resumed', approval_native_ack_id: 'real-history-ack' }
  resumeDigest: string | null = null
  readonly calls: string[] = []
  readonly reviewerRows: Array<Record<string, unknown>> = []

  identity(execution: HarnessExecution) {
    return { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
      agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
      attempt: execution.attempt,
      ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
      ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}) }
  }
  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const q = text.replace(/\s+/g, ' ').trim()
    this.calls.push(q)
    const rows = (result: unknown[]) => ({ rows: result, rowCount: result.length })
    if (q.startsWith('begin ') || q === 'commit' || q === 'rollback') return rows([])
    if (q.startsWith("select id,record->>'executionSemanticsVersion'")) {
      expect(values).toEqual([this.execution.runId])
      return rows([{ id: this.execution.runId, semantics: this.semantics, workspace_id: this.fixture.scope.workspaceId, workflow_id: this.fixture.scope.workflowId, pins_match: true, negative_cleanup: this.negativeCleanup }])
    }
    if (q.startsWith('select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions')) {
      expect(values).toEqual([this.execution.id, this.execution.runId])
      return rows([{ id: this.execution.id, run_id: this.execution.runId, workflow_node_id: this.execution.workflowNodeId,
        agent_id: this.execution.agentId, attempt: this.execution.attempt, record: this.execution }])
    }
    if (q.startsWith('select j.id,j.execution_id,j.state,j.record')) {
      expect(q).toContain('(i.run_id=$1) as same_run')
      expect(q).toContain('i.execution_id=$2 or j.execution_id=$2')
      return rows(this.reviewerRows)
    }
    if (q.startsWith('select i.id,i.execution_id,i.status,i.record')) {
      expect(q).toContain("original.source_id=i.id")
      return rows(this.interactions.filter(({ value }) => value.id > String(values[2])).map(({ value, retired }) => ({
        id: value.id, execution_id: value.executionId, status: value.status, record: value, retired,
      })))
    }
    if (q.startsWith('select state,approval_native_ack_id from interaction_graph_resumes')) return rows(this.resume ? [this.resume] : [])
    if (q.startsWith('select effect_digest from run_graph_effects')) return rows(this.resumeDigest ? [{ effect_digest: this.resumeDigest }] : [])
    if (q.startsWith('select ( exists(select 1 from worker_credential_bindings')) {
      expect(q).toContain('p.revoked_at is null')
      expect(q).toContain('b.run_id is distinct from $2')
      expect(q).toContain('a.graph_thread_id is distinct from $2')
      expect(q).toContain('a.approval_wait_started_at is not null')
      return rows([{ outstanding: this.resourcesOutstanding }])
    }
    if (q.startsWith('select reference,workflow_finalized_at')) return rows(this.hasSession ? [{ reference: this.session, finalized: this.finalized }] : [])
    if (q.startsWith('select c.record#>>')) return rows([{ harness: 'codex', agent_id: this.execution.agentId,
      workspace_id: this.fixture.scope.workspaceId, pinned: this.configurationPinned }])
    if (q.startsWith('select c.generation::text,c.execution_identity')) {
      if (!this.hasClosure) return rows([])
      this.closureReads++
      return rows([{ generation: this.replaceGenerationOnSecondRead && this.closureReads > 1 ? '18' : this.generation,
        execution_identity: this.closureIdentity ?? this.identity(this.execution), expected_reference: this.session,
        closed_reference: this.session, closed: this.closed, prior_unclosed: this.priorUnclosed,
        record: this.execution, reference: this.session }])
    }
    if (q.startsWith('select ( exists(select 1 from run_graph_effects')) {
      expect(q).toContain("effect_kind='execution.launch'")
      expect(q).toContain('execution_native_closures')
      expect(q).toContain('harness_native_events')
      expect(q).toContain('run_native_correlations')
      expect(q).toContain('worker_credential_bindings')
      return rows([{ possible_submission: this.possibleSubmission }])
    }
    if (q.startsWith('update execution_native_sessions')) {
      expect(q).toContain('reference=$2::jsonb')
      if (!this.casMatches) return rows([])
      this.finalized = true
      this.updateCount++
      return rows([{ execution_id: this.execution.id }])
    }
    throw new Error(`Unhandled SQL shape: ${q}`)
  }
  async settle(): Promise<void> {
    const original = this.finalized
    const connection = new ExclusiveGraphConnection(this as unknown as pg.ClientBase, () => undefined)
    try { await connection.transaction((sql) => settleRepeatNativeExecutionLocked(sql, this.execution.runId, this.execution)) }
    catch (error) { this.finalized = original; throw error }
    finally { await connection.close() }
  }
  delivered() {
    const value = DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex,
      id: 'native-interaction-one', executionId: this.execution.id, runId: this.execution.runId,
      workspaceId: this.fixture.scope.workspaceId, workflowId: this.fixture.scope.workflowId,
      graphThreadId: this.execution.runId, requestingAgentId: this.execution.agentId, nativeSessionId: this.execution.nativeSessionId,
      graphInterruptId: 'exact-interrupt-one', status: 'delivered', deliveryState: 'delivered', deliveredAt: nativeAt,
      selectedOptionId: 'codex-approve-once', selectedSemantic: 'approve_once', nativeResponse: { decision: 'accept' }, decidedAt: nativeAt,
    })
    this.interactions = [{ value, retired: false }]
    this.resumeDigest = graphSourceDigest({ interactionId: value.id, runId: value.runId, executionId: value.executionId,
      graphThreadId: value.graphThreadId, graphInterruptId: value.graphInterruptId, decision: decisionDigest(value) })
    return value
  }
}

describe('ENG04 native SQL-shaped exact per-execution settlement', () => {
  it('finalizes a closed execution while its Run is still running, and replays without a second write', async () => {
    const sql = new NativePgShape(), before = structuredClone(sql.execution)
    await sql.settle()
    await sql.settle()
    expect(sql.finalized).toBe(true)
    expect(sql.updateCount).toBe(1)
    expect(sql.execution).toEqual(before)
    expect(sql.calls.some((q) => /update harness_executions|update runs|approval_native_ack_id\s*=|insert/.test(q))).toBe(false)
  })
  it('recovers after a process restart using durable close, without an in-memory manager', async () => {
    const sql = new NativePgShape()
    // This fixture has no manager, fake native acknowledgment or native callback.
    await sql.settle()
    expect(sql.closureReads).toBe(4) // Entry and before-COMMIT both recheck current and final close generations.
    expect(sql.finalized).toBe(true)
  })
  it.each(['hasClosure', 'closed'] as const)('keeps %s uncertainty open even when workflow finalization was previously set', async (key) => {
    const sql = new NativePgShape()
    sql.finalized = true
    sql[key] = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
  it('rejects an older unclosed generation and a changed current generation', async () => {
    const sql = new NativePgShape()
    sql.priorUnclosed = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    sql.priorUnclosed = false
    sql.closureReads = 0
    sql.replaceGenerationOnSecondRead = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.finalized).toBe(false)
  })
  it('rejects a closure belonging to a different execution identity', async () => {
    const sql = new NativePgShape()
    sql.closureIdentity = { ...sql.identity(sql.execution), attempt: 2 }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
    expect(sql.finalized).toBe(false)
  })
  it('requires actual credential, budget and reviewer settlement', async () => {
    const sql = new NativePgShape()
    sql.resourcesOutstanding = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
  it.each(['uncertain', 'submitted', 'blocked_busy'])('blocks an exact reviewer job still %s', async (state) => {
    const sql = new NativePgShape()
    const job = { id: 'job-one', interactionId: 'native-interaction-one', reviewerAgentId: 'agent-review', attempt: 1,
      state, provider: 'codex', nativeSessionId: sql.session.nativeSessionId,
      correlationId: 'review:job-one', createdAt: nativeAt, updatedAt: nativeAt }
    sql.reviewerRows.push({ id: job.id, execution_id: sql.execution.id, state, record: job, run_id: sql.execution.runId, same_run: true })
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
  it('does not silently drop a reviewer binding crossed to another Run', async () => {
    const sql = new NativePgShape()
    const job = { id: 'job-one', interactionId: 'native-interaction-one', reviewerAgentId: 'agent-review', attempt: 1,
      state: 'completed', provider: 'codex', nativeSessionId: sql.session.nativeSessionId,
      correlationId: 'review:job-one', createdAt: nativeAt, updatedAt: nativeAt }
    sql.reviewerRows.push({ id: job.id, execution_id: sql.execution.id, state: job.state, record: job, run_id: 'other-run', same_run: false })
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
  })
  it('rejects a changed accepted configuration or finalization compare-and-swap', async () => {
    const sql = new NativePgShape()
    sql.configurationPinned = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    sql.configurationPinned = true
    sql.casMatches = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.finalized).toBe(false)
  })
  it.each(['1', '2', '4'])('does not claim semantics %s through the repeat-only gate', async (semantics) => {
    const sql = new NativePgShape()
    sql.semantics = semantics
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
  })
  it('does not infer native success from an absent session row', async () => {
    const sql = new NativePgShape()
    sql.hasSession = false
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_BOUNDARY_PENDING' })
  })
  it('keeps a negative execution without a native row pending until original no-dispatch proof exists', async () => {
    const sql = new NativePgShape()
    sql.hasSession = false
    sql.execution = { id: sql.execution.id, runId: sql.execution.runId, workflowNodeId: 'review', agentId: 'agent-review',
      agentConfigurationVersionId: 'config-review', attempt: 1, input: {}, createdAt: nativeAt,
      state: 'completed', finishedAt: nativeAt, result: { outcome: 'failed', error: { code: 'ADMISSION_FAILED', message: 'not launched', retryable: false } } }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_BOUNDARY_PENDING' })
    expect(sql.updateCount).toBe(0)
    sql.possibleSubmission = true
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_BOUNDARY_PENDING' })
  })
  it('requires delivery, checkpoint consumption and real native acknowledgment separately', async () => {
    const sql = new NativePgShape()
    sql.delivered()
    sql.resume = { state: 'resumed', approval_native_ack_id: null }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    sql.resume = { state: 'resuming', approval_native_ack_id: 'real-history-ack' }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    sql.resume = { state: 'resumed', approval_native_ack_id: 'real-history-ack' }
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_APPROVAL_SOURCE_PROOF_REQUIRED' })
    expect(sql.finalized).toBe(false)
  })
  it.each(['workspaceId', 'workflowId', 'providerVersion'] as const)('rejects an approval from another %s', async (key) => {
    const sql = new NativePgShape(), delivered = sql.delivered()
    sql.interactions = [{ value: DurableInteractionSchema.parse({ ...delivered, [key]: 'other' }), retired: false }]
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(sql.updateCount).toBe(0)
  })
  it('requires the exact same-command checkpoint digest, not just an existing effect row', async () => {
    const sql = new NativePgShape()
    sql.delivered()
    sql.resumeDigest = `sha256:${'f'.repeat(64)}`
    await expect(sql.settle()).rejects.toMatchObject({ code: 'REPEAT_APPROVAL_RECEIPT_CONFLICT' })
    sql.resumeDigest = null
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(sql.finalized).toBe(false)
  })
  it('allows negative Stop retirement without inventing a positive acknowledgment', async () => {
    const sql = new NativePgShape(), delivered = sql.delivered()
    sql.interactions = [{ value: DurableInteractionSchema.parse({ ...delivered, status: 'canceled' }), retired: true }]
    sql.resume = null
    sql.resumeDigest = null
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    sql.negativeCleanup = true
    await sql.settle()
    expect(sql.finalized).toBe(true)
    expect(sql.resume).toBeNull()
    expect(sql.execution.result?.outcome).toBe('succeeded') // Preserved pre-Stop business evidence.
  })
  it('refuses canceled interaction cleanup without its canonical retirement receipt', async () => {
    const sql = new NativePgShape(), delivered = sql.delivered()
    sql.negativeCleanup = true
    sql.interactions = [{ value: DurableInteractionSchema.parse({ ...delivered, status: 'canceled' }), retired: false }]
    await expect(sql.settle()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(sql.updateCount).toBe(0)
  })
})
