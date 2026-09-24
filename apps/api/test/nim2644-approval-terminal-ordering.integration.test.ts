import { randomUUID } from 'node:crypto'
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph'
import { DurableInteractionSchema, HarnessExecutionSchema, type ExecutionResult, type HarnessNativeEvent } from '@graphql/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { NativeDeliveryOutcome } from '../src/modules/interactions/delivery.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { consumeDeliveredApprovals } from '../src/modules/runs/approvalCheckpointResume.js'
import { appendWorkflowNativeGraphEvent } from '../src/modules/runs/workflowNativeGraph.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { agent3Database, candidateFor, deferred, graphHead, ownedAgent3, postgresEnabled,
  seedAgent3, terminalAgent3 } from './helpers/wave25Agent3.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'

/** Real PostgreSQL, real approval outbox and real production PostgresSaver.
 * The requester events/response are provider-shaped fixtures, NOT a live Codex
 * invocation. The accepted user-handler fixture isolates the same requester-side
 * ordering shared by CC and CO; designated reviewer transport/App-MCP tests and
 * the real CC/CO matrix must still run in the orchestrator's environment.
 * No raw SQL writes fabricate a Worker ack, graph.resume receipt or native reply.
 */
describe.skipIf(!postgresEnabled)('NIM-2644 requester terminal / delayed approval PostgreSQL cuts', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  let checkpoints: ReturnType<typeof createCheckpointStore>
  const owners: RunOwnership[] = []
  beforeAll(async () => {
    db = await agent3Database()
    checkpoints = createCheckpointStore(process.env.WAVE25_TEST_DATABASE_URL!, `${db.schema}_ordering_checkpoints`)
    await checkpoints.setup()
  }, 60_000)
  afterEach(async () => { while (owners.length) await owners.pop()!.release() })
  afterAll(async () => {
    await checkpoints?.close()
    if (db) {
      await db.pool.query(`drop schema if exists ${db.schema}_ordering_checkpoints cascade`)
      await db.close()
    }
  })

  it.each(['approve-once', 'reject'] as const)('%s: CC-pending / CO-cleanup cuts stay open until exact acknowledgement', async (optionId) => {
    const f = await seedAgent3(db.pool, db.directory)
    const held = await ownedAgent3(db.pool, f)
    let { owner, store } = held; owners.push(owner)
    await store.updateRun({ executionState: 'running', outcome: 'pending' })
    await store.resolveExcluded()
    const entry = await store.admit(f.version.entryNodeId, () => candidateFor(f))
    if (entry.kind !== 'admitted') throw new Error('Entry must be admitted')
    await terminalAgent3(db.pool, store, f, entry.execution)
    await store.acceptTerminal(entry.execution.id)
    const workerId = f.version.definition.nodes.find((node) => node.id !== f.version.entryNodeId)!.id
    const admitted = await store.admit(workerId, () => candidateFor(f, workerId))
    if (admitted.kind !== 'admitted') throw new Error('Worker must be selected')
    const claimed = await store.claimLaunch(admitted.execution.id, { workingDirectory: db.directory,
      runtimeDirectory: `${db.directory}/${admitted.execution.id}` })
    if (!claimed) throw new Error('Worker needs its single first-launch claim')
    const repository = new Wave25InteractionRepository(db.pool)
    const budgets = new PostgresApprovalBudgetRepository(db.pool)
    const session = { harness: 'codex' as const, providerVersion: 'synthetic-ordering-codex', nativeSessionId: `native-${claimed.id}` }
    const lane = await repository.coordination.ensureLane({ id: `lane-${randomUUID()}`,
      harness: session.harness, nativeSessionId: session.nativeSessionId,
      ownerAgentId: claimed.agentId, revision: 0, observedStatus: 'busy', connectionGeneration: 1,
      observedAt: new Date().toISOString() })
    await repository.coordination.bindWorkflowSession(claimed.id, session)
    await repository.coordination.finalizeWorkflowSession(entry.execution.id)
    const running = HarnessExecutionSchema.parse({ ...claimed, nativeSessionId: session.nativeSessionId, state: 'running' })
    await store.updateExecution(running)
    await budgets.ensure(running.id, f.run.id, 600_000)
    const turnId = `turn-${randomUUID()}`, connectionId = `connection-${randomUUID()}`
    const token = `writer-${randomUUID()}`
    await repository.coordination.claimLane(lane.id, lane.revision, 'ordering-fixture-writer', token,
      new Date(Date.now() + 120_000).toISOString(), `execution:${running.id}`)
    const lease = { id: lane.id, token, providerId: turnId, live: true }
    const at = new Date().toISOString()
    const start: HarnessNativeEvent = { executionId: running.id, connectionId, sequence: 0,
      type: 'turn.started', occurredAt: at, payload: { threadId: session.nativeSessionId, turnId, turn: { id: turnId, status: 'inProgress' } } }
    await appendWorkflowNativeGraphEvent(owner, start, lease)
    const pending = DurableInteractionSchema.parse({ ...deliveryFixture().interaction,
      id: `interaction-${randomUUID()}`, workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
      runId: f.run.id, executionId: running.id, requestingAgentId: running.agentId, ...session,
      graphThreadId: f.run.id, approval: { handler: 'user' }, nativeRequestId: `request-${randomUUID()}`,
      request: { threadId: session.nativeSessionId, turnId, itemId: 'item-pwd', command: 'pwd', cwd: db.directory },
      revision: 0, status: 'pending', deliveryState: 'not_started', selectedOptionId: undefined,
      selectedSemantic: undefined, nativeResponse: undefined, decidedAt: undefined, createdAt: at, updatedAt: at })
    await repository.create(pending)
    const approvalEvent: HarnessNativeEvent = { ...start, sequence: 1, type: 'interaction.pending',
      payload: { threadId: session.nativeSessionId, turnId, itemId: 'item-pwd', command: 'pwd',
        nativeRequestId: pending.nativeRequestId, nativeRequestType: pending.nativeRequestType } }
    await appendWorkflowNativeGraphEvent(owner, approvalEvent, lease, { interaction: pending, nativeTurnId: turnId })

    // Create an actual interrupted task in the installed production saver. The
    // receipt consumer must change this task-local __resume__ write, not a fake
    // table or a detached MemorySaver.
    const state = Annotation.Root({ runId: Annotation<string>() })
    const graph = new StateGraph(state).addNode('approval', () => {
      interrupt({ interactionId: pending.id, interactionIds: [pending.id] })
      return {}
    }).addEdge(START, 'approval').addEdge('approval', END).compile({ checkpointer: checkpoints.saver })
    const config = { configurable: { thread_id: f.run.id } }
    await graph.invoke({ runId: f.run.id }, config)
    const interrupted = await graph.getState(config)
    const interruptId = interrupted.tasks.flatMap((task) => task.interrupts ?? [])[0]?.id
    if (!interruptId) throw new Error('The real saver did not persist its exact interrupt')
    const bound = await repository.bindGraphInterrupt(pending.id, interruptId)
    const waiting = HarnessExecutionSchema.parse({ ...running, state: 'waiting' })
    await store.updateExecution(waiting)
    await store.updateRun({ executionState: 'waiting', outcome: 'pending' })
    await budgets.beginWait(waiting.id)
    const access = new PostgresAccessService(db.pool)
    const user = await access.issue({ name: 'Ordering fixture responder', audience: 'user', expiresAt: new Date(Date.now() + 120_000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: {
        workspaceIds: [f.run.workspaceId], workflowIds: [f.run.workflowId], runIds: [f.run.id],
      } }] })
    const semantic = optionId === 'reject' ? 'reject' as const : 'approve_once' as const
    await repository.decide({ id: bound.id, optionId, expectedRevision: bound.revision,
      principal: user.principal, nativeResponse: { optionId, semantic } })
    const delivery = await repository.delivery.claim(bound.id, `delivery-${randomUUID()}`)
    expect(delivery?.mode).toBe('submit')
    const entered = deferred(), reply = deferred<NativeDeliveryOutcome>()
    let responseCalls = 0
    const finishing = repository.delivery.finish(delivery!, async () => {
      responseCalls += 1; entered.resolve()
      return reply.promise
    })
    // Attach a rejection handler immediately so fixture/preflight failure cannot
    // leave a hanging wait or an unhandled promise during assertion cleanup.
    void finishing.catch((error: unknown) => entered.reject(error))
    await entered.promise
    const proof = { ...deliveryFixture().proof, ...session, nativeRequestId: pending.nativeRequestId,
      nativeRequestType: pending.nativeRequestType, optionId, semantic }
    const result: ExecutionResult = optionId === 'reject'
      ? { outcome: 'failed', error: { code: 'NATIVE_APPROVAL_DENIED', message: 'Provider-shaped denied turn.', retryable: false } }
      : { outcome: 'succeeded', output: { command: 'pwd', exitCode: 0 } }
    const completed = HarnessExecutionSchema.parse({ ...waiting, state: 'completed', result, finishedAt: new Date().toISOString() })
    const codexHistory: HarnessNativeEvent[] = optionId === 'approve-once' ? [
      { ...start, sequence: 2, type: 'interaction.submitted', payload: {
        nativeRequestId: pending.nativeRequestId, optionId, semantic } },
      { ...start, sequence: 3, type: 'interaction.resolved', payload: {
        nativeRequestId: pending.nativeRequestId, submittedOptionId: optionId, evidence: 'serverRequest/resolved' } },
      { ...start, sequence: 4, type: 'item.completed', payload: { threadId: session.nativeSessionId, turnId,
        item: { id: 'item-pwd', type: 'commandExecution', status: 'completed', command: 'pwd', cwd: db.directory, exitCode: 0 } } },
    ] : []
    for (const event of codexHistory) await appendWorkflowNativeGraphEvent(owner, event, lease)
    const terminal: HarnessNativeEvent = { ...start, sequence: 2 + codexHistory.length, type: 'turn.completed', payload: {
      threadId: session.nativeSessionId, turnId, turn: { id: turnId, status: optionId === 'reject' ? 'failed' : 'completed' },
    } }
    const continuation = { session, providerId: turnId, correlationId: `execution:${running.id}`,
      responseDeliveries: optionId === 'approve-once' ? [] : [proof],
      historyEvents: optionId === 'approve-once' ? [start, approvalEvent, ...codexHistory, terminal] : [] }
    const observeTerminal = () => appendWorkflowNativeGraphEvent(owner, terminal, { ...lease, live: false }, undefined, continuation)
    const storedExecution = async () => HarnessExecutionSchema.parse((await db.pool.query<{ record: unknown }>(
      'select record from harness_executions where id=$1', [running.id])).rows[0]!.record)
    const outbox = async () => (await db.pool.query<{ state: string; attempt: number; approval_native_ack_id: string | null }>(
      'select state,attempt,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [bound.id])).rows[0]
    const effectCount = async (kind: string) => (await db.pool.query<{ count: number }>(
      'select count(*)::int as count from run_graph_effects where run_id=$1 and effect_kind=$2', [f.run.id, kind])).rows[0]!.count
    try {
      await observeTerminal()
      // CC-pending cut: the native turn is finished, but the actual delivery
      // transaction is still outstanding. It must not close the requester.
      const before = await graphHead(db.pool, f.run.id)
      await expect(store.updateExecution(completed)).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
      expect(await graphHead(db.pool, f.run.id)).toBe(before)
      expect((await storedExecution()).state).toBe('waiting')
      expect(await effectCount('graph.resume')).toBe(0)
    } finally {
      // Lost reply after a possible native response is uncertain, not a license
      // to send the same approval twice. Reconciliation below supplies history.
      reply.resolve({ state: 'uncertain' })
      await finishing
    }
    await expect(store.updateExecution(completed)).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    const reconciliation = await repository.delivery.claim(bound.id, `reconcile-${randomUUID()}`, true)
    expect(reconciliation).toMatchObject({ mode: 'reconcile', attempt: delivery!.attempt, correlationId: delivery!.correlationId })
    const delivered = await repository.delivery.finish(reconciliation!, { state: 'delivered', evidence: proof })
    expect(delivered.status).toBe('delivered')
    expect(await outbox()).toMatchObject({ state: 'pending', attempt: 0, approval_native_ack_id: null })
    await observeTerminal() // exact duplicate raw source, now with delivery durable
    // CO-cleanup cut: a delivery receipt exists, but its checkpoint has not been
    // consumed. Neither completion nor normal cleanup may cancel the obligation.
    await expect(store.updateExecution(completed)).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    await expect(repository.cancelPendingForRun(f.run.id)).rejects.toMatchObject({ code: 'EXECUTION_NOT_STOPPED' })
    expect((await repository.get(bound.id))?.status).toBe('delivered')
    expect(await effectCount('graph.resume')).toBe(0)

    expect(await consumeDeliveredApprovals(owner, checkpoints.saver, repository, [delivered])).toBe(true)
    expect(await effectCount('graph.resume')).toBe(1)
    expect(await outbox()).toMatchObject({ state: 'resumed', approval_native_ack_id: null })
    await expect(store.updateExecution(completed)).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    const checkpointWrites = async () => (await db.pool.query(
      `select checkpoint_id,task_id,idx,channel,type,encode(blob,'hex') as blob
       from ${db.schema}_ordering_checkpoints.checkpoint_writes where thread_id=$1
       order by checkpoint_id,task_id,idx`, [f.run.id])).rows
    const consumedWrites = await checkpointWrites()
    expect(consumedWrites.some((row) => row.channel === '__resume__')).toBe(true)
    await owner.release(); owners.pop()
    // Database owner/coordinator re-entry, not a new native process or connection.
    const recovered = await ownedAgent3(db.pool, f)
    owner = recovered.owner; store = recovered.store; owners.push(owner)
    const reentered = new Wave25InteractionRepository(db.pool)
    expect(await consumeDeliveredApprovals(owner, checkpoints.saver, reentered, [(await reentered.get(bound.id))!])).toBe(true)
    expect(await checkpointWrites()).toEqual(consumedWrites)
    expect(await repository.delivery.claim(bound.id, `no-resend-${randomUUID()}`)).toBeUndefined()
    // Missing or foreign proof must not acquire an acknowledgement.
    await appendWorkflowNativeGraphEvent(owner, terminal, { ...lease, live: false }, undefined,
      { ...continuation, responseDeliveries: [{ ...proof, nativeRequestId: 'foreign-request' }], historyEvents: [] })
    expect((await outbox())?.approval_native_ack_id).toBeNull()
    await observeTerminal()
    const acknowledged = await outbox()
    expect(acknowledged?.approval_native_ack_id).toEqual(expect.any(String))
    await observeTerminal()
    expect(await outbox()).toEqual(acknowledged)
    await store.updateExecution(completed)
    await store.acceptTerminal(completed.id)
    if (optionId === 'reject') await store.settleRun(false)
    else await store.completeRun()
    await repository.cancelPendingForRun(f.run.id)
    expect((await repository.get(bound.id))?.status).toBe('delivered')
    expect((await outbox())?.state).toBe('resumed')
    expect(responseCalls).toBe(1)
    expect(await effectCount('approval.deliver')).toBe(1)
    expect(await effectCount('graph.resume')).toBe(1)
    await expect(store.updateExecution({ ...completed, result: { outcome: 'canceled' } }))
      .rejects.toMatchObject({ code: 'GRAPH_TERMINAL_CONFLICT' })
  }, 60_000)
})
