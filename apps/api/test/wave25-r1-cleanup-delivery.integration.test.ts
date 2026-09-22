import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeGraphObservation } from '@graphql/contracts/wave25'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { agent3Database, seedAgent3, deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { ReviewJobSchema } from '@graphql/contracts'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'
import { identity, transact } from '../src/modules/interactions/wave25/context.js'
import { recordReviewObservation } from '../src/modules/interactions/wave25/nativeEvidence.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import type { NativeGraphProjectionGuard } from '../src/modules/run-graph/records.js'
import type { NativeDeliveryOutcome } from '../src/modules/interactions/delivery.js'

type Fixture = Awaited<ReturnType<typeof approvalDatabase>>
const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback database explicitly named for tests')
  }
  const f = await approvalDatabase(); closes.push(f.close); return f
}

/** Component fixture only: observations are supplied directly to the existing
 * domain consumer to isolate delivery. This is NOT evidence for BR1-002/008 or
 * for production native-ingestion registration. No provider is launched. */
async function settleReview(f: Fixture) {
  const work = { execution: identity(f.reviewer), workKind: 'review' as const, workId: f.job.id }
  const row = (await f.pool.query<{ fence: string }>('select lease_fence::text as fence from review_jobs where id=$1', [f.job.id])).rows[0]!
  const guard: NativeGraphProjectionGuard = {
    expected: { scope: f.scope, key: work, ownerId: 'review-owner-token', fence: row.fence, connectionGeneration: '0' },
    readCurrentLocked: async (sql) => {
      const actual = (await sql.query<{ token: string; fence: string; generation: string; held: boolean }>(
        `select j.lease_token as token,j.lease_fence::text as fence,l.record->>'connectionGeneration' as generation,
          j.lease_expires_at>clock_timestamp() as held from review_jobs j join native_session_lanes l
          on l.native_session_id=j.record->>'nativeSessionId' and l.harness=j.record->>'provider'
          where j.id=$1 for update of j,l`, [f.job.id])).rows[0]!
      return { scope: f.scope, key: work, ownerId: actual.token, fence: actual.fence,
        connectionGeneration: actual.generation, ownership: actual.held ? 'held' : 'lost', access: 'project' }
    },
  }
  for (const terminal of [false, true]) {
    const source = { sourceKind: 'native_event' as const, sourceId: `r1-fixture-${terminal ? 'terminal' : 'ack'}`, sourceRevision: '0' }
    const observation: NativeGraphObservation = { scope: f.scope, work, source,
      sourceStreamId: 'r1-fixture-stream', sourcePosition: terminal ? '2' : '1', connectionGeneration: '0',
      observedAt: new Date().toISOString(), ...(terminal ? { kind: 'terminal' as const, submissionId: 'provider-review-turn',
        terminal: { outcome: 'succeeded' as const, evidenceKind: 'provider_terminal' as const, evidenceId: 'r1-fixture-terminal', nativeSettled: true } }
        : { kind: 'submission' as const, submissionId: 'provider-review-turn', state: 'acknowledged' as const }) }
    await transact(f.pool, f.run.id, async (publication) => publication.source({ evidence: source,
      sourceDigest: graphSourceDigest(observation), facts: [{ type: 'node.activity', activity: { workflowNodeId: f.reviewer.workflowNodeId, status: 'none' } }] },
    () => recordReviewObservation(publication, observation, guard)))
    await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', terminal ? 'completed' : 'acknowledged', {
      writerFence: { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' },
      providerTurnOrMessageId: 'provider-review-turn', releaseLease: terminal,
    })
  }
}
async function deliveryClaim(f: Fixture) {
  await f.repository.decide({ id: f.interaction.id, optionId: 'approve-once', expectedRevision: f.interaction.revision,
    principal: f.principal, nativeResponse: { optionId: 'approve-once', semantic: 'approve_once' } })
  await settleReview(f)
  const claim = await f.repository.delivery.claim(f.interaction.id, 'r1-delivery-owner')
  if (!claim) throw new Error('Expected a real, settled delivery claim')
  return claim
}
async function within<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('External native I/O blocked the Run publication lock')), milliseconds)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

function cleanupCoordinator(f: Fixture, closesNative: boolean) {
  const workflows = new PostgresWorkflowRepository(f.pool)
  const runs = new PostgresRunRepository(f.pool, workflows,
    new WorkspaceLocationService(f.pool, f.commands, '/synthetic/approval-test'))
  const resolve = vi.fn(() => ({ manager: { harness: 'codex' } as NativeHarnessSessionManager, processState: 'needs_start' as const }))
  const credentials = { revokeForExecution: (id: string) => f.credentials.revokeForExecution(id) } as unknown as NonNullable<ConstructorParameters<typeof ApprovalExecutionCoordinator>[5]>
  // Only the external process-closure primitive is synthetic. The coordinator,
  // approval repository, budgets, revocation and cleanup publications are real.
  const native = new ApprovalExecutionCoordinator(runs, f.repository, new PostgresApprovalBudgetRepository(f.pool),
    { resolve }, 600000, credentials, undefined, async () => closesNative)
  return { native, resolve }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('BR1-005/006: real PostgreSQL owning boundaries', () => {
  it('durable cleanup without user Stop closes positive authority and lets actual cancellation finish', async () => {
    const f = await setup(), before = structuredClone(f.run)
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: true })
    expect(await f.repository.coordination.reviewRunStopped(f.job.id)).toBe(true)
    await expect(f.repository.decide({ id: f.interaction.id, optionId: 'approve-once', expectedRevision: f.interaction.revision,
      principal: f.principal, nativeResponse: { optionId: 'approve-once', semantic: 'approve_once' } })).rejects.toBeDefined()
    const { native, resolve } = cleanupCoordinator(f, true)
    await native.cancelRun(f.run.id)
    expect(resolve).not.toHaveBeenCalled() // closure does not allocate a replacement provider
    const job = ReviewJobSchema.parse((await f.pool.query('select record from review_jobs where id=$1', [f.job.id])).rows[0].record)
    expect(job?.cleanup?.completedAt).toBeDefined()
    expect(job?.cleanup?.credentialState).toBe('revoked')
    expect((await f.repository.get(f.interaction.id))?.status).toBe('canceled')
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: false })
    const row = (await f.pool.query('select record,stop_requested_at from runs where id=$1', [f.run.id])).rows[0]
    expect(row.record).toEqual(before)
    expect(row.stop_requested_at).toBeNull()
    expect((await f.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0].pending).toBe(false)
  })
  it('unconfirmed native closure retains cleanup instead of manufacturing proof or user Stop', async () => {
    const f = await setup()
    await changeOneShotLifecycle(f.pool, f.run.id, { kind: 'cleanup', pending: true })
    await expect(cleanupCoordinator(f, false).native.cancelRun(f.run.id)).rejects.toBeDefined()
    const job = ReviewJobSchema.parse((await f.pool.query('select record from review_jobs where id=$1', [f.job.id])).rows[0].record)
    expect(job?.cleanup?.completedAt).toBeUndefined()
    expect((await f.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0].pending).toBe(true)
    expect((await f.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).toBeNull()
  })
  it('Stop commits on an independent connection while a non-cooperative provider is unresolved', async () => {
    const f = await setup(), claim = await deliveryClaim(f), entered = deferred(), release = deferred<NativeDeliveryOutcome>()
    const controller = new AbortController()
    const operation = f.repository.delivery.finish(claim, async () => { entered.resolve(); return release.promise }, controller.signal)
    const observed = operation.then((value) => ({ value }), (error: unknown) => ({ error }))
    let stop: Promise<void> | undefined
    try {
      await within(entered.promise)
      // The real lifecycle writer takes the very same Run/head locks as other
      // publishers, using its own connection from the fixture's multi-client pool.
      stop = changeOneShotLifecycle(f.pool, f.run.id, { kind: 'stop' })
      await within(stop)
      expect((await f.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).not.toBeNull()
      release.resolve({ state: 'delivered', evidence: deliveryFixture().proof })
      await observed
      // A late delivery receipt may be recorded; it must never grant continuation.
      const resume = (await f.pool.query<{ state: string; approval_native_ack_id: string | null }>(
        'select state,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [f.interaction.id])).rows[0]
      expect(resume?.state).not.toBe('resumed')
      expect(resume?.approval_native_ack_id).toBeNull()
      expect((await f.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='graph.resume'", [f.run.id])).rowCount).toBe(0)
    } finally {
      controller.abort(new Error('test-cleanup'))
      release.resolve({ state: 'uncertain' })
      await observed; await stop?.catch(() => undefined)
    }
  })
  it('a changed generation rejects the old result and permits reconciliation, not another submit', async () => {
    const f = await setup(), claim = await deliveryClaim(f), entered = deferred(), release = deferred<NativeDeliveryOutcome>()
    const operation = f.repository.delivery.finish(claim, async () => { entered.resolve(); return release.promise })
    const observed = operation.then(() => undefined, (error: unknown) => error)
    try {
      await within(entered.promise)
      await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}','1'::jsonb) where owner_agent_id=$1", [f.requester.agentId])
      release.resolve({ state: 'delivered', evidence: deliveryFixture().proof })
      expect(await observed).toMatchObject({ code: 'GRAPH_STALE_GENERATION' })
      expect((await f.pool.query('select 1 from interaction_graph_resumes where interaction_id=$1', [f.interaction.id])).rowCount).toBe(0)
      await f.pool.query("update durable_interactions set delivery_lease_expires_at='2000-01-01' where id=$1", [f.interaction.id])
      await f.pool.query("update interaction_delivery_attempts set lease_expires_at='2000-01-01' where interaction_id=$1", [f.interaction.id])
      const recovery = await f.repository.delivery.claim(f.interaction.id, 'r1-recovery-owner')
      expect(recovery?.mode).toBe('reconcile')
      expect(recovery?.attempt).toBe(claim.attempt)
      expect(recovery?.correlationId).toBe(claim.correlationId)
      const native = vi.fn(async (): Promise<NativeDeliveryOutcome> => ({ state: 'delivered', evidence: deliveryFixture().proof }))
      await expect(f.repository.delivery.finish(recovery!, native)).rejects.toMatchObject({ code: 'GRAPH_SUBMISSION_NOT_REPLAYABLE' })
      expect(native).not.toHaveBeenCalled()
    } finally { release.resolve({ state: 'uncertain' }); await observed }
  })
})

describe.skipIf(!postgresEnabled)('BR1-005: cleanup of an active v2 Run with zero native/review work', () => {
  it('the real coordinator permits the committed negative cleanup boundary with an empty review set', async () => {
    const database = await agent3Database(); closes.push(database.close)
    const f = await seedAgent3(database.pool, database.directory)
    const repository = new Wave25InteractionRepository(database.pool)
    const runs = new PostgresRunRepository(database.pool, new PostgresWorkflowRepository(database.pool),
      new WorkspaceLocationService(database.pool, new PostgresCommandCoordinator(database.pool), database.directory))
    const resolve = vi.fn(() => { throw new Error('Empty cleanup must not allocate a native manager') })
    const native = new ApprovalExecutionCoordinator(runs, repository, new PostgresApprovalBudgetRepository(database.pool), { resolve }, 600000)
    await changeOneShotLifecycle(database.pool, f.run.id, { kind: 'cleanup', pending: true })
    await native.cancelRun(f.run.id)
    await changeOneShotLifecycle(database.pool, f.run.id, { kind: 'cleanup', pending: false })
    expect(resolve).not.toHaveBeenCalled()
    expect((await database.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).toBeNull()
    expect((await database.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0].pending).toBe(false)
  })
})
