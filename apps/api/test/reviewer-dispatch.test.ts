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
  readonly nativeEvents: NativeHarnessEvent[] = []

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
    if (!this.job || ['completed', 'failed'].includes(this.job.state)
      || (this.job.leaseExpiresAt && Date.parse(this.job.leaseExpiresAt) > Date.now())) return undefined
    return clone(this.job)
  }
  async reviewJobAgents() { return await this.nextReviewJob() ? ['reviewer'] : [] }
  async isReviewPending() { return this.pending }
  async claimReviewJob(_id: string, owner: string, token: string, expires: string) {
    const current = await this.nextReviewJob()
    // Recheck after the await, just as the SQL update holds the row lock.
    if (!current || (this.job?.leaseExpiresAt && Date.parse(this.job.leaseExpiresAt) > Date.now())) {
      throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'owned', 409)
    }
    this.job = { ...current, state: ['submitted', 'acknowledged', 'uncertain'].includes(current.state) ? current.state : 'leased',
      attempt: current.attempt + 1, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expires }
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
    providerTurnOrMessageId?: string; writerFence?: WriterFence; releaseLease?: boolean; error?: ReviewJob['error']
  } = {}) {
    await this.assertReviewJobLease(id, token)
    if (fields.writerFence) await this.assertLaneLease(fields.writerFence.id, fields.writerFence.token)
    this.transitions.push(state)
    this.job = { ...this.job!, state, updatedAt: new Date().toISOString(),
      ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
      ...(fields.error ? { error: fields.error } : {}) }
    if (state === 'submitted') this.job.submittedAt = new Date().toISOString()
    if (state === 'acknowledged') this.job.acknowledgedAt = new Date().toISOString()
    if (state === 'completed') this.job.completedAt = new Date().toISOString()
    if (fields.releaseLease || ['completed', 'failed', 'uncertain', 'blocked_busy', 'blocked_disconnected'].includes(state)) {
      delete this.job.leaseOwner; delete this.job.leaseToken; delete this.job.leaseExpiresAt
    }
    return clone(this.job)
  }
  async ensureLane(lane: NativeSessionLane) {
    if (lane.ownerAgentId !== this.lane.ownerAgentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'wrong owner', 409)
    return clone(this.lane)
  }
  async claimLane(_id: string, revision: number, owner: string, token: string, expires: string, correlationId: string) {
    if (revision !== this.lane.revision || (this.lane.leaseExpiresAt && Date.parse(this.lane.leaseExpiresAt) > Date.now())) {
      throw new DomainError('SESSION_LANE_BUSY', 'busy', 409)
    }
    this.lane = { ...this.lane, revision: revision + 1, leaseOwner: owner, leaseToken: token,
      leaseExpiresAt: expires, correlationId, observedStatus: 'busy' }
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
    if (observed.observedStatus === 'idle') delete this.lane.correlationId
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
      started++; yield startEvent(input.clientCorrelationId); yield endEvent()
    },
    reconcile: async () => { reconciled++; return idleHistory() },
    pending: async () => undefined,
    history: async () => history(),
    respond: async () => { responded++ },
    cancel: async () => { canceled++; return true },
    close: async () => undefined,
  } as unknown as NativeHarnessSessionManager
  const runtime = { attachInteraction: async () => ({ manager, session }), attachOwnedSession: async () => ({ manager, session }) }
  const dispatcher = new ReviewerDispatcher(coordination.asRepository(), runtime, ms)
  return { coordination, manager, runtime, dispatcher, counts: () => ({ started, attached, reconciled, canceled, responded }) }
}
async function enqueue(f: ReturnType<typeof fixture>) {
  return f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
}

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
    await delay(400); yield endEvent()
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
  let executions = [{ state: 'completed', id: 'reviewer-execution', agentId: 'reviewer', nativeSessionId: session.nativeSessionId,
    agentConfigurationVersionId: 'pinned-reviewer-config', workingDirectory: '/accepted', runtimeDirectory: '/runtime' }]
  const configuration = { id: 'pinned-reviewer-config', agentId: 'reviewer', productRole: 'orchestrator', harness: { harness: 'codex' } }
  const resolvedContexts: unknown[] = []
  const runs = { listExecutions: async (runId: string) => { assert.equal(runId, interaction.runId); return executions },
    getExecutionConfiguration: async () => configuration }
  const repository = { coordination: Object.assign(f.coordination.asRepository(), { workflowSession: async () => ({ session, finalized: true }) }), list: async () => [interaction] }
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
  f.setExecutions([{ state: 'completed', id: 'replacement', agentId: 'reviewer', nativeSessionId: 'replacement-session',
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
