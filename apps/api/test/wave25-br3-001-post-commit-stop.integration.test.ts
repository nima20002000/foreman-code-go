import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableInteractionSchema, type DurableInteraction } from '@graphql/contracts'
import { RunGraphBatchSchema, type RunGraphSnapshot } from '@graphql/contracts/wave25'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { canceledRetirementSourceId } from '../src/modules/interactions/wave25/publication.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { readCurrentActivityContext, selectCurrentNodeActivity } from '../src/modules/run-graph/currentActivity.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { ownedAgent3, postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

/** BR3-001: actual migrated PostgreSQL, independent Run owners, production
 * service/coordinator/engine/registration and ApprovalPostgresSaver. Only the
 * external provider/process-closure ports and filesystem qualification are
 * synthetic (as in the existing BR1-003 and BR2-002 fixtures). No resumed row,
 * checkpoint write, acknowledgement or retirement is seeded. No native binary,
 * execution credential lifecycle, authenticated HTTP/MCP or browser is qualified.
 * This source must be executed in the terminal's opt-in PostgreSQL environment. */
type Fixture = Awaited<ReturnType<typeof checkpointRuntimeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => {
  try { while (fixtures.length) await fixtures.pop()!.close() } finally { vi.restoreAllMocks() }
})
async function fixture() {
  const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
  fixtures.push(f)
  const parity = await graphParity(f.db.pool, f.f.scope)
  await parity.compare() // Start BEFORE execution, request creation or delivery.
  return { f, compare: parity.compare }
}
function response(interaction: DurableInteraction) {
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  if (!option) throw new Error('Missing exact native approve-once option')
  return { interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision }
}
async function currentInteraction(f: Fixture, id: string) {
  const rows = await f.db.pool.query<{ record: unknown }>('select record from durable_interactions where id=$1', [id])
  if (rows.rowCount !== 1) throw new Error('Missing durable interaction')
  return DurableInteractionSchema.parse(rows.rows[0]!.record)
}
async function batches(f: Fixture, after = '0') {
  const rows = await f.db.pool.query<{ payload: unknown }>(
    "select payload from run_graph_batches where run_id=$1 and kind='events' and sequence>$2::bigint order by sequence",
    [f.f.run.id, after])
  return rows.rows.map(({ payload }) => RunGraphBatchSchema.parse(typeof payload === 'string' ? JSON.parse(payload) : payload))
}
async function nativeProjection(f: Fixture) {
  return (await f.db.pool.query(`select * from run_native_activity where run_id=$1
    order by execution_id,work_kind,work_id`, [f.f.run.id])).rows
}
async function assertCleanupProjection(f: Fixture, snapshot: RunGraphSnapshot, executionId: string) {
  const node = snapshot.state.nodes.find((item) => item.state.execution?.executionId === executionId)
  if (!node) throw new Error('Missing exact requester projection')
  expect(node.state.lifecycle).toBe('unknown')
  expect(node.activity).toEqual({ workflowNodeId: node.state.workflowNodeId, status: 'none' })
  // Exercise the other current-activity reader used by native clear/refresh,
  // not only the compact snapshot's shared projection.
  await withExclusiveGraphConnection(f.db.pool, (connection) => connection.transaction(async (sql) => {
    const context = await readCurrentActivityContext(sql, f.f.scope, node.state.workflowNodeId)
    expect(context.closed).toBe(true)
    expect(selectCurrentNodeActivity(node.state.workflowNodeId, [], context))
      .toEqual({ workflowNodeId: node.state.workflowNodeId, status: 'none' })
  }))
}
async function assertNoWorkerAcknowledgement(f: Fixture, id: string) {
  const row = (await f.db.pool.query('select approval_native_ack_id,approval_native_ack_source from interaction_graph_resumes where interaction_id=$1', [id])).rows[0]
  expect(row).toEqual({ approval_native_ack_id: null, approval_native_ack_source: null })
  expect((await batches(f)).flatMap((batch) => batch.events).filter(({ fact }) => fact.type === 'worker.resumed')).toEqual([])
}
async function polls(snapshot: RunGraphSnapshot): Promise<boolean> {
  // Exercise the unchanged production predicate without adding an API->web
  // production dependency or editing frontend files. The import is test-only.
  const url = new URL('../../web/src/features/run-graph/reducer.ts', import.meta.url)
  const reducer = await import(url.href) as { graphNeedsPolling(value: RunGraphSnapshot): boolean }
  return reducer.graphNeedsPolling(snapshot)
}
async function assertFinalPublication(f: Fixture, id: string, after: string, revision: number) {
  const containing = (await batches(f, after)).filter((batch) => batch.events.some(({ fact }) =>
    fact.type === 'exchange.retired' && fact.exchangeKind === 'interaction' && fact.exchangeId === id))
  expect(containing).toHaveLength(1)
  const batch = containing[0]!
  const index = batch.events.findIndex(({ fact }) => fact.type === 'exchange.retired'
    && fact.exchangeKind === 'interaction' && fact.exchangeId === id)
  const retired = batch.events[index]!, final = batch.events[index - 1]!
  if (retired.fact.type !== 'exchange.retired' || final.fact.type !== 'interaction.state') {
    throw new Error('Retirement must follow its final state in the same publication')
  }
  expect(final.fact.interaction).toMatchObject({ interactionId: id, revision: String(revision),
    status: 'canceled', deliveryState: 'delivered', resumeState: 'unknown' })
  expect(final.fact.interaction.resumeAcknowledgementId).toBeUndefined()
  expect(retired.fact.finalRevision).toBe(String(revision))
  expect(final.evidence).toEqual(retired.evidence)
  expect(final.evidence).toEqual({ sourceKind: 'cleanup', sourceId: canceledRetirementSourceId(id), sourceRevision: String(revision) })
  const sources = await f.db.pool.query<{ source_kind: string; source_digest: string; source_revision: string }>(
    `select source_kind,source_digest,source_revision::text from run_graph_sources where run_id=$1
      and ((source_kind='interaction' and source_id=$2) or (source_kind='cleanup' and source_id=$3))
      and source_revision=$4::bigint order by source_kind`, [f.f.run.id, id, canceledRetirementSourceId(id), revision])
  expect(sources.rows).toHaveLength(2)
  expect(sources.rows.map((row) => row.source_kind)).toEqual(['cleanup', 'interaction'])
  expect(sources.rows[0]!.source_digest).toBe(sources.rows[1]!.source_digest)
  expect(sources.rows.every((row) => row.source_revision === String(revision))).toBe(true)
}

/** Same crash seam as BR1-003: the read on an independent connection can see
 * graph.resume only AFTER COMMIT. The failure then prevents graph dispatch. */
async function commitBeforeAck(f: Fixture, compare: () => Promise<RunGraphSnapshot>) {
  await f.engine.start(f.f.run.id)
  await compare()
  const tuple = await f.saver.getTuple(f.config)
  if (!tuple) throw new Error('Expected an actual persisted interrupted checkpoint')
  const beforeWrites = tuple.pendingWrites
  const saver = new class extends ApprovalPostgresSaver {
    crashed = false
    override async getTuple(config: Parameters<ApprovalPostgresSaver['getTuple']>[0]) {
      if (!this.crashed && (await f.receipts()).length) {
        this.crashed = true
        throw new Error('BR3-001 crash-after-COMMIT-before-Worker-ack')
      }
      return super.getTuple(config)
    }
  }(f.db.pool, undefined, { schema: f.db.schema })
  const failed = f.compose(saver), pending = await f.pending()
  expect(pending).toHaveLength(1)
  const input = pending[0]!
  const result = await failed.service.respond({ kind: 'user', principal: f.principal }, response(input))
  expect(saver.crashed).toBe(true)
  expect(result.interaction.deliveryState).toBe('delivered')
  const interaction = await currentInteraction(f, input.id)
  expect(interaction.status).toBe('delivered')
  expect(interaction.deliveredAt).toBeTruthy()
  const readEvidence = async () => ({
    receipts: await f.receipts(),
    writes: (await f.saver.getTuple(tuple.config))?.pendingWrites,
    outbox: (await f.db.pool.query('select * from interaction_graph_resumes where interaction_id=$1', [input.id])).rows,
    attempts: (await f.db.pool.query('select * from interaction_delivery_attempts where interaction_id=$1 order by attempt', [input.id])).rows,
  })
  const evidence = await readEvidence()
  expect(evidence.receipts).toHaveLength(1)
  expect(evidence.writes).not.toEqual(beforeWrites)
  expect(evidence.writes?.filter((write) => write[1] === '__resume__')).toHaveLength(1)
  expect(evidence.outbox).toEqual([expect.objectContaining({ state: 'resumed', approval_native_ack_id: null })])
  expect(evidence.attempts).toEqual([expect.objectContaining({ state: 'delivered' })])
  expect(evidence.attempts[0]!.evidence).toBeTruthy()
  expect(f.provider.counts.responses).toBe(1)
  await assertNoWorkerAcknowledgement(f, input.id)
  const snapshot = await compare()
  expect(snapshot.state.interactions).toEqual([expect.objectContaining({ interactionId: input.id,
    status: 'delivered', deliveryState: 'delivered', resumeState: 'pending' })])
  expect(snapshot.state.run.pendingInteractionCount).toBe(1)
  expect(await polls(snapshot)).toBe(true)
  return { interaction, snapshot, evidence, readEvidence, staleDelivered: result.interaction }
}

/** Actual cleanup coordinator; only the external process-closure attestation
 * is injected. An unconfirmed attestation may NOT resolve/start a new provider.
 * This fixture has no execution credentials, so no revocation is bypassed. */
function cleanupCoordinator(f: Fixture) {
  let confirmed = false
  const resolve = vi.fn((): never => { throw new Error('No resident native process; closure unconfirmed') })
  const closeNative = vi.fn(async () => confirmed)
  const native = new ApprovalExecutionCoordinator(f.runs, f.repository, new PostgresApprovalBudgetRepository(f.db.pool),
    { resolve }, 600000, undefined, undefined, closeNative)
  return { native, resolve, closeNative, confirm: () => { confirmed = true } }
}

// These are not guarded by DATABASE_URL and retain the existing loopback/test
// database restriction from agent3Database. A skipped test is NOT a passing test.
describe.skipIf(!postgresEnabled)('BR3-001: Stop/cleanup after actual checkpoint COMMIT, before native acknowledgement', () => {
  it.each(['stop', 'non-stop'] as const)('%s retains uncertainty until closure, then retires once without undoing COMMIT', async (kind) => {
    const { f, compare } = await fixture()
    const cut = await commitBeforeAck(f, compare)
    const id = cut.interaction.id, cleanup = cleanupCoordinator(f)
    const native = await nativeProjection(f)
    const underlying = native.find((row) => row.execution_id === cut.interaction.executionId && row.work_kind === 'workflow')
    // Reproduce the terminal failure with a real prior native start projection,
    // not a no-native fixture that cannot expose the invalid active-work fact.
    expect(underlying?.activity).toMatchObject({ status: 'active', action: 'working',
      acknowledgementId: expect.any(String), correlationId: expect.any(String) })
    // The saver transaction has returned. requestStop/changeOneShotLifecycle
    // use another pool connection, never an injected flag inside that transaction.
    if (kind === 'stop') await f.runs.requestStop(f.f.run.id)
    else await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: true })
    const boundary = await compare()
    expect(boundary.asOfSequence).toBe(String(BigInt(cut.snapshot.asOfSequence) + 1n))
    expect(boundary.state.run.cleanupPending).toBe(true)
    expect(boundary.state.run.stopRequested).toBe(kind === 'stop')
    expect(boundary.state.run.executionState).toBe(cut.snapshot.state.run.executionState)
    expect(boundary.state.run.outcome).toBe(cut.snapshot.state.run.outcome)
    await assertCleanupProjection(f, boundary, cut.interaction.executionId)
    expect(await nativeProjection(f)).toEqual(native) // Projection suppression is not a native write/closure.
    const boundaryBatches = await batches(f, cut.snapshot.asOfSequence)
    expect(boundaryBatches).toHaveLength(1)
    const boundaryActivity = boundaryBatches[0]!.events.filter(({ fact }) => fact.type === 'node.activity')
    expect(boundaryActivity).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({
      sourceKind: kind === 'stop' ? 'run' : 'cleanup',
    }), fact: { type: 'node.activity', activity: { workflowNodeId: underlying!.workflow_node_id, status: 'none' } } }))
    expect(boundaryBatches[0]!.events.some(({ fact }) => fact.type === 'worker.resumed' || fact.type === 'exchange.retired')).toBe(false)
    // Repeated cleanup intent is a no-op, not another projection revision.
    if (kind === 'non-stop') {
      await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: true })
      expect((await compare()).asOfSequence).toBe(boundary.asOfSequence)
    }
    if (kind === 'stop') {
      const successor = f.compose(), observe = vi.spyOn(successor.native, 'ensureObserve')
      // Before business settlement, a historical receipt cannot authorize native
      // re-entry. This is the existing BR1-003 production recovery fence.
      await expect(successor.engine.resumeInteraction(cut.staleDelivered)).rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
      expect(observe).not.toHaveBeenCalled()
      expect(await cut.readEvidence()).toEqual(cut.evidence)
    }
    // Baseline d9f7fea returns zero here solely because g.state is 'resumed'.
    expect(await f.repository.cancelPendingForRun(f.f.run.id)).toBe(1)
    const canceled = await currentInteraction(f, id)
    expect(canceled).toEqual({ ...cut.interaction, status: 'canceled', revision: cut.interaction.revision + 1,
      updatedAt: canceled.updatedAt })
    let snapshot = await compare()
    await assertCleanupProjection(f, snapshot, cut.interaction.executionId)
    expect(await nativeProjection(f)).toEqual(native)
    const cancellationBatches = await batches(f, boundary.asOfSequence)
    expect(cancellationBatches).toHaveLength(1)
    expect(cancellationBatches[0]!.events.some(({ fact }) => fact.type === 'node.activity'
      && fact.activity.status === 'active' && fact.activity.action !== 'waiting_approval')).toBe(false)
    expect(cancellationBatches[0]!.events.some(({ fact }) => fact.type === 'node.state' && fact.state.lifecycle === 'running')).toBe(false)
    expect(snapshot.state.interactions).toEqual([expect.objectContaining({ interactionId: id, status: 'canceled',
      deliveryState: 'delivered', resumeState: 'unknown' })])
    // Established counts exclude canceled requests, not retained cleanup
    // obligations. The unknown exchange must independently keep polling alive.
    expect(snapshot.state.run.pendingInteractionCount).toBe(0)
    expect(snapshot.state.run.stopRequested).toBe(kind === 'stop')
    expect(await polls(snapshot)).toBe(true)
    expect(await cut.readEvidence()).toEqual(cut.evidence)

    for (let n = 0; n < 2; n++) {
      expect(await f.repository.cancelPendingForRun(f.f.run.id)).toBe(0)
      await expect(cleanup.native.cancelRun(f.f.run.id)).rejects.toBeDefined()
      expect((await compare()).asOfSequence).toBe(snapshot.asOfSequence)
      expect(await currentInteraction(f, id)).toEqual(canceled)
      expect(await cut.readEvidence()).toEqual(cut.evidence)
    }
    expect((await f.db.pool.query('select 1 from run_graph_sources where run_id=$1 and source_id=$2',
      [f.f.run.id, canceledRetirementSourceId(id)])).rowCount).toBe(0)
    // A fresh owner settles the negative business result, not native evidence.
    const { owner, store } = await ownedAgent3(f.db.pool, f.f)
    try { await store.settleRun(kind === 'stop', kind !== 'stop') } finally { await owner.release() }
    snapshot = await compare()
    expect(snapshot.state.run.executionState).toBe(kind === 'stop' ? 'completed' : 'interrupted')
    expect(snapshot.state.run.pendingInteractionCount).toBe(0)
    expect(snapshot.state.interactions[0]?.resumeState).toBe('unknown')
    expect(await polls(snapshot)).toBe(true)

    // Clearing a lifecycle flag is deliberately NOT a closure attestation.
    await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: false })
    snapshot = await compare()
    expect(snapshot.state.run.pendingInteractionCount).toBe(0)
    expect(await polls(snapshot)).toBe(true)
    const beforeFinal = snapshot.asOfSequence
    cleanup.confirm(); cleanup.resolve.mockClear()
    await cleanup.native.cancelRun(f.f.run.id)
    expect(cleanup.closeNative).toHaveBeenCalled()
    expect(cleanup.resolve).not.toHaveBeenCalled()
    const final = await compare()
    expect(final.state.interactions).toEqual([])
    expect(final.state.reviews).toEqual([])
    expect(final.state.run.pendingInteractionCount).toBe(0)
    expect(final.state.run.unsettledReviewCount).toBe(0)
    expect(final.state.run.cleanupPending).toBe(false)
    expect(final.state.nodes.every((node) => node.attention.pendingInteractionCount === 0
      && node.attention.unsettledReviewCount === 0 && !node.attention.cleanupPending)).toBe(true)
    // Interrupted Runs still poll by the existing product contract; this lane
    // only permits polling to stop on the completed-and-fully-settled Stop case.
    expect(await polls(final)).toBe(kind !== 'stop')
    await assertFinalPublication(f, id, beforeFinal, canceled.revision)
    expect(await currentInteraction(f, id)).toEqual(canceled)
    expect(await cut.readEvidence()).toEqual(cut.evidence)
    await assertNoWorkerAcknowledgement(f, id)

    const successor = f.compose(), observe = vi.spyOn(successor.native, 'ensureObserve')
    for (let n = 0; n < 2; n++) {
      if (kind === 'stop') await f.runs.requestStop(f.f.run.id)
      expect(await f.repository.cancelPendingForRun(f.f.run.id)).toBe(0)
      await cleanup.native.cancelRun(f.f.run.id)
      // Completed requested-ID callbacks are no-ops; interrupted Runs reject
      // re-entry. Neither may turn a historical receipt into native permission.
      if (kind === 'stop') await expect(successor.engine.resumeInteraction(cut.staleDelivered)).resolves.toBeUndefined()
      else await expect(successor.engine.resumeInteraction(cut.staleDelivered)).rejects.toMatchObject({ code: 'RUN_NOT_RESUMABLE' })
      expect(observe).not.toHaveBeenCalled()
      expect((await compare()).asOfSequence).toBe(final.asOfSequence)
      expect(await currentInteraction(f, id)).toEqual(canceled)
      expect(await cut.readEvidence()).toEqual(cut.evidence)
    }
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
    await assertNoWorkerAcknowledgement(f, id)
    await assertFinalPublication(f, id, cut.snapshot.asOfSequence, canceled.revision)
  }, 60000)

  it('cannot restore pre-cleanup native work by clearing the flag before business settlement', async () => {
    const { f, compare } = await fixture(), cut = await commitBeforeAck(f, compare)
    const native = await nativeProjection(f)
    await changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: true })
    await compare()
    expect(await f.repository.cancelPendingForRun(f.f.run.id)).toBe(1)
    const canceled = await currentInteraction(f, cut.interaction.id), before = await compare()
    await assertCleanupProjection(f, before, cut.interaction.executionId)
    // A flag toggle has no native source. The unchanged event schema must reject
    // old active/running work rather than silently making snapshot-only progress.
    await expect(changeOneShotLifecycle(f.db.pool, f.f.run.id, { kind: 'cleanup', pending: false }))
      .rejects.toMatchObject({ code: 'GRAPH_INVALID_FACT' })
    expect((await compare()).asOfSequence).toBe(before.asOfSequence)
    expect((await compare()).state).toEqual(before.state)
    expect((await f.db.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.f.run.id])).rows)
      .toEqual([{ pending: true }])
    expect(await currentInteraction(f, cut.interaction.id)).toEqual(canceled)
    expect(await nativeProjection(f)).toEqual(native)
    expect(await cut.readEvidence()).toEqual(cut.evidence)
    await assertNoWorkerAcknowledgement(f, cut.interaction.id)
  }, 60000)

  it('does not reopen an acknowledged delivery on terminal cleanup (late Stop is a no-op)', async () => {
    const { f, compare } = await fixture()
    await f.engine.start(f.f.run.id); await compare()
    const [interaction] = await f.pending()
    if (!interaction) throw new Error('Expected native approval')
    await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction))
    await compare()
    const settled = await currentInteraction(f, interaction.id)
    const ack = (await f.db.pool.query('select * from interaction_graph_resumes where interaction_id=$1', [interaction.id])).rows
    expect(ack).toEqual([expect.objectContaining({ state: 'resumed', approval_native_ack_id: expect.stringMatching(/^continuation-ack-/) })])
    const receipts = await f.receipts(), writes = await f.writes()
    expect(receipts).toHaveLength(1)
    await f.runs.requestStop(f.f.run.id)
    const stopped = await compare()
    const cleanup = cleanupCoordinator(f); cleanup.confirm()
    expect(await f.repository.cancelPendingForRun(f.f.run.id)).toBe(0)
    await cleanup.native.cancelRun(f.f.run.id)
    const final = await compare()
    expect(final.state.interactions).toEqual([])
    expect(await currentInteraction(f, interaction.id)).toEqual(settled)
    expect((await f.db.pool.query('select * from interaction_graph_resumes where interaction_id=$1', [interaction.id])).rows).toEqual(ack)
    expect(await f.receipts()).toEqual(receipts)
    expect(await f.writes()).toEqual(writes)
    expect(f.provider.counts.responses).toBe(1)
    expect((await batches(f, stopped.asOfSequence)).flatMap((batch) => batch.events).filter(({ fact }) =>
      fact.type === 'interaction.state' || fact.type === 'exchange.retired' || fact.type === 'worker.resumed')).toEqual([])
  }, 60000)

  it('preserves live-authority rejection and competing-owner exclusion at the committed cut', async () => {
    const { f, compare } = await fixture(), cut = await commitBeforeAck(f, compare)
    await expect(f.repository.cancelPendingForRun(f.f.run.id)).rejects.toMatchObject({ code: 'EXECUTION_NOT_STOPPED' })
    expect((await compare()).asOfSequence).toBe(cut.snapshot.asOfSequence)
    const held = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
    if (!held) throw new Error('Expected independent Run owner')
    try {
      const errors: unknown[] = []
      await f.compose().engine.reconcile((error) => errors.push(error))
      expect(errors).toEqual([])
      expect(await cut.readEvidence()).toEqual(cut.evidence)
      expect((await compare()).asOfSequence).toBe(cut.snapshot.asOfSequence)
      await assertNoWorkerAcknowledgement(f, cut.interaction.id)
      expect(f.provider.counts.responses).toBe(1)
    } finally { await held.release() }
  }, 60000)
})
