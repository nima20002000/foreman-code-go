import { randomUUID } from 'node:crypto'

import type { NativeHarnessEvent, NativeSessionLane, NativeSessionReference } from '@graphql/contracts'

import { DomainError } from '../errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import { PostgresInteractionCoordinationRepository, type WriterFence } from './coordination.js'
import { definitelyRejected, reviewTurnEvidence } from './reviewerEvidence.js'

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

  async wait<T>(work: Promise<T>): Promise<T> {
    let abort: (() => void) | undefined
    return Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(this.signal.reason)
      this.signal.addEventListener('abort', abort, { once: true })
      if (this.signal.aborted) abort()
    })]).finally(() => { if (abort) this.signal.removeEventListener('abort', abort) })
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    if (this.deadline) clearTimeout(this.deadline)
  }
}

/** Stop requesting events as soon as ownership expires, even if the iterator ignores abort. */
export async function* ownedEvents(events: AsyncIterable<NativeHarnessEvent>, guard: LeaseGuard): AsyncIterable<NativeHarnessEvent> {
  const iterator = events[Symbol.asyncIterator]()
  try {
    while (true) {
      await guard.check()
      let abort: (() => void) | undefined
      const next = await Promise.race([
        Promise.resolve().then(() => { guard.signal.throwIfAborted(); return iterator.next() }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(guard.signal.reason)
          guard.signal.addEventListener('abort', abort, { once: true })
          if (guard.signal.aborted) abort()
        }),
      ]).finally(() => { if (abort) guard.signal.removeEventListener('abort', abort) })
      await guard.check()
      if (next.done) return
      yield next.value
    }
  } finally {
    const closed = Promise.resolve(iterator.return?.())
    if (guard.signal.aborted) void closed.catch(() => undefined)
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
    correlationId: string, lease: SessionWriteLease): Promise<void> {
    const previous = lease.previous
    await lease.guard.check()
    lease.observedStatus = 'disconnected'
    const history = await lease.guard.wait(manager.reconcile(session, previous.correlationId ?? correlationId, lease.guard.signal))
    await lease.guard.check()
    const evidence = reviewTurnEvidence(session, history, previous.correlationId ?? correlationId, previous.currentTurnOrMessageId)
    if (history.pendingInteractions.length || evidence.nativeBusy
      || (previous.observedStatus !== 'idle' && !evidence.nativeIdle)) {
      lease.observedStatus = evidence.nativeBusy ? 'busy' : 'uncertain'
      throw new DomainError('SESSION_LANE_BUSY', 'The native session has active or unreconciled work.', 409)
    }
    lease.observedStatus = 'idle'
  }

  private observe(session: NativeSessionReference, history: NativeHistory, correlationId: string, lease: SessionWriteLease): void {
    const evidence = reviewTurnEvidence(session, history, correlationId, lease.providerId)
    if (evidence.providerId) lease.providerId = evidence.providerId
    lease.observedStatus = evidence.terminal && !evidence.nativeBusy ? 'idle'
      : evidence.acknowledged || history.pendingInteractions.length ? 'busy' : 'uncertain'
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const lease = await this.acquire(session, input.clientCorrelationId, signal)
    const events: NativeHarnessEvent[] = []
    let submitted = false
    try {
      await this.requireIdle(this.manager, session, input.clientCorrelationId, lease)
      await this.coordination.bindLaneTurn(lease.fence, input.clientCorrelationId)
      lease.observedStatus = 'uncertain'
      delete lease.providerId
      this.active.set(session.nativeSessionId, lease)
      await lease.guard.check()
      submitted = true
      for await (const event of ownedEvents(this.manager.startTurn(session, input, lease.guard.signal), lease.guard)) {
        await lease.guard.check()
        events.push(event)
        this.observe(session, { events, pendingInteractions: [] }, input.clientCorrelationId, lease)
        yield event
      }
      await lease.guard.check()
      const history = await lease.guard.wait(this.manager.reconcile(session, input.clientCorrelationId, lease.guard.signal))
      await lease.guard.check()
      this.observe(session, { ...history, events: [...events, ...history.events] }, input.clientCorrelationId, lease)
    } catch (error) {
      if (submitted && !isLeaseLost(error)) {
        lease.observedStatus = definitelyRejected(error) && events.length === 0 ? 'idle' : 'uncertain'
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
          const history = await lease.guard.wait(this.manager.reconcile(session, lease.previous.correlationId, lease.guard.signal))
          this.observe(session, history, lease.previous.correlationId, lease)
        }
        return result
      })
    })
    this.controlTail = work
    return work
  }

  respond: NativeHarnessSessionManager['respond'] = (session, requestId, option, signal) =>
    this.control(session, signal, (ownedSignal) => this.manager.respond(session, requestId, option, ownedSignal))
  cancel: NativeHarnessSessionManager['cancel'] = (session, signal) =>
    this.control(session, signal, (ownedSignal) => this.manager.cancel(session, ownedSignal), true)

  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    return this.withLane(session, `attach-${randomUUID()}`, signal, async (manager, lease) => {
      lease.operation = 'attach'
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
