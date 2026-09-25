import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { test } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction, type NativeHarnessEvent, type NativeSessionLane, type NativeSessionReference, type ReviewJob } from '@graphql/contracts'

import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { PostgresInteractionCoordinationRepository, type WriterFence } from '../src/modules/interactions/coordination.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import type { ReviewerNativeRuntime } from '../src/modules/interactions/reviewerRuntime.js'
import { reviewTurnEvidence } from '../src/modules/interactions/reviewerEvidence.js'
import { LeaseGuard, ownedEvents, SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'

const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'reviewer-native' }
const interaction: DurableInteraction = {
  ...NATIVE_INTERACTION_FIXTURES.codex,
  approval: { ...NATIVE_INTERACTION_FIXTURES.codex.approval, handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' },
}
const event = (type: string, payload: Record<string, unknown> = {}): NativeHarnessEvent =>
  ({ sequence: 0, type, payload, occurredAt: new Date().toISOString() })
const history = (events: NativeHarnessEvent[] = []): NativeHistory => ({ events, pendingInteractions: [] })
const startEvent = (correlation: string) => event('turn.started', { threadId: session.nativeSessionId, turnId: 'native-turn', clientCorrelationId: correlation })
const endEvent = () => event('turn/completed', { threadId: session.nativeSessionId, turn: { id: 'native-turn', status: 'completed' } })
const idleHistory = () => history([event('thread.reconciled', { thread: { id: session.nativeSessionId, status: 'idle', turns: [] } })])
const clone = <T>(value: T): T => structuredClone(value)

/** Deterministic fencing fake. PostgreSQL predicate coverage lives in reviewer-coordination.test.ts. */
class CoordinationFake {
  job: ReviewJob | undefined
  lane: NativeSessionLane = { id: 'lane', harness: session.harness, nativeSessionId: session.nativeSessionId, ownerAgentId: 'reviewer', observedStatus: 'idle', revision: 0,
    connectionGeneration: 0, observedAt: new Date().toISOString() }
  context = { executionId: 'reviewer-execution', workingDirectory: '/accepted', providerVersion: session.providerVersion }
  transitions: ReviewJob['state'][] = []
  renewJobs = 0
  renewLanes = 0
  failJobRenewal = false
  failLaneRenewal = false
  pending = true
  delivered = false
  runStopped = false
  async reviewRunStopped() { return this.runStopped }
  readonly nativeEvents: NativeHarnessEvent[] = []
  // Scheduler-only policy port. Real immutable-graph checks live in the authenticated DB integration tests.
  graphAllowed = true
  async assertOrchestratorConnection() {
    if (!this.graphAllowed) throw new DomainError('INTERACTION_ACCESS_DENIED', 'Not directly connected.', 403)
  }
  async assertReviewConnection() { await this.assertOrchestratorConnection() }

  async appendReviewNativeEvent(_job: ReviewJob, event: NativeHarnessEvent) {
    assert.equal(_job.id, this.job?.id)
    this.nativeEvents.push(clone(event))
  }

  asRepository() { return this as unknown as PostgresInteractionCoordinationRepository }
  async ensureReviewJob(job: ReviewJob, context: typeof this.context) {
    if (this.job) return { job: clone(this.job), created: false }
    this.job = clone(job); this.context = context
    return { job: clone(job), created: true }
  }
  async findReviewJob() { return this.job && clone(this.job) }
  async getReviewJobContext() { return this.context }
  async nextReviewJob() {
    if (!this.job || this.job.state === 'completed'
      || (this.job.state === 'failed' && (!this.job.cleanup || this.job.cleanup.completedAt))
      || (this.job.leaseExpiresAt && Date.parse(this.job.leaseExpiresAt) > Date.now())
      || (this.job.retryAfter && Date.parse(this.job.retryAfter) > Date.now())) return undefined
    return clone(this.job)
  }
  async reviewJobAgents() { return await this.nextReviewJob() ? ['reviewer'] : [] }
  async isReviewPending() { return this.pending }
  async reviewDecisionDelivered() { return this.delivered }
  async claimReviewJob(_id: string, owner: string, token: string, expires: string) {
    const current = await this.nextReviewJob()
    // Recheck after the await, just as the SQL update holds the row lock.
    if (!current || (this.job?.leaseExpiresAt && Date.parse(this.job.leaseExpiresAt) > Date.now())) {
      throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'owned', 409)
    }
    this.job = { ...current, state: ['submitted', 'acknowledged', 'uncertain', 'failed'].includes(current.state) ? current.state : 'leased',
      attempt: current.attempt + 1, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expires, retryAfter: undefined }
    return clone(this.job)
  }
  async assertReviewJobLease(_id: string, token: string) {
    if (this.job?.leaseToken !== token || Date.parse(this.job.leaseExpiresAt ?? '') <= Date.now()) {
      throw new DomainError('REVIEW_JOB_LEASE_LOST', 'lost', 409)
    }
  }
  async renewReviewJob(id: string, token: string, ms: number) {
    if (this.failJobRenewal) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'lost', 409)
    await this.assertReviewJobLease(id, token)
    this.renewJobs++
    return this.job!.leaseExpiresAt = new Date(Date.now() + ms).toISOString()
  }
  async transitionReviewJob(id: string, token: string, state: ReviewJob['state'], fields: {
    providerTurnOrMessageId?: string; writerFence?: WriterFence; releaseLease?: boolean; error?: ReviewJob['error']; cleanup?: ReviewJob['cleanup']; retryAfter?: string
  } = {}) {
    await this.assertReviewJobLease(id, token)
    if (fields.writerFence) await this.assertLaneLease(fields.writerFence.id, fields.writerFence.token)
    this.transitions.push(state)
    this.job = { ...this.job!, state, updatedAt: new Date().toISOString(),
      ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
      ...(fields.error ? { error: fields.error } : {}),
      ...(fields.cleanup ? { cleanup: fields.cleanup } : {}),
      ...(fields.retryAfter ? { retryAfter: fields.retryAfter } : {}) }
    if (state === 'submitted') this.job.submittedAt = new Date().toISOString()
    if (state === 'acknowledged') this.job.acknowledgedAt = new Date().toISOString()
    if (state === 'completed') this.job.completedAt = new Date().toISOString()
    if (fields.releaseLease ?? ['completed', 'failed', 'uncertain', 'blocked_busy', 'blocked_disconnected'].includes(state)) {
      delete this.job.leaseOwner; delete this.job.leaseToken; delete this.job.leaseExpiresAt
    }
    return clone(this.job)
  }
  async ensureLane(lane: NativeSessionLane) {
    if (lane.ownerAgentId !== this.lane.ownerAgentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'wrong owner', 409)
    return clone(this.lane)
  }
  async getLane() { return clone(this.lane) }
  async claimLane(_id: string, revision: number, owner: string, token: string, expires: string, correlationId: string) {
    if (revision !== this.lane.revision || (this.lane.leaseExpiresAt && Date.parse(this.lane.leaseExpiresAt) > Date.now())) {
      throw new DomainError('SESSION_LANE_BUSY', 'busy', 409)
    }
    this.lane = { ...this.lane, revision: revision + 1, leaseOwner: owner, leaseToken: token,
      leaseExpiresAt: expires, observedStatus: 'busy' }
    void correlationId
    return clone(this.lane)
  }
  async assertLaneLease(_id: string, token: string) {
    if (this.lane.leaseToken !== token || Date.parse(this.lane.leaseExpiresAt ?? '') <= Date.now()) {
      throw new DomainError('SESSION_LANE_LEASE_LOST', 'lost', 409)
    }
  }
  async bindLaneTurn(fence: WriterFence, correlation: string) {
    await this.assertLaneLease(fence.id, fence.token)
    this.lane.correlationId = correlation
    delete this.lane.currentTurnOrMessageId
  }
  async renewLane(id: string, token: string, ms: number) {
    if (this.failLaneRenewal) throw new DomainError('SESSION_LANE_LEASE_LOST', 'lost', 409)
    await this.assertLaneLease(id, token)
    this.renewLanes++
    return this.lane.leaseExpiresAt = new Date(Date.now() + ms).toISOString()
  }
  async releaseLane(id: string, token: string, observed: Pick<NativeSessionLane, 'observedStatus' | 'currentTurnOrMessageId'>) {
    await this.assertLaneLease(id, token)
    this.lane = { ...this.lane, ...observed, revision: this.lane.revision + 1 }
    delete this.lane.leaseOwner; delete this.lane.leaseToken; delete this.lane.leaseExpiresAt
    if (observed.observedStatus === 'idle' && !observed.currentTurnOrMessageId) delete this.lane.correlationId
    return clone(this.lane)
  }
}

function fixture(ms = 30_000) {
  const coordination = new CoordinationFake()
  let started = 0
  let attached = 0
  let reconciled = 0
  let canceled = 0
  let responded = 0
  const manager = {
    harness: 'codex',
    capabilities: async () => ({ providerVersion: session.providerVersion }),
    createSession: async () => session,
    attachSession: async () => { attached++; return session },
    startTurn: async function* (_session: NativeSessionReference, input: { clientCorrelationId: string }) {
      started++; yield startEvent(input.clientCorrelationId); coordination.pending = false; yield endEvent()
    },
    reconcile: async () => { reconciled++; return idleHistory() },
    pending: async () => undefined,
    history: async () => history(),
    respond: async () => { responded++ },
    cancel: async () => { canceled++; return true },
    close: async () => undefined,
  } as unknown as NativeHarnessSessionManager
  const runtime: ReviewerNativeRuntime = { attachInteraction: async () => ({ manager, session }), attachOwnedSession: async () => ({ manager, session }) }
  const dispatcher = new ReviewerDispatcher(coordination.asRepository(), runtime, ms)
  return { coordination, manager, runtime, dispatcher, counts: () => ({ started, attached, reconciled, canceled, responded }) }
}
async function enqueue(f: ReturnType<typeof fixture>) {
  return f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
}

test('rejects an unconnected request before persisting or dispatching a review', async () => {
  const f = fixture(); f.coordination.graphAllowed = false
  await assert.rejects(enqueue(f), { code: 'INTERACTION_ACCESS_DENIED' })
  assert.equal(f.coordination.job, undefined)
  assert.equal(f.counts().started, 0)
})

test('rechecks topology on recovery before claiming an older queued review', async () => {
  const f = fixture(); await enqueue(f); f.coordination.graphAllowed = false
  await assert.rejects(f.dispatcher.dispatchNext('reviewer', 'worker'), { code: 'INTERACTION_ACCESS_DENIED' })
  assert.equal(f.coordination.job?.state, 'pending')
  assert.equal(f.counts().started, 0)
  assert.equal(f.counts().attached, 0)
})


test('post-delivery disconnect remains recoverable and only matching terminal history completes it', async () => {
  const f = fixture(); await enqueue(f)
  let submissions = 0
  f.manager.startTurn = async function* (_session, input) {
    submissions++
    yield startEvent(input.clientCorrelationId)
    f.coordination.pending = false
    f.coordination.delivered = true
    throw new Error('stream disconnected after decision delivery')
  }
  const first = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(first?.state, 'uncertain')
  assert.equal(first?.completedAt, undefined)
  assert.equal(first?.providerTurnOrMessageId, 'native-turn')
  assert.equal(f.coordination.lane.observedStatus, 'uncertain')
  // A session-idle event alone is not completion of the exact review.
  delete f.coordination.job!.retryAfter
  f.manager.reconcile = async () => idleHistory()
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'recovery-1'))?.state, 'acknowledged')
  f.manager.reconcile = async () => history([endEvent()])
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'recovery-2'))?.state, 'completed')
  assert.equal(submissions, 1)
  assert.equal(f.counts().responded, 0)
  assert.equal(f.coordination.delivered, true)
})

for (const failure of ['credential', 'identity'] as const) {
  test(`post-delivery ${failure} failure stays failed with cleanup instead of successful completion`, async () => {
    const f = fixture(); await enqueue(f)
    const credential = new AbortController()
    let revoked = 0, submissions = 0
    f.runtime.maintainReviewCredential = async (_executionId, _session, signal) => ({
      principalId: 'captured-principal', signal: AbortSignal.any([signal, credential.signal]),
      stop: async () => undefined, invalidate: async () => { revoked++ },
    })
    f.manager.startTurn = async function* (_session, input) {
      submissions++
      yield startEvent(input.clientCorrelationId)
      f.coordination.pending = false; f.coordination.delivered = true
      if (failure === 'credential') {
        credential.abort(new DomainError('REVIEWER_CREDENTIAL_LOST', 'credential maintenance failed', 409))
        credential.signal.throwIfAborted()
      }
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'conflicting native identity', 409)
    }
    f.manager.reconcile = async () => history()
    const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(result?.state, 'failed')
    assert.equal(result?.error?.code, failure === 'credential' ? 'REVIEWER_CREDENTIAL_LOST' : 'REVIEW_JOB_IDENTITY_CONFLICT')
    assert.equal(result?.cleanup?.nativeState, 'pending')
    assert.equal(result?.cleanup?.completedAt, undefined)
    assert.equal(revoked, 1)
    assert.equal(submissions, 1)
    assert.equal(f.counts().responded, 0)
    if (failure === 'identity') assert.equal(f.counts().canceled, 0)
    assert.ok(await f.coordination.nextReviewJob())
  })
}

test('a terminal Run moves an unsettled post-delivery review into closure-only recovery after restart', async () => {
  const f = fixture(); const job = await enqueue(f)
  f.coordination.job = { ...job, state: 'uncertain', submittedAt: job.createdAt, providerTurnOrMessageId: 'native-turn' }
  f.coordination.runStopped = true
  f.coordination.delivered = true; f.coordination.pending = false
  let attaches = 0, cleanupReads = 0
  f.runtime.attachOwnedSession = async () => { attaches++; return { manager: f.manager, session } }
  f.runtime.recoverReviewCleanup = async () => { cleanupReads++; return { manager: f.manager, resident: false, closed: false } }
  const restarted = new ReviewerDispatcher(f.coordination.asRepository(), f.runtime)
  const result = await restarted.dispatchNext('reviewer', 'after-restart')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEW_RUN_STOPPED')
  assert.equal(result?.cleanup?.nativeState, 'pending')
  assert.equal(attaches, 0)
  await restarted.dispatchNext('reviewer', 'cleanup')
  assert.equal(cleanupReads, 1)
  assert.equal(f.coordination.job?.cleanup?.completedAt, undefined)
  assert.equal(f.counts().started, 0)
  await restarted.shutdown()
})

for (const harness of ['codex', 'opencode'] as const) {
  for (const attachMode of ['resident', 'reattach'] as const) {
    test(`${harness} ${attachMode} uses A's saved pair to settle preflight before starting B`, async () => {
      const f = fixture()
      const reference: NativeSessionReference = { harness, providerVersion: harness === 'codex' ? '0.154.0' : '1.18.31', nativeSessionId: 'sequential-review' }
      const oldCorrelation = 'review-A'
      const oldProvider = harness === 'codex' ? 'native-A' : `msg_${createHash('sha256').update(oldCorrelation).digest('hex').slice(0, 24)}`
      const oldEvents = harness === 'codex'
        ? [event('thread.reconciled', { thread: { id: reference.nativeSessionId, status: 'idle', turns: [
            { id: oldProvider, clientUserMessageId: oldCorrelation, status: 'completed' },
          ] } })]
        : [event('message.updated', { info: { id: 'assistant-A', sessionID: reference.nativeSessionId,
            role: 'assistant', parentID: oldProvider, finish: 'stop', time: { completed: 1 } } }),
          event('session.status', { sessionID: reference.nativeSessionId, status: { type: 'idle' } })]
      f.coordination.lane = { ...f.coordination.lane, harness, nativeSessionId: reference.nativeSessionId,
        observedStatus: 'uncertain', correlationId: oldCorrelation, currentTurnOrMessageId: oldProvider }
      const reconciled: string[] = []
      let submissions = 0, attached = 0
      const manager: NativeHarnessSessionManager = { ...f.manager, harness,
        attachSession: async (_session, input) => {
          attached++
          assert.equal(input.correlationId, oldCorrelation)
          assert.equal(input.nativeTurnId, oldProvider)
          return reference
        },
        reconcile: async (_session, correlation) => {
          reconciled.push(correlation)
          return correlation === oldCorrelation ? history(oldEvents) : history()
        },
        startTurn: async function* (_session, input) {
          submissions++
          assert.notEqual(input.clientCorrelationId, oldCorrelation)
          f.coordination.pending = false
          if (harness === 'codex') {
            yield event('turn.started', { threadId: reference.nativeSessionId, turnId: 'native-B', clientCorrelationId: input.clientCorrelationId })
            yield event('turn/completed', { threadId: reference.nativeSessionId, turn: { id: 'native-B', status: 'completed' } })
          } else {
            const id = `msg_${createHash('sha256').update(input.clientCorrelationId).digest('hex').slice(0, 24)}`
            await input.onSubmitted?.(id)
            yield event('message.updated', { info: { id: 'assistant-B', sessionID: reference.nativeSessionId,
              role: 'assistant', parentID: id, time: { completed: 2 }, finish: 'stop' } })
          }
        },
      }
      f.runtime.attachOwnedSession = async (context) => {
        assert.equal(context.correlationId, oldCorrelation)
        assert.equal(context.nativeTurnId, oldProvider)
        if (attachMode === 'reattach') {
          const owner = new SingleWriterSessionManager(manager, f.coordination.asRepository(), 'reviewer')
          await owner.attachSession(reference, { kind: 'workflow', correlationId: context.correlationId,
            nativeTurnId: context.nativeTurnId } as NativeSessionStart)
        }
        return { manager, session: reference }
      }
      await f.dispatcher.enqueue(interaction, 'reviewer', reference, f.coordination.context)
      assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'completed')
      assert.equal(reconciled[0], oldCorrelation)
      assert.equal(submissions, 1)
      assert.equal(attached, attachMode === 'reattach' ? 1 : 0)
    })
  }
}

test('a changed unresolved lane pair refuses stale reattachment before any native call', async () => {
  const f = fixture()
  f.coordination.lane = { ...f.coordination.lane, observedStatus: 'uncertain', correlationId: 'new-owner', currentTurnOrMessageId: 'new-turn' }
  const writer = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  await assert.rejects(writer.attachSession(session, { kind: 'workflow', correlationId: 'old-owner', nativeTurnId: 'old-turn' } as NativeSessionStart),
    { code: 'SESSION_LANE_BUSY' })
  assert.equal(f.counts().attached, 0)
})

for (const status of ['busy', 'disconnected', 'uncertain'] as const) {
  test(`refreshes stale ${status} native lane before dispatch`, async () => {
    const f = fixture(); await enqueue(f)
    f.coordination.lane.observedStatus = status
    const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(result?.state, 'completed')
    assert.equal(f.counts().started, 1)
    assert.equal(f.coordination.lane.observedStatus, 'idle')
  })
}

test('enqueues idempotently and enforces designated reviewer ownership', async () => {
  const f = fixture()
  const first = await enqueue(f); const second = await enqueue(f)
  assert.equal(second.id, first.id)
  assert.equal(second.correlationId, first.correlationId)
  assert.equal(second.nativeSessionId, session.nativeSessionId)
  await assert.rejects(f.dispatcher.enqueue(interaction, 'other', session, f.coordination.context), { code: 'REVIEWER_ASSIGNMENT_MISMATCH' })
})

test('does not submit a review after the interaction is decided or canceled', async () => {
  const f = fixture(); await enqueue(f); f.coordination.pending = false
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'failed')
  assert.equal(f.counts().started, 0)
})

test('a missing saved cgroup boundary blocks review permanently without replaying native work', async () => {
  const f = fixture(); await enqueue(f)
  f.runtime.attachOwnedSession = async () => { throw Object.assign(new Error('missing native boundary'), {
    code: 'ENOENT', path: '/sys/fs/cgroup/test/graphql-native-12345678-1234-1234-1234-123456789abc',
  }) }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEW_NATIVE_CLOSURE_UNCONFIRMED')
  assert.equal(result?.cleanup?.nativeState, 'pending')
  assert.equal(result?.cleanup?.completedAt, undefined)
  f.runtime.recoverReviewCleanup = async () => ({ manager: f.manager, resident: false, closed: false })
  const restarted = new ReviewerDispatcher(f.coordination.asRepository(), f.runtime)
  assert.equal((await restarted.dispatchNext('reviewer', 'cleanup-worker'))?.state, 'failed')
  assert.equal(f.coordination.job?.cleanup?.completedAt, undefined)
  assert.equal(f.counts().started, 0)
  await restarted.shutdown()
})

test('a transient reviewer attachment failure delays its next attempt', async () => {
  const f = fixture(); await enqueue(f)
  f.runtime.attachOwnedSession = async () => { throw new Error('transport unavailable') }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'blocked_disconnected')
  assert.ok(Date.parse(result.retryAfter!) > Date.now())
  assert.equal(await f.dispatcher.dispatchNext('reviewer', 'worker'), undefined)
  assert.equal(f.counts().started, 0)
})

test('fresh review preserves the unresolved previous review pair at attachment and preflight', async () => {
  const f = fixture(); await enqueue(f)
  f.coordination.lane = { ...f.coordination.lane, observedStatus: 'uncertain',
    correlationId: 'review-A', currentTurnOrMessageId: 'native-A' }
  let attachedCorrelation: string | undefined
  let attachedTurn: string | undefined
  const inspected: string[] = []
  f.runtime.attachOwnedSession = async (context) => {
    attachedCorrelation = context.correlationId
    attachedTurn = context.nativeTurnId
    return { manager: f.manager, session }
  }
  f.manager.reconcile = async (_session, correlation) => {
    inspected.push(correlation)
    return correlation === 'review-A' ? history([event('thread.reconciled', { thread: {
      id: session.nativeSessionId, status: 'idle', turns: [{ id: 'native-A', clientUserMessageId: 'review-A', status: 'completed' }],
    } })]) : idleHistory()
  }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'completed')
  assert.equal(attachedCorrelation, 'review-A')
  assert.equal(attachedTurn, 'native-A')
  assert.equal(inspected[0], 'review-A')
  assert.equal(f.counts().started, 1)
})

test('a terminal reviewer turn without a decision fails visibly and is never replayed', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    yield endEvent()
  }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEW_NO_DECISION')
  assert.ok(result?.cleanup)
  assert.equal(f.counts().started, 0)
  f.runtime.recoverReviewCleanup = async () => ({ manager: f.manager, resident: false, closed: false })
  const recovered = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(recovered?.state, 'failed')
  assert.equal(recovered?.cleanup?.completedAt, undefined)
  assert.equal(f.counts().started, 0)
})

test('delivered decision does not hide authority loss or falsely settle the native review', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    f.coordination.pending = false
    f.coordination.delivered = true
    throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The Run completed.', 409)
  }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEWER_CREDENTIAL_LOST')
  assert.equal(result?.cleanup?.nativeState, 'pending')
  assert.equal(result?.cleanup?.completedAt, undefined)
  assert.equal(f.coordination.delivered, true)
  assert.equal(f.counts().responded, 0)
})

test('iterator exhaustion and unrelated events are not acknowledgement or completion', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* () { yield event('thread.started', { threadId: session.nativeSessionId }) }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
  assert.deepEqual(f.coordination.transitions, ['submitted', 'uncertain'])
})

test('generic submission errors stay uncertain, explicit pre-acceptance rejection fails', async () => {
  for (const [error, expected] of [[new Error('socket lost'), 'uncertain'], [Object.assign(new Error('rejected'), { certainty: 'definite', result: { error: { code: 'OPENCODE_NATIVE_DELIVERY_REJECTED' } } }), 'failed']] as const) {
    const f = fixture(); await enqueue(f)
    f.manager.startTurn = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw error } }) })
    assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, expected)
  }
})

test('an acknowledged turn is never classified as definitely rejected by a later error', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    throw Object.assign(new Error('later read rejected'), { certainty: 'definite' })
  }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'uncertain')
  assert.equal(result?.providerTurnOrMessageId, 'native-turn')
})

for (const state of ['submitted', 'acknowledged', 'uncertain', 'blocked_disconnected', 'leased'] as const) {
  test(`recovers ${state} with prior submission using original correlation, never resubmits`, async () => {
    const f = fixture(); const job = await enqueue(f)
    f.coordination.job = { ...job, state, submittedAt: job.createdAt,
      leaseExpiresAt: new Date(Date.now() - 100).toISOString(), leaseToken: 'old' }
    f.coordination.pending = false
    f.coordination.lane.observedStatus = 'uncertain'
    f.manager.reconcile = async (_session, correlation) => {
      assert.equal(correlation, job.correlationId)
      return history([startEvent(job.correlationId), endEvent()])
    }
    const recovered = await f.dispatcher.dispatchNext('reviewer', 'successor')
    assert.equal(recovered?.state, 'completed')
    assert.equal(recovered?.correlationId, job.correlationId)
    assert.equal(recovered?.nativeSessionId, job.nativeSessionId)
    assert.equal(f.counts().started, 0)
  })
}

test('bare uncertain state without timestamps survives repeated recovery crashes without resend', async () => {
  const f = fixture(); const job = await enqueue(f)
  f.coordination.job = { ...job, state: 'uncertain' }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'uncertain')
  assert.equal(f.counts().started, 0)
})

test('acknowledged nonterminal EOF remains recoverable instead of completed', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) { yield startEvent(input.clientCorrelationId) }
  f.manager.reconcile = async () => history()
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'acknowledged')
  assert.equal(f.coordination.job?.leaseToken, undefined)
})

test('two dispatchers cannot double-claim one job', async () => {
  const f = fixture(); await enqueue(f)
  const results = await Promise.all([f.dispatcher.dispatchNext('reviewer', 'one'), f.dispatcher.dispatchNext('reviewer', 'two')])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(f.counts().started, 1)
})

test('a proven idle lane starts its first turn without inventing a recovery correlation', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  for await (const _event of owner.startTurn(session, { clientCorrelationId: 'first-turn', prompt: 'hello' })) void _event
  assert.equal(f.counts().started, 1)
  assert.equal(f.counts().reconciled, 1)
  assert.equal(f.coordination.lane.observedStatus, 'idle')
})

test('reviewer and normal workflow turn share active lane; long turns renew both leases', async () => {
  const f = fixture(150); await enqueue(f)
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId); started()
    await delay(400); f.coordination.pending = false; yield endEvent()
  }
  const task = f.dispatcher.dispatchNext('reviewer', 'worker')
  await began
  const ordinary = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer', 150)
  await assert.rejects(async () => { for await (const _event of ordinary.startTurn(session, { clientCorrelationId: 'normal', prompt: 'normal' })) { void _event } }, { code: 'SESSION_LANE_BUSY' })
  assert.equal(f.coordination.lane.observedStatus, 'busy')
  assert.equal((await task)?.state, 'completed')
  assert.ok(f.coordination.renewJobs >= 2)
  assert.ok(f.coordination.renewLanes >= 2)
})

for (const lost of ['job', 'lane'] as const) {
  test(`${lost} lease loss fences subsequent reviewer transitions and ends uncooperative iterator`, async () => {
    const f = fixture(120); await enqueue(f)
    let nextCalls = 0
    f.manager.startTurn = (_session, input) => ({
      [Symbol.asyncIterator]: () => ({ next: async () => {
        nextCalls++
        if (nextCalls === 1) {
          if (lost === 'job') f.coordination.failJobRenewal = true
          else f.coordination.failLaneRenewal = true
          return { done: false, value: startEvent(input.clientCorrelationId) }
        }
        return new Promise<IteratorResult<NativeHarnessEvent>>(() => undefined)
      } }),
    })
    // Keep the process alive while unref'ed lease timers are the only active handles.
    const keepAlive = delay(220)
    await assert.rejects(f.dispatcher.dispatchNext('reviewer', 'worker'), { code: lost === 'job' ? 'REVIEW_JOB_LEASE_LOST' : 'SESSION_LANE_LEASE_LOST' })
    assert.deepEqual(f.coordination.transitions, ['submitted', 'acknowledged'])
    assert.equal(nextCalls, 2)
    assert.ok(f.coordination.lane.leaseToken)
    await keepAlive
  })
}

test('hung renewal expires the local writer even when native iterator ignores abort', async () => {
  const guard = new LeaseGuard(90, async () => undefined, () => new Promise<string>(() => undefined))
  const keepAlive = delay(150)
  const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<NativeHarnessEvent>>(() => undefined) }) }
  await assert.rejects(async () => { for await (const _event of ownedEvents(stream, guard)) { void _event } }, { code: 'SESSION_LANE_LEASE_LOST' })
  await guard.stop(); await keepAlive
})

test('normal turn fences new turns and attach while allowing owned approval control', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId); began(); await gate; yield endEvent()
  }
  const task = (async () => { for await (const _event of owner.startTurn(session, { clientCorrelationId: 'normal', prompt: '' })) { void _event } })()
  await started
  const other = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  await assert.rejects(other.attachSession(session, {} as NativeSessionStart), { code: 'SESSION_LANE_BUSY' })
  await owner.respond(session, 'exact-request', interaction.responseOptions[0]!)
  assert.equal(f.counts().responded, 1)
  assert.equal(f.counts().attached, 0)
  finish(); await task
})

test('Stop can acquire cancellation after the streaming owner aborts without faking idle', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  const stop = new AbortController()
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  f.manager.startTurn = async function* (_session, input, signal) {
    yield startEvent(input.clientCorrelationId); began()
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
  }
  const task = (async () => { for await (const _event of owner.startTurn(session, { clientCorrelationId: 'normal', prompt: '' }, stop.signal)) { void _event } })()
  const result = task.catch(() => undefined)
  await started; stop.abort()
  assert.equal(await owner.cancel(session), true)
  await result
  assert.equal(f.counts().canceled, 1)
})

test('query echo, old result and unrelated terminal ID are not review completion', () => {
  const result = reviewTurnEvidence(session, {
    ...history([event('thread.reconciled', { correlationId: 'review', thread: { id: session.nativeSessionId, turns: [{ id: 'old', status: 'completed' }] } }),
      event('turn/completed', { turnId: 'old' })]), terminalResult: { outcome: 'succeeded' },
  }, 'review')
  assert.equal(result.acknowledged, false)
  assert.equal(result.terminal, false)
})

test('recovery correlates Codex persisted client message ID, not the query echo', () => {
  const result = reviewTurnEvidence(session, history([event('thread.reconciled', {
    correlationId: 'query-only', thread: { id: session.nativeSessionId, status: 'idle',
      turns: [{ id: 'exact', clientUserMessageId: 'review', status: 'completed' }] },
  })]), 'review')
  assert.equal(result.terminal, true)
  assert.equal(result.providerId, 'exact')
})

test('OpenCode completion requires the exact parent message and terminal evidence', () => {
  const reference: NativeSessionReference = { harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'oc-session' }
  const messageId = `msg_${createHash('sha256').update('review').digest('hex').slice(0, 24)}`
  const update = (parentID: string) => event('message.updated', { info: { id: 'assistant', sessionID: reference.nativeSessionId,
    role: 'assistant', parentID, time: { completed: 1 }, finish: 'stop' } })
  assert.equal(reviewTurnEvidence(reference, history([update('wrong'), event('session.idle')]), 'review').terminal, false)
  assert.equal(reviewTurnEvidence(reference, history([update(messageId)]), 'review').terminal, true)
})


test('failed reattachment cannot turn timestamp-free uncertainty into fresh work', async () => {
  const f = fixture(); const job = await enqueue(f)
  f.coordination.job = { ...job, state: 'uncertain' }
  f.runtime.attachOwnedSession = async () => { throw new Error('offline') }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
  f.runtime.attachOwnedSession = async () => ({ manager: f.manager, session })
  await f.dispatcher.dispatchNext('reviewer', 'successor')
  assert.equal(f.counts().started, 0)
})

test('a definite reconciliation read failure is not a definitely rejected submission', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* () { yield* [] }
  let reads = 0
  f.manager.reconcile = async () => {
    if (++reads === 1) return idleHistory()
    throw Object.assign(new Error('history unavailable'), { certainty: 'definite' })
  }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
})


test('known native turn identity cannot be replaced by a second turn with the same correlation', () => {
  const result = reviewTurnEvidence(session, history([
    startEvent('review'), endEvent(),
    event('thread.reconciled', { thread: { id: session.nativeSessionId, turns: [
      { id: 'original-turn', clientUserMessageId: 'review', status: 'inProgress' },
      { id: 'native-turn', clientUserMessageId: 'review', status: 'completed' },
    ] } }),
  ]), 'review', 'original-turn')
  assert.equal(result.providerId, 'original-turn')
  assert.equal(result.terminal, false)
})


function queueFixture() {
  const f = fixture()
  let executions = [{ state: 'completed', id: 'reviewer-execution', agentId: 'reviewer', workflowNodeId: 'reviewer-node', nativeSessionId: session.nativeSessionId,
    agentConfigurationVersionId: 'pinned-reviewer-config', workingDirectory: '/accepted', runtimeDirectory: '/runtime' }]
  const configuration = { id: 'pinned-reviewer-config', agentId: 'reviewer', productRole: 'orchestrator', harness: { harness: 'codex' } }
  const resolvedContexts: unknown[] = []
  const runs = { get: async () => ({ id: interaction.runId, executionSemanticsVersion: 2 }),
    listExecutions: async (runId: string) => { assert.equal(runId, interaction.runId); return executions },
    getExecutionConfiguration: async () => configuration }
  const repository = { coordination: Object.assign(f.coordination.asRepository(), { workflowSession: async () => ({ session, finalized: true }) }),
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'reviewer-node' }), list: async () => [interaction] }
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator(runs as unknown as Args[0], repository as unknown as Args[1],
    {} as Args[2], { resolve: (context) => { resolvedContexts.push(context); return { manager: f.manager, processState: 'resident' } } }, 30_000)
  return { ...f, coordinator, resolvedContexts, setExecutions: (value: typeof executions) => { executions = value } }
}

test('creation recovery binds the designated Agent real durable execution and native context', async () => {
  const f = queueFixture()
  let scheduled = 0
  f.coordinator.reviewers.reconcile = async () => { scheduled++ }
  await f.coordinator.reconcileReviews((error) => { throw error })
  assert.equal(f.coordination.job?.reviewerAgentId, 'reviewer')
  assert.equal((await f.coordination.findReviewJob())?.nativeSessionId, session.nativeSessionId)
  assert.equal(f.coordination.context.executionId, 'reviewer-execution')
  assert.equal(f.coordination.context.workingDirectory, '/accepted')
  assert.equal(f.coordination.context.providerVersion, session.providerVersion)
  assert.equal(f.counts().started, 0)
  assert.equal(scheduled, 1)
})

test('queue recovery reuses an existing durable job without rebinding to a later execution', async () => {
  const f = queueFixture()
  await f.coordinator.enqueueReview(interaction)
  const first = clone(f.coordination.job)
  f.setExecutions([{ state: 'completed', id: 'replacement', agentId: 'reviewer', workflowNodeId: 'review-node', nativeSessionId: 'replacement-session',
    agentConfigurationVersionId: 'replacement-config', workingDirectory: '/different', runtimeDirectory: '/runtime' }])
  await f.coordinator.enqueueReview(interaction)
  assert.deepEqual(f.coordination.job, first)
  assert.equal(f.resolvedContexts.length, 0)
})

test('a missing designated session is deferred, never replaced with the requester session', async () => {
  const f = queueFixture()
  f.setExecutions([])
  await f.coordinator.enqueueReview(interaction)
  assert.equal(f.coordination.job, undefined)
  assert.equal(f.resolvedContexts.length, 0)
  assert.equal(f.counts().started, 0)
})

test('durable session attach rejects an identity different from its saved execution', async () => {
  const f = fixture()
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator({ getExecution: async () => ({
    id: 'reviewer-execution', agentId: 'reviewer', nativeSessionId: 'saved-native', workingDirectory: '/accepted', runtimeDirectory: '/runtime',
  }) } as unknown as Args[0], { coordination: f.coordination.asRepository() } as Args[1], {} as Args[2], {} as Args[3], 30_000)
  await assert.rejects(coordinator.attachOwnedSession({ harness: 'codex', executionId: 'reviewer-execution', agentId: 'reviewer', workingDirectory: '/accepted' }, session),
    /ownership context does not match/)
  assert.equal(f.counts().attached, 0)
})


test('fresh native idle status refreshes a lane without falsely completing the review', () => {
  const reference: NativeSessionReference = { harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'oc-session' }
  const result = reviewTurnEvidence(reference, history([event('session.idle', { sessionID: reference.nativeSessionId })]), 'review')
  assert.equal(result.nativeIdle, true)
  assert.equal(result.terminal, false)
  assert.equal(result.acknowledged, false)
  const busy = reviewTurnEvidence(reference, history([event('session.idle'), event('session.status', { status: { type: 'busy' } })]), 'review')
  assert.equal(busy.nativeBusy, true)
  assert.equal(busy.nativeIdle, false)
})


test('a definite SSE failure after an unknown send is not a rejected prompt', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => {
    throw Object.assign(new Error('SSE reconnect rejected'), { certainty: 'definite', result: { error: { code: 'OPENCODE_SSE_UNAVAILABLE' } } })
  } }) })
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
})


test('does not admit a reviewer in the gap between native turn completion and durable workflow finalization', async () => {
  const f = queueFixture()
  f.coordination.asRepository().workflowSession = async () => ({ session, finalized: false, reviewerActive: false })
  await f.coordinator.enqueueReview(interaction)
  assert.equal(f.coordination.job, undefined)
  assert.equal(f.resolvedContexts.length, 0)
  f.coordination.asRepository().workflowSession = async () => ({ session, finalized: true, reviewerActive: false })
  await f.coordinator.enqueueReview(interaction)
  assert.equal((await f.coordination.findReviewJob())?.nativeSessionId, session.nativeSessionId)
})

test('failed reviewer discovery never allocates or qualifies a provider process', async () => {
  const f = queueFixture()
  f.coordination.ensureReviewJob = async () => { throw new Error('job insert failed') }
  await assert.rejects(f.coordinator.enqueueReview(interaction), /job insert failed/)
  assert.equal(f.resolvedContexts.length, 0)
  assert.deepEqual(f.coordinator.residentRunIds(), [])
  assert.equal(f.counts().started, 0)
})
