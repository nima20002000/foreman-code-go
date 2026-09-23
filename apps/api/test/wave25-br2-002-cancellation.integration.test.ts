import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { DurableInteractionSchema, HarnessExecutionSchema } from '@graphql/contracts'
import { RunGraphBatchSchema, type RunGraphSnapshot } from '@graphql/contracts/wave25'
import { agent3Database, candidateFor, deferred, ownedAgent3, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import type { NativeDeliveryOutcome } from '../src/modules/interactions/delivery.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { canceledRetirementSourceId } from '../src/modules/interactions/wave25/publication.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

/** Real SQL/publication/authority/coordinator/reference-reducer tests. The fixture
 * supplies native session identities and substitutes ONLY external native closure
 * and delivery callbacks. No native evidence, Worker ack or retirement is seeded.
 * These tests must run in the terminal environment; the Web lane did not run them. */
const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

async function userFixture(id: string = randomUUID()) {
  const db = await agent3Database(); closes.push(db.close)
  const f = await seedAgent3(db.pool, db.directory)
  const { owner, store } = await ownedAgent3(db.pool, f); closes.push(() => owner.release())
  const { compare } = await graphParity(db.pool, f.scope, f.snapshot)
  await compare()
  await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
  const admitted = await store.admit(f.version.entryNodeId, () => candidateFor(f))
  if (admitted.kind !== 'admitted') throw new Error('Expected real one-shot admission')
  const claimed = await store.claimLaunch(admitted.execution.id,
    { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/br2002-native` })
  if (!claimed) throw new Error('Expected real first launch claim')
  const session = { harness: 'codex' as const, providerVersion: 'synthetic-test', nativeSessionId: `native-${claimed.id}` }
  await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(claimed.id, session)
  const execution = HarnessExecutionSchema.parse({ ...await store.recoverSession(claimed.id), state: 'waiting' })
  await store.updateExecution(execution)
  await db.pool.query(`insert into approval_execution_state(execution_id,graph_thread_id,active_timeout_ms,active_elapsed_ms)
    values($1,$2,600000,0) on conflict(execution_id) do nothing`, [execution.id, f.run.id])
  const repository = new Wave25InteractionRepository(db.pool)
  await repository.coordination.ensureLane({ id: `lane-${execution.id}`, harness: session.harness, nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId,
    revision: 0, observedStatus: 'idle', connectionGeneration: 0, observedAt: f.createdAt })
  const raw = deliveryFixture().interaction
  const input = DurableInteractionSchema.parse({ ...raw, id, revision: 0, runId: f.run.id,
    workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, executionId: execution.id, requestingAgentId: execution.agentId,
    ...session, nativeRequestId: `request-${randomUUID()}`, graphThreadId: f.run.id, approval: f.run.approval,
    status: 'pending', deliveryState: 'not_started', selectedOptionId: undefined, selectedSemantic: undefined,
    nativeResponse: undefined, decidedAt: undefined })
  // The supplied PostgreSQL failure was here, before any cancellation call:
  // request creation must join the same projection used by subsequent writes.
  const beforeCreate = await compare()
  expect((await db.pool.query('select 1 from run_native_activity where run_id=$1', [f.run.id])).rowCount).toBe(0)
  const interaction = (await repository.create(input)).interaction
  const pending = await compare()
  expect(pending.state.interactions.find((i) => i.interactionId === id)?.handler).toBe('user')
  expect(pending.state.nodes.find((node) => node.state.workflowNodeId === execution.workflowNodeId)?.activity)
    .toEqual({ workflowNodeId: execution.workflowNodeId, status: 'unknown' })
  return { ...f, ...db, repository, store, execution, input, interaction, beforeCreate, compare }
}

type CleanupCredentials = NonNullable<ConstructorParameters<typeof ApprovalExecutionCoordinator>[5]>
function cleanupCoordinator(pool: pg.Pool, repository: Wave25InteractionRepository, confirmed: boolean,
  credentials?: CleanupCredentials) {
  const workflows = new PostgresWorkflowRepository(pool)
  const runs = new PostgresRunRepository(pool, workflows,
    new WorkspaceLocationService(pool, new PostgresCommandCoordinator(pool), '/synthetic/br2002'))
  const resolve = vi.fn((): never => { throw new Error('Cleanup must not allocate a replacement native provider') })
  const closeNative = vi.fn(async () => confirmed)
  return { native: new ApprovalExecutionCoordinator(runs, repository, new PostgresApprovalBudgetRepository(pool),
    { resolve }, 600000, credentials, undefined, closeNative), resolve, closeNative }
}

async function assertFinalPublication(pool: pg.Pool, runId: string, interactionId: string, after: string) {
  const rows = await pool.query<{ payload: string }>('select payload from run_graph_batches where run_id=$1 and sequence>$2::bigint order by sequence', [runId, after])
  const batches = rows.rows.map((r) => RunGraphBatchSchema.parse(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload))
  const containing = batches.filter((b) => b.events.some((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeKind === 'interaction' && e.fact.exchangeId === interactionId))
  expect(containing).toHaveLength(1)
  const batch = containing[0]!
  const index = batch.events.findIndex((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeKind === 'interaction' && e.fact.exchangeId === interactionId)
  const retired = batch.events[index]!, final = batch.events[index - 1]!
  if (retired.fact.type !== 'exchange.retired' || final.fact.type !== 'interaction.state') throw new Error('Missing adjacent final interaction state')
  expect(final.fact.interaction.status).toBe('canceled')
  expect(final.fact.interaction.revision).toBe(retired.fact.finalRevision)
  expect(final.evidence).toEqual(retired.evidence)
  expect(final.fact.interaction.resumeAcknowledgementId).toBeUndefined()
  return batch
}

async function unchangedRevision(pool: pg.Pool, id: string) {
  return (await pool.query('select record,revision,delivery_fence from durable_interactions where id=$1', [id])).rows[0]
}

describe.skipIf(!postgresEnabled)('BR2-002: actual user cancellation and complete PostgreSQL snapshot/replay parity', () => {
  it('publishes creation from the preceding head, not an unconditional wait, and preserves duplicate/interrupt/cancel parity', async () => {
    const f = await userFixture(), pending = await f.compare()
    const created = await f.pool.query<{ payload: string }>(
      'select payload from run_graph_batches where run_id=$1 and sequence>$2::bigint order by sequence', [f.run.id, f.beforeCreate.asOfSequence])
    expect(created.rows).toHaveLength(1)
    const payload = created.rows[0]!.payload
    const batch = RunGraphBatchSchema.parse(typeof payload === 'string' ? JSON.parse(payload) : payload)
    expect(batch.events.some((e) => e.fact.type === 'interaction.state' && e.fact.interaction.interactionId === f.interaction.id)).toBe(true)
    // Both before/after projections are unknown with no native activity row.
    // Do not manufacture a wait that a delta-only projection cannot undo.
    expect(batch.events.some((e) => e.fact.type === 'node.activity')).toBe(false)
    expect(pending.state.run.pendingInteractionCount).toBe(1)
    expect((await f.repository.create(f.input)).created).toBe(false)
    expect((await f.compare()).asOfSequence).toBe(pending.asOfSequence)
    const bound = await f.repository.bindGraphInterrupt(f.interaction.id, 'br2002-interrupt')
    const interrupted = await f.compare()
    expect(interrupted.state.interactions[0]?.revision).toBe(String(bound.revision))
    await f.repository.bindGraphInterrupt(f.interaction.id, 'br2002-interrupt')
    expect((await f.compare()).asOfSequence).toBe(interrupted.asOfSequence)
    await f.repository.cancelPendingForExecution(f.execution.id, [f.interaction.nativeRequestId])
    expect((await f.compare()).state.interactions).toEqual([])
    await assertFinalPublication(f.pool, f.run.id, f.interaction.id, interrupted.asOfSequence)
  }, 60000)

  it('replays both real pending requests and retires only the addressed request at each head', async () => {
    const f = await userFixture('a-br2002-request')
    const second = DurableInteractionSchema.parse({ ...f.input, id: 'z-br2002-request', nativeRequestId: `request-${randomUUID()}` })
    await f.repository.create(second)
    let current = await f.compare()
    expect(current.state.interactions.map((i) => i.interactionId)).toEqual([f.interaction.id, second.id])
    expect(current.state.run.pendingInteractionCount).toBe(2)
    await f.repository.cancelPendingForExecution(f.execution.id, [f.interaction.nativeRequestId])
    current = await f.compare()
    expect(current.state.interactions.map((i) => i.interactionId)).toEqual([second.id])
    expect(current.state.run.pendingInteractionCount).toBe(1)
    const partial = current.asOfSequence
    await f.repository.cancelPendingForExecution(f.execution.id, [f.interaction.nativeRequestId])
    expect((await f.compare()).asOfSequence).toBe(partial)
    await f.repository.cancelPendingForExecution(f.execution.id, [second.nativeRequestId])
    current = await f.compare()
    expect(current.state.interactions).toEqual([])
    expect(current.state.run.pendingInteractionCount).toBe(0)
    await assertFinalPublication(f.pool, f.run.id, f.interaction.id, f.beforeCreate.asOfSequence)
    await assertFinalPublication(f.pool, f.run.id, second.id, partial)
  }, 60000)

  it.each([undefined, 'x'.repeat(200)])('retires direct authoritative native cancellation, including bounded maximum IDs (%s)', async (id) => {
    const f = await userFixture(id), initial = await f.compare()
    await f.repository.cancelPendingForExecution(f.execution.id, ['unrelated-native-request'])
    expect((await f.compare()).asOfSequence).toBe(initial.asOfSequence)
    await f.repository.cancelPendingForExecution(f.execution.id, [f.interaction.nativeRequestId])
    const final = await f.compare()
    expect(final.state.interactions).toEqual([])
    expect(final.state.run.pendingInteractionCount).toBe(0)
    await assertFinalPublication(f.pool, f.run.id, f.interaction.id, initial.asOfSequence)
    const beforeRepeat = await unchangedRevision(f.pool, f.interaction.id)
    await f.repository.cancelPendingForExecution(f.execution.id, [f.interaction.nativeRequestId])
    expect((await f.compare()).asOfSequence).toBe(final.asOfSequence)
    expect(await unchangedRevision(f.pool, f.interaction.id)).toEqual(beforeRepeat)
    const sqlId = (await f.pool.query<{ id: string }>("select 'canceled-interaction-' || encode(sha256(convert_to($1::text,'UTF8')),'hex') as id", [f.interaction.id])).rows[0]!.id
    expect(sqlId).toBe(canceledRetirementSourceId(f.interaction.id))
  }, 60000)

  it('keeps terminal-evidence and negative-authority requirements on real repository calls', async () => {
    const f = await userFixture(), initial = await f.compare()
    await expect(f.repository.cancelPendingForExecution(f.execution.id)).rejects.toMatchObject({ code: 'APPROVAL_TERMINAL_EVIDENCE_REQUIRED' })
    await expect(f.repository.cancelPendingForRun(f.run.id)).rejects.toMatchObject({ code: 'EXECUTION_NOT_STOPPED' })
    expect((await f.compare()).asOfSequence).toBe(initial.asOfSequence)
    await f.store.updateExecution(HarnessExecutionSchema.parse({ ...f.execution, state: 'completed', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString() }))
    await f.compare()
    await f.repository.cancelPendingForExecution(f.execution.id)
    expect((await f.compare()).state.interactions).toEqual([])
    await assertFinalPublication(f.pool, f.run.id, f.interaction.id, initial.asOfSequence)
  }, 60000)

  it.each(['stop', 'non-stop'] as const)('%s keeps canceled uncertainty through terminal state until actual coordinator cleanup', async (kind) => {
    const f = await userFixture(), initial = await f.compare()
    await changeOneShotLifecycle(f.pool, f.run.id, kind === 'stop' ? { kind: 'stop' } : { kind: 'cleanup', pending: true })
    await f.compare()
    expect(await f.repository.cancelPendingForRun(f.run.id)).toBe(1)
    let current = await f.compare()
    expect(current.state.interactions).toEqual([expect.objectContaining({ interactionId: f.interaction.id, status: 'canceled', resumeState: 'unknown' })])
    const canceled = await unchangedRevision(f.pool, f.interaction.id)
    expect(await f.repository.cancelPendingForRun(f.run.id)).toBe(0)
    expect((await f.compare()).asOfSequence).toBe(current.asOfSequence)
    expect(await unchangedRevision(f.pool, f.interaction.id)).toEqual(canceled)
    await expect(cleanupCoordinator(f.pool, f.repository, false).native.cancelRun(f.run.id)).rejects.toBeDefined()
    current = await f.compare()
    expect(current.state.interactions).toHaveLength(1)
    // Once Stop is requested, a late native writer must not update this
    // execution. settleRun owns the negative terminal/interrupted transition.
    await f.store.settleRun(kind === 'stop', kind !== 'stop')
    current = await f.compare()
    expect(current.state.run.executionState).toBe(kind === 'stop' ? 'completed' : 'interrupted')
    expect(current.state.interactions[0]?.resumeState).toBe('unknown')
    const cleanup = cleanupCoordinator(f.pool, f.repository, true)
    await cleanup.native.cancelRun(f.run.id)
    expect(cleanup.resolve).not.toHaveBeenCalled()
    await f.compare()
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: false })
    const final = await f.compare()
    expect(final.state.interactions).toEqual([])
    expect(final.state.reviews).toEqual([])
    expect(final.state.run.cleanupPending).toBe(false)
    expect(final.state.run.pendingInteractionCount).toBe(0)
    expect(final.state.run.stopRequested).toBe(kind === 'stop')
    await assertFinalPublication(f.pool, f.run.id, f.interaction.id, initial.asOfSequence)
    expect(await unchangedRevision(f.pool, f.interaction.id)).toEqual(canceled)
  }, 60000)

  it('retains an actually claimed delivery attempt and late provider result through Stop without fabricating acknowledgement', async () => {
    const f = await userFixture()
    const access = new PostgresAccessService(f.pool)
    const user = await access.issue({ name: 'BR2-002 human responder', audience: 'user', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['interactions:respond'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id] } }] })
    await f.repository.decide({ id: f.interaction.id, optionId: 'approve-once', expectedRevision: f.interaction.revision,
      principal: user.principal, nativeResponse: { optionId: 'approve-once', semantic: 'approve_once' } })
    await f.compare()
    const claim = await f.repository.delivery.claim(f.interaction.id, 'br2002-delivery-owner')
    if (!claim) throw new Error('Expected an actual delivery claim')
    await f.compare()
    const entered = deferred(), release = deferred<NativeDeliveryOutcome>()
    const submit = vi.fn(async () => { entered.resolve(); return release.promise })
    const pending = f.repository.delivery.finish(claim, submit)
    const observed = pending.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await Promise.race([entered.promise, observed.then((result) => {
        throw 'error' in result ? result.error : new Error('Delivery finished without entering the provider port')
      })])
      await f.compare()
      await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'stop' })
      await f.repository.cancelPendingForRun(f.run.id)
      const canceled = await f.compare()
      expect(canceled.state.interactions[0]).toMatchObject({ status: 'canceled', resumeState: 'unknown' })
      const attempt = (await f.pool.query('select * from interaction_delivery_attempts where interaction_id=$1', [f.interaction.id])).rows
      expect(attempt).toHaveLength(1)
      expect(attempt[0].state).toBe('uncertain')
      expect(attempt[0].approval_write_started_at).not.toBeNull()
      await f.repository.cancelPendingForRun(f.run.id)
      expect((await f.compare()).asOfSequence).toBe(canceled.asOfSequence)
      release.resolve({ state: 'delivered', evidence: { source: 'provider_acknowledgement', harness: f.interaction.harness,
        providerVersion: f.interaction.providerVersion, nativeSessionId: f.interaction.nativeSessionId, nativeRequestId: f.interaction.nativeRequestId,
        nativeRequestType: f.interaction.nativeRequestType, optionId: 'approve-once', semantic: 'approve_once' } })
      await observed
      expect(submit).toHaveBeenCalledTimes(1)
      expect((await f.compare()).state.interactions[0]?.resumeState).toBe('unknown')
      expect((await f.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='graph.resume'", [f.run.id])).rowCount).toBe(0)
      await cleanupCoordinator(f.pool, f.repository, true).native.cancelRun(f.run.id)
      expect((await f.compare()).state.interactions).toEqual([])
      expect((await f.pool.query('select * from interaction_delivery_attempts where interaction_id=$1', [f.interaction.id])).rows).toEqual(attempt)
      await assertFinalPublication(f.pool, f.run.id, f.interaction.id, canceled.asOfSequence)
    } finally { release.resolve({ state: 'uncertain' }); await observed }
  }, 60000)

  it('a Run cleanup flag alone never replaces the retirement publication', async () => {
    const f = await userFixture()
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: true })
    await f.repository.cancelPendingForRun(f.run.id)
    const canceled = await f.compare()
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: false })
    const changed = await f.compare()
    expect(changed.state.interactions).toEqual(canceled.state.interactions)
    // This is a deliberate lifecycle-producer cut, NOT proof of native closure.
    expect((await f.pool.query('select 1 from run_graph_sources where run_id=$1 and source_id=$2',
      [f.run.id, canceledRetirementSourceId(f.interaction.id)])).rowCount).toBe(0)
  }, 60000)
})

describe.skipIf(!process.env.TEST_DATABASE_URL)('BR2-002: real submitted-review cleanup and full exchange parity', () => {
  it.each(['stop', 'non-stop'] as const)('%s retains direct-canceled review/native/credential obligations, then retires both exchanges together', async (kind) => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? '')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) throw new Error('Use a loopback database explicitly named for tests')
    const f = await approvalDatabase(); closes.push(f.close)
    const { compare } = await graphParity(f.pool, f.scope)
    const initial = await compare()
    await f.repository.cancelPendingForExecution(f.requester.id, [f.interaction.nativeRequestId])
    let current: RunGraphSnapshot = await compare()
    expect(current.state.interactions[0]).toMatchObject({ status: 'canceled', resumeState: 'unknown' })
    expect(current.state.reviews).toHaveLength(1)
    await f.repository.cancelPendingForExecution(f.requester.id, [f.interaction.nativeRequestId])
    expect((await compare()).asOfSequence).toBe(current.asOfSequence)
    await changeOneShotLifecycle(f.pool, f.run.id, kind === 'stop' ? { kind: 'stop' } : { kind: 'cleanup', pending: true })
    await compare()
    const credentials = { revokeForExecution: (id: string) => f.credentials.revokeForExecution(id) } as unknown as CleanupCredentials
    await expect(cleanupCoordinator(f.pool, f.repository, false, credentials).native.cancelRun(f.run.id)).rejects.toBeDefined()
    current = await compare()
    expect(current.state.interactions).toHaveLength(1)
    expect(current.state.reviews).toHaveLength(1)
    await cleanupCoordinator(f.pool, f.repository, true, credentials).native.cancelRun(f.run.id)
    current = await compare()
    expect(current.state.interactions).toEqual([])
    expect(current.state.reviews).toEqual([])
    expect(current.state.run.unsettledReviewCount).toBe(0)
    const batch = await assertFinalPublication(f.pool, f.run.id, f.interaction.id, initial.asOfSequence)
    expect(batch.events.some((e) => e.fact.type === 'exchange.retired' && e.fact.exchangeKind === 'review' && e.fact.exchangeId === f.job.id)).toBe(true)
    const repeated = current.asOfSequence
    await cleanupCoordinator(f.pool, f.repository, true, credentials).native.cancelRun(f.run.id)
    expect((await compare()).asOfSequence).toBe(repeated)
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: false })
    expect((await compare()).state.run.stopRequested).toBe(kind === 'stop')
  }, 60000)
})
