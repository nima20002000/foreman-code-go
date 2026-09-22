import { randomUUID } from 'node:crypto'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import type { NativeHarnessEvent, NativeSessionLane, NativeSessionReference } from '@graphql/contracts'

import { DomainError } from '../errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import { PostgresInteractionCoordinationRepository, type WriterFence } from './coordination.js'
import { definitelyRejected, ReviewEvidenceTracker, reviewTurnEvidence, type TurnEvidence } from './reviewerEvidence.js'

/** Heartbeats start before any potentially long native await. Loss aborts the writer, never retries it. */
export class LeaseGuard {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setInterval>
  private stopped = false
  private renewal: Promise<void> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  readonly signal: AbortSignal

  constructor(
    leaseMs: number,
    private readonly assertOwned: () => Promise<void>,
    renew: () => Promise<string>,
    signal?: AbortSignal,
    expiresAt = new Date(Date.now() + leaseMs).toISOString(),
    private readonly lostCode = 'SESSION_LANE_LEASE_LOST',
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 3) throw new RangeError('leaseMs must be an integer of at least 3 milliseconds.')
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    const armDeadline = (expiry: string) => {
      if (this.deadline) clearTimeout(this.deadline)
      this.deadline = setTimeout(() => this.controller.abort(
        new DomainError(lostCode, 'The lease expired without a confirmed renewal.', 409),
      ), Math.max(0, Date.parse(expiry) - Date.now()))
      this.deadline.unref()
    }
    armDeadline(expiresAt)
    this.timer = setInterval(() => {
      if (this.stopped || this.renewal || this.signal.aborted) return
      this.renewal = Promise.resolve().then(renew).then((expiry) => { if (!this.stopped && !this.signal.aborted) armDeadline(expiry) }).catch(() => { if (!this.stopped) this.controller.abort(new DomainError(lostCode, 'The lease could not be renewed.', 409)) })
        .finally(() => { this.renewal = undefined })
    }, Math.max(1, Math.floor(leaseMs / 3)))
    this.timer.unref()
  }

  async check(): Promise<void> {
    this.signal.throwIfAborted()
    try { await this.assertOwned() } catch {
      const error = new DomainError(this.lostCode, 'The lease could not be confirmed.', 409)
      this.controller.abort(error)
      throw error
    }
    this.signal.throwIfAborted()
  }

  async wait<T>(work: Promise<T>, signal: AbortSignal = this.signal): Promise<T> {
    const ownedSignal = signal === this.signal ? signal : AbortSignal.any([this.signal, signal])
    let abort: (() => void) | undefined
    return Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(ownedSignal.reason)
      ownedSignal.addEventListener('abort', abort, { once: true })
      if (ownedSignal.aborted) abort()
    })]).finally(() => { if (abort) ownedSignal.removeEventListener('abort', abort) })
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    if (this.deadline) clearTimeout(this.deadline)
  }
}

/** Stop requesting events as soon as ownership expires, even if the iterator ignores abort. */
export async function* ownedEvents(events: AsyncIterable<NativeHarnessEvent>, guard: LeaseGuard, signal: AbortSignal = guard.signal): AsyncIterable<NativeHarnessEvent> {
  const ownedSignal = signal === guard.signal ? signal : AbortSignal.any([guard.signal, signal])
  const iterator = events[Symbol.asyncIterator]()
  let count = 0
  try {
    while (true) {
      // An immediately resolved iterator must not starve lease/Stop timers.
      if (count > 0 && count % 256 === 0) {
        try { await yieldToEventLoop(undefined, { signal: ownedSignal }) }
        catch (error) { ownedSignal.throwIfAborted(); throw error }
      }
      await guard.check()
      let abort: (() => void) | undefined
      const next = await Promise.race([
        Promise.resolve().then(() => { ownedSignal.throwIfAborted(); return iterator.next() }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(ownedSignal.reason)
          ownedSignal.addEventListener('abort', abort, { once: true })
          if (ownedSignal.aborted) abort()
        }),
      ]).finally(() => { if (abort) ownedSignal.removeEventListener('abort', abort) })
      await guard.check()
      ownedSignal.throwIfAborted()
      if (next.done) return
      count += 1
      yield next.value
    }
  } finally {
    const closed = Promise.resolve(iterator.return?.())
    if (ownedSignal.aborted) void closed.catch(() => undefined)
    else await closed
  }
}

export interface SessionWriteLease {
  fence: WriterFence
  guard: LeaseGuard
  previous: NativeSessionLane
  observedStatus: NativeSessionLane['observedStatus']
  providerId?: string
  operation?: 'attach'
  finished: Promise<void>
  finish(): void
}

export function isLeaseLost(error: unknown): boolean {
  return error instanceof DomainError && (error.code === 'SESSION_LANE_LEASE_LOST' || error.code === 'REVIEW_JOB_LEASE_LOST')
}

/** One boundary for workflow turns, reviewer turns, approvals, cancellation and attach/close. */
export class SingleWriterSessionManager implements NativeHarnessSessionManager {
  readonly harness: NativeHarnessSessionManager['harness']
  private readonly active = new Map<string, SessionWriteLease>()
  private controlTail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly manager: NativeHarnessSessionManager,
    private readonly coordination: PostgresInteractionCoordinationRepository,
    readonly agentId: string,
    private readonly leaseMs = 30_000,
  ) { this.harness = manager.harness }

  capabilities: NativeHarnessSessionManager['capabilities'] = (signal) => this.manager.capabilities(signal)
  inspectMcp: NativeHarnessSessionManager['inspectMcp'] = (signal) => this.manager.inspectMcp(signal)
  pending: NativeHarnessSessionManager['pending'] = (session, signal) => this.manager.pending(session, signal)
  history: NativeHarnessSessionManager['history'] = (session, signal) => this.manager.history(session, signal)
  reconcile: NativeHarnessSessionManager['reconcile'] = (session, correlation, signal) => this.manager.reconcile(session, correlation, signal)
  reconcileResponse: NonNullable<NativeHarnessSessionManager['reconcileResponse']> = (session, response, signal) =>
    this.manager.reconcileResponse ? this.manager.reconcileResponse(session, response, signal) : this.manager.history(session, signal)

  isActive(session: NativeSessionReference): boolean {
    return this.active.has(session.nativeSessionId)
  }

  /** A current callback may present this exact native-writer lease to its
   * persisted graph producer. History outside the lease cannot mint authority. */
  currentProjectionLease(session: NativeSessionReference) {
    const lease = this.active.get(session.nativeSessionId)
    return lease && !lease.guard.signal.aborted
      ? { id: lease.fence.id, token: lease.fence.token, ...(lease.providerId ? { providerId: lease.providerId } : {}), live: true as const }
      : undefined
  }

  private ensure(session: NativeSessionReference, status: NativeSessionLane['observedStatus']) {
    return this.coordination.ensureLane({
      id: `lane-${randomUUID()}`, harness: session.harness, nativeSessionId: session.nativeSessionId,
      ownerAgentId: this.agentId, observedStatus: status, connectionGeneration: 0,
      observedAt: new Date().toISOString(), revision: 0,
    })
  }

  async createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const session = await this.manager.createSession(input, signal)
    await this.ensure(session, 'idle')
    return session
  }

  async acquire(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<SessionWriteLease> {
    signal?.throwIfAborted()
    const previous = await this.ensure(session, 'uncertain')
    const token = `writer-${randomUUID()}`
    // Preserve the unresolved turn correlation through attach/control operations and failed preflight.
    const lane = await this.coordination.claimLane(previous.id, previous.revision, this.agentId, token,
      new Date(Date.now() + this.leaseMs).toISOString(), previous.correlationId ?? correlationId)
    const guard = new LeaseGuard(this.leaseMs,
      () => this.coordination.assertLaneLease(lane.id, token),
      () => this.coordination.renewLane(lane.id, token, this.leaseMs), signal, lane.leaseExpiresAt)
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    return {
      finished, finish,
      fence: { id: lane.id, token }, guard, previous,
      observedStatus: previous.observedStatus,
      ...(previous.currentTurnOrMessageId ? { providerId: previous.currentTurnOrMessageId } : {}),
    }
  }

  private async release(lease: SessionWriteLease): Promise<void> {
    await lease.guard.stop()
    try {
      if (isLeaseLost(lease.guard.signal.reason)) return
      await this.coordination.releaseLane(lease.fence.id, lease.fence.token, {
        observedStatus: lease.guard.signal.aborted ? 'uncertain' : lease.observedStatus,
        ...(lease.providerId ? { currentTurnOrMessageId: lease.providerId } : {}),
      })
    } finally { lease.finish() }
  }

  async withLane<T>(session: NativeSessionReference, correlationId: string, signal: AbortSignal | undefined,
    work: (manager: NativeHarnessSessionManager, lease: SessionWriteLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(session, correlationId, signal)
    try {
      await lease.guard.check()
      this.active.set(session.nativeSessionId, lease)
      return await work(this.manager, lease)
    } finally {
      if (this.active.get(session.nativeSessionId) === lease) this.active.delete(session.nativeSessionId)
      // A stale owner must not overwrite the successor's observations, including in cleanup.
      await this.release(lease)
    }
  }

  async requireIdle(manager: NativeHarnessSessionManager, session: NativeSessionReference,
    correlationId: string, lease: SessionWriteLease, signal: AbortSignal = lease.guard.signal,
    preflightCorrelationId?: string): Promise<void> {
    const previous = lease.previous
    await lease.guard.check()
    signal.throwIfAborted()
    if (previous.observedStatus === 'idle' && !previous.correlationId && !previous.currentTurnOrMessageId) {
      lease.observedStatus = 'idle'
      return
    }
    lease.observedStatus = 'disconnected'
    // An unresolved native identity is an inseparable correlation/provider pair.
    // Only an unbound lane may fall back to the completed workflow correlation.
    const identity = reviewPreflightIdentity(previous, preflightCorrelationId ?? correlationId)
    const history = await lease.guard.wait(manager.reconcile(session, identity.correlationId, signal), signal)
    await lease.guard.check()
    signal.throwIfAborted()
    // Idle lanes clear their correlation but can retain the last provider ID.
    // That finished identity must not be bound to the NEXT review's correlation.
    // This preflight observes availability only; it never completes the new turn.
    const evidence = reviewTurnEvidence(session, history, identity.correlationId, identity.nativeTurnId)
    if (history.pendingInteraction || history.pendingInteractions.length || evidence.nativeBusy || evidence.identityConflict
      || (previous.observedStatus !== 'idle' && !evidence.nativeIdle)) {
      lease.observedStatus = evidence.nativeBusy ? 'busy' : 'uncertain'
      throw new DomainError('SESSION_LANE_BUSY', 'The native session has active or unreconciled work.', 409)
    }
    lease.observedStatus = 'idle'
  }

  private observe(session: NativeSessionReference, history: NativeHistory, correlationId: string, lease: SessionWriteLease): void {
    const evidence = reviewTurnEvidence(session, history, correlationId, lease.providerId)
    this.observeEvidence(evidence, lease)
  }

  private observeEvidence(evidence: TurnEvidence, lease: SessionWriteLease): void {
    if (evidence.providerId) lease.providerId = evidence.providerId
    lease.observedStatus = evidence.identityConflict ? 'uncertain' : evidence.terminal ? 'idle'
      : evidence.acknowledged || evidence.nativeBusy ? 'busy' : 'uncertain'
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const lease = await this.acquire(session, input.clientCorrelationId, signal)
    const evidence = new ReviewEvidenceTracker(session, input.clientCorrelationId)
    let submitted = false
    try {
      await this.requireIdle(this.manager, session, input.clientCorrelationId, lease)
      await this.coordination.bindLaneTurn(lease.fence, input.clientCorrelationId)
      lease.observedStatus = 'uncertain'
      delete lease.providerId
      this.active.set(session.nativeSessionId, lease)
      await lease.guard.check()
      submitted = true
      for await (const event of ownedEvents(this.manager.startTurn(session, {
        ...input,
        onSubmitted: async (providerId) => {
          await lease.guard.check()
          evidence.acknowledge(providerId)
          if (evidence.snapshot().identityConflict) throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT',
            'The provider returned conflicting turn identities. Native work will not be replayed.', 409)
          lease.providerId = providerId
          await input.onSubmitted?.(providerId)
          await lease.guard.check()
        },
      }, lease.guard.signal), lease.guard)) {
        await lease.guard.check()
        evidence.observeEvent(event)
        this.observeEvidence(evidence.snapshot(), lease)
        yield event
      }
      await lease.guard.check()
      const history = await lease.guard.wait(this.manager.reconcile(session, input.clientCorrelationId, lease.guard.signal))
      await lease.guard.check()
      evidence.observeHistory(history)
      this.observeEvidence(evidence.snapshot(), lease)
    } catch (error) {
      if (submitted && !isLeaseLost(error)) {
        lease.observedStatus = definitelyRejected(error) && evidence.processedEvents === 0 && !evidence.snapshot().acknowledged ? 'idle' : 'uncertain'
      }
      throw error
    } finally {
      if (this.active.get(session.nativeSessionId) === lease) this.active.delete(session.nativeSessionId)
      await this.release(lease)
    }
  }

  private control<T>(session: NativeSessionReference, signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>, cleanup = false): Promise<T> {
    const work = this.controlTail.catch(() => undefined).then(async () => {
      let active = this.active.get(session.nativeSessionId)
      if (cleanup && active?.operation === 'attach' && active.guard.signal.aborted
        && !isLeaseLost(active.guard.signal.reason)) {
        // The attachment still owns this lane. Stop may close its transport
        // before that attachment returns, but may not use a successor's lane.
        await this.coordination.assertLaneLease(active.fence.id, active.fence.token)
        const cleanupSignal = signal ?? AbortSignal.timeout(this.leaseMs)
        cleanupSignal.throwIfAborted()
        const result = await waitForSignal(action(cleanupSignal), cleanupSignal)
        await this.coordination.assertLaneLease(active.fence.id, active.fence.token)
        return result
      }
      if (active?.guard.signal.aborted && !isLeaseLost(active.guard.signal.reason)) {
        // Stop hands the lane back before issuing its separately fenced native cancellation.
        await active.finished
        active = this.active.get(session.nativeSessionId)
      }
      if (active) {
        await active.guard.check()
        signal?.throwIfAborted()
        const ownedSignal = signal ? AbortSignal.any([signal, active.guard.signal]) : active.guard.signal
        const result = await waitForSignal(action(ownedSignal), ownedSignal)
        await active.guard.check()
        return result
      }
      return this.withLane(session, `control-${randomUUID()}`, signal, async (_manager, lease) => {
        lease.observedStatus = 'uncertain'
        await lease.guard.check()
        const result = await lease.guard.wait(action(lease.guard.signal))
        await lease.guard.check()
        if (lease.previous.correlationId) {
          try {
            const history = await lease.guard.wait(this.manager.reconcile(session, lease.previous.correlationId, lease.guard.signal))
            this.observe(session, history, lease.previous.correlationId, lease)
          } catch {
            // The native action was acknowledged. A failed observation cannot
            // erase that receipt, but lost ownership still fails closed.
            lease.observedStatus = 'uncertain'
          }
          await lease.guard.check()
        }
        return result
      })
    })
    this.controlTail = work
    return work
  }

  /** Recheck a committed approval claim AFTER the control queue and native lane
   * are acquired, immediately before dispatch. The check is SQL-only and must
   * release its transaction before it returns; the native wait owns no Run lock. */
  respondQualified(session: NativeSessionReference, requestId: string,
    option: Parameters<NativeHarnessSessionManager['respond']>[2],
    beforeDispatch: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal) {
    return this.control(session, signal, async (ownedSignal) => {
      await beforeDispatch(ownedSignal)
      ownedSignal.throwIfAborted()
      return this.manager.respond(session, requestId, option, ownedSignal)
    })
  }

  respond: NativeHarnessSessionManager['respond'] = (session, requestId, option, signal) =>
    this.control(session, signal, (ownedSignal) => this.manager.respond(session, requestId, option, ownedSignal))
  cancel: NativeHarnessSessionManager['cancel'] = (session, signal, nativeTurnId) =>
    this.control(session, signal, (ownedSignal) => this.manager.cancel(session, ownedSignal, nativeTurnId), true)

  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    return this.withLane(session, `attach-${randomUUID()}`, signal, async (manager, lease) => {
      lease.operation = 'attach'
      // Control/close/attach lane leases are local operations, not a native
      // turn identity to fence a later recovery attachment against.
      if (input.correlationId && lease.previous.correlationId
        && !/^(?:control|close|attach)-/.test(lease.previous.correlationId)
        && (input.correlationId !== lease.previous.correlationId
          || (input.nativeTurnId && lease.previous.currentTurnOrMessageId
            && input.nativeTurnId !== lease.previous.currentTurnOrMessageId))) {
        throw new DomainError('SESSION_LANE_BUSY', 'The native lane identity changed before attachment. Recheck its saved identity pair.', 409)
      }
      // Preserve the actual attach lifetime so Stop can observe a late native
      // connection. A local abort is not evidence that the provider stopped.
      const attached = await manager.attachSession(session, input, lease.guard.signal)
      if (!lease.guard.signal.aborted) await lease.guard.check()
      if (attached.nativeSessionId !== session.nativeSessionId || attached.harness !== session.harness
        || attached.providerVersion !== session.providerVersion) throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The native manager returned a different session identity.', 409)
      return attached
    })
  }

  async close(session: NativeSessionReference): Promise<void> {
    let active = this.active.get(session.nativeSessionId)
    if (active?.operation === 'attach' && active.guard.signal.aborted && !isLeaseLost(active.guard.signal.reason)) {
      await this.coordination.assertLaneLease(active.fence.id, active.fence.token)
      active.observedStatus = 'disconnected'
      return this.manager.close(session)
    }
    if (active?.guard.signal.aborted && !isLeaseLost(active.guard.signal.reason)) {
      await active.finished
      active = this.active.get(session.nativeSessionId)
    }
    if (active) {
      await active.guard.check()
      active.observedStatus = 'disconnected'
      return this.manager.close(session)
    }
    return this.withLane(session, `close-${randomUUID()}`, undefined, async (manager, lease) => {
      lease.observedStatus = lease.previous.observedStatus === 'idle' ? 'idle' : 'disconnected'
      await manager.close(session)
    })
  }
}

async function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

export function coordinateSessionManager(manager: NativeHarnessSessionManager,
  coordination: PostgresInteractionCoordinationRepository, agentId: string, leaseMs = 30_000): SingleWriterSessionManager {
  if (manager instanceof SingleWriterSessionManager) {
    if (manager.agentId !== agentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'A native writer belongs to another Agent.', 409)
    return manager
  }
  return new SingleWriterSessionManager(manager, coordination, agentId, leaseMs)
}
