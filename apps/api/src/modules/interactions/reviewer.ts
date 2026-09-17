import { randomUUID } from 'node:crypto'

import { ReviewJobSchema, type DurableInteraction, type PendingNativeInteraction, type NativeSessionReference, type ReviewJob } from '@graphql/contracts'

import { DomainError } from '../errors.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import type { ReviewCredentialMaintenance, ReviewerNativeRuntime } from './reviewerRuntime.js'
import { PostgresInteractionCoordinationRepository } from './coordination.js'
import { definitelyRejected, ReviewEvidenceTracker } from './reviewerEvidence.js'
import type { NativeManagerResolutionContext } from './runtimePorts.js'
import { coordinateSessionManager, isLeaseLost, LeaseGuard, ownedEvents } from './sessionWriter.js'

export class ReviewerDispatcher {
  private readonly workerId = `review-worker-${randomUUID()}`
  private readonly stopping = new AbortController()
  private readonly active = new Map<string, Promise<unknown>>()
  private shutdownTask: Promise<void> | undefined

  constructor(
    private readonly coordination: PostgresInteractionCoordinationRepository,
    private readonly nativeRuntime: ReviewerNativeRuntime,
    private readonly leaseMs = 30_000,
  ) {}

  async enqueue(
    interaction: DurableInteraction,
    reviewerAgentId: string,
    session: NativeSessionReference,
    context: Pick<NativeManagerResolutionContext, 'executionId' | 'workingDirectory'>,
  ): Promise<ReviewJob> {
    if (interaction.approval.handler !== 'orchestrator'
      || interaction.approval.designatedOrchestratorAgentId !== reviewerAgentId
      || interaction.requestingAgentId === reviewerAgentId) {
      throw new DomainError('REVIEWER_ASSIGNMENT_MISMATCH', 'Only the designated Orchestrator may review this interaction.', 403)
    }
    const now = new Date().toISOString()
    const result = await this.coordination.ensureReviewJob(ReviewJobSchema.parse({
      id: `review-${randomUUID()}`, interactionId: interaction.id, reviewerAgentId,
      attempt: 0, state: 'pending', provider: session.harness, nativeSessionId: session.nativeSessionId,
      correlationId: `review-correlation-${randomUUID()}`, createdAt: now, updatedAt: now,
    }), { ...context, providerVersion: session.providerVersion })
    return result.job
  }

  /** Called by the existing startup/periodic reconciliation loop; long turns do not block it. */
  async reconcile(onError: (error: unknown) => void): Promise<void> {
    if (this.stopping.signal.aborted) return
    for (const agentId of await this.coordination.reviewJobAgents()) {
      if (this.stopping.signal.aborted) break
      if (this.active.has(agentId)) continue
      const task = this.dispatchNext(agentId, this.workerId).catch(onError)
        .finally(() => { this.active.delete(agentId) })
      this.active.set(agentId, task)
    }
  }

  shutdown(): Promise<void> {
    this.stopping.abort(new Error('Reviewer dispatcher is shutting down.'))
    this.shutdownTask ??= Promise.allSettled(this.active.values()).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Reviewer shutdown was incomplete.')
    })
    return this.shutdownTask
  }

  async dispatchNext(reviewerAgentId: string, workerId: string): Promise<ReviewJob | undefined> {
    if (this.stopping.signal.aborted) return undefined
    const available = await this.coordination.nextReviewJob(reviewerAgentId)
    if (!available) return undefined
    const jobToken = `review-lease-${randomUUID()}`
    let job: ReviewJob
    try {
      job = await this.coordination.claimReviewJob(available.id, workerId, jobToken,
        new Date(Date.now() + this.leaseMs).toISOString())
    } catch (error) {
      // Losing a queue race is not a dispatch failure and must not modify the winner.
      if (error instanceof DomainError && error.code === 'REVIEW_JOB_NOT_CLAIMABLE') return undefined
      throw error
    }
    const guard = new LeaseGuard(this.leaseMs,
      () => this.coordination.assertReviewJobLease(job.id, jobToken),
      () => this.coordination.renewReviewJob(job.id, jobToken, this.leaseMs),
      this.stopping.signal, job.leaseExpiresAt, 'REVIEW_JOB_LEASE_LOST')
    let executionId: string | undefined
    let safe = nativePersistenceRedactor([])
    const recovering = Boolean(job.submittedAt || job.acknowledgedAt || job.providerTurnOrMessageId
      || ['submitted', 'acknowledged', 'uncertain'].includes(available.state))
    try {
      const { providerVersion, ...ownerContext } = await guard.wait(this.coordination.getReviewJobContext(job.id))
      executionId = ownerContext.executionId
      await guard.check()
      if (!recovering && !await this.coordination.isReviewPending(job.interactionId, job.reviewerAgentId)) {
        return await this.coordination.transitionReviewJob(job.id, jobToken, 'failed', {
          error: { code: 'REVIEW_NO_LONGER_PENDING', message: 'The interaction no longer needs this review.' },
        })
      }
      const attached = await guard.wait(this.nativeRuntime.attachOwnedSession({
        harness: job.provider, agentId: job.reviewerAgentId, ...ownerContext, purpose: 'reviewer',
        correlationId: job.correlationId,
        ...(job.providerTurnOrMessageId ? { nativeTurnId: job.providerTurnOrMessageId } : {}),
      }, { harness: job.provider, providerVersion, nativeSessionId: job.nativeSessionId }, guard.signal))
      await guard.check()
      if (attached.session.harness !== job.provider || attached.session.nativeSessionId !== job.nativeSessionId
        || attached.session.providerVersion !== providerVersion) throw new Error('Reviewer attach changed its durable native identity.')
      safe = this.nativeRuntime.reviewPersistence?.(executionId) ?? safe
      const writer = coordinateSessionManager(attached.manager, this.coordination, job.reviewerAgentId, this.leaseMs)
      return await writer.withLane(attached.session, job.correlationId, attached.signal ? AbortSignal.any([guard.signal, attached.signal]) : guard.signal, async (manager, lane) => {
        const session = attached.session
        let submitted = recovering
        let submitting = !recovering
        let acknowledged = Boolean(job.acknowledgedAt || job.providerTurnOrMessageId)
        const tracker = new ReviewEvidenceTracker(session, job.correlationId, job.providerTurnOrMessageId)
        let maintenance: ReviewCredentialMaintenance | undefined
        let workSignal = lane.guard.signal
        const check = async () => { await guard.check(); await lane.guard.check() }
        const transition = async (state: ReviewJob['state'], fields: {
          providerTurnOrMessageId?: string; error?: ReviewJob['error']; releaseLease?: boolean
        } = {}) => {
          await check()
          job = await this.coordination.transitionReviewJob(job.id, jobToken, state, {
            ...safe.value(fields), writerFence: lane.fence,
          })
          return job
        }
        const acknowledge = async (providerId: string) => {
          await check()
          workSignal.throwIfAborted()
          tracker.acknowledge(providerId)
          if (tracker.snapshot().identityConflict) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT',
            'The review received conflicting native submission identities. It will not be replayed.', 409)
          lane.providerId = providerId
          if (!acknowledged || !job.providerTurnOrMessageId) {
            await transition('acknowledged', { providerTurnOrMessageId: providerId })
            acknowledged = true
            lane.observedStatus = 'busy'
          }
        }
        const failReview = async (failure: NonNullable<ReviewJob['error']>, pending?: PendingNativeInteraction,
          pendingRequests: readonly PendingNativeInteraction[] = pending ? [pending] : []) => {
          await maintenance?.stop()
          const evidence = tracker.snapshot()
          const exactPending = pendingRequests.every((request) => request.session.harness === session.harness
            && request.session.providerVersion === session.providerVersion && request.session.nativeSessionId === session.nativeSessionId
            && request.turn.nativeTurnId === evidence.providerId && Boolean(request.turn.nativeRequestId))
          const identity = pendingRequests.length ? ` Native requests: ${JSON.stringify(pendingRequests.map((request) => ({
            session: request.session, turn: request.turn, nativeRequestType: request.nativeRequestType,
          })))}.` : ''
          const error = safe.value({ ...failure, message: `${failure.message}${identity} Stop this Run and correct the accepted reviewer configuration before starting a new Run; do not replay this review.` })
          // Save the actionable failure BEFORE provider cleanup, retaining both leases.
          // These are existing states; a submitted turn can never become fresh work.
          await transition(submitted ? acknowledged ? 'acknowledged' : 'submitted' : 'leased', { error })
          await this.nativeRuntime.recordReviewFailure?.(executionId!, job, error, pending ? safe.value(pending) : undefined, safe.value(pendingRequests))
          await check()
          let canceled = false
          let revoked = false
          const cleanupSignal = AbortSignal.any([lane.guard.signal, AbortSignal.timeout(Math.min(this.leaseMs, 5_000))])
          if (evidence.providerId && !evidence.identityConflict && exactPending) {
            try {
              canceled = await lane.guard.wait(manager.cancel(session, cleanupSignal, evidence.providerId), cleanupSignal)
              await check()
            } catch (error) {
              if (isLeaseLost(error) || guard.signal.aborted || lane.guard.signal.aborted) throw error
            }
          }
          try {
            if (maintenance) {
              await lane.guard.wait(maintenance.invalidate(), cleanupSignal)
              revoked = true
            }
          } catch (error) {
            if (isLeaseLost(error) || guard.signal.aborted || lane.guard.signal.aborted) throw error
          }
          lane.observedStatus = canceled ? 'idle' : 'uncertain'
          return transition('failed', { error: { ...error,
            message: `${error.message} Native cancellation ${canceled ? 'confirmed' : 'unconfirmed'}; credential revocation ${revoked ? 'confirmed' : 'unconfirmed'}.`,
          } })
        }
        const approvalFailure = (pending: PendingNativeInteraction, requests?: readonly PendingNativeInteraction[]) => failReview({
          code: 'REVIEWER_NATIVE_APPROVAL_UNSUPPORTED',
          message: 'The designated Orchestrator requested native approval during its review. The accepted workflow has no distinct authority for that request. No approval was sent and the handler was not changed.',
        }, pending, requests)
        try {
          maintenance = await lane.guard.wait(this.nativeRuntime.maintainReviewCredential?.(
            executionId!, session, lane.guard.signal, check,
          ) ?? Promise.resolve(undefined))
          workSignal = maintenance?.signal ?? lane.guard.signal
          await check()
          workSignal.throwIfAborted()
          if (!recovering) {
            if (!await this.coordination.isReviewPending(job.interactionId, job.reviewerAgentId)) {
              await maintenance?.stop()
              return await transition('failed', { error: { code: 'REVIEW_NO_LONGER_PENDING', message: 'The interaction no longer needs this review.' } })
            }
            // Refresh native evidence while exclusively owned; never bounce a cached lane status.
            await writer.requireIdle(manager, session, job.correlationId, lane, workSignal)
            await check()
            workSignal.throwIfAborted()
            await this.coordination.bindLaneTurn(lane.fence, job.correlationId)
            delete lane.providerId
            await transition('submitted')
            submitted = true
            lane.observedStatus = 'uncertain'
            await check()
            workSignal.throwIfAborted()
            for await (const event of ownedEvents(manager.startTurn(session, {
              clientCorrelationId: job.correlationId,
              prompt: `Review pending interaction ${job.interactionId}. Inspect it through App MCP and respond only if authorized.`,
              onSubmitted: acknowledge,
            }, workSignal), lane.guard, workSignal)) {
              await check()
              tracker.observeEvent(event)
              await this.coordination.appendReviewNativeEvent(job, safe.value(event))
              const evidence = tracker.snapshot()
              if (evidence.identityConflict) return await failReview({ code: 'REVIEW_JOB_IDENTITY_CONFLICT',
                message: 'The review has conflicting native identities. No further native response will be sent.' })
              if (evidence.providerId && evidence.acknowledged) await acknowledge(evidence.providerId)
              // pending() is the provider's current request, not a transcript scan.
              // Inspect while consuming the stream: an approval can block its next event forever.
              const pending = await lane.guard.wait(manager.pending(session, workSignal), workSignal)
              await check()
              if (pending) return await approvalFailure(pending)
            }
          }
          submitting = false
          // Submitted/unknown work is observation-only. Missing evidence is not permission to resend.
          await check()
          workSignal.throwIfAborted()
          const history = await lane.guard.wait(manager.reconcile(session, job.correlationId, workSignal), workSignal)
          await check()
          workSignal.throwIfAborted()
          tracker.observeHistory(history)
          for (const event of history.events) {
            await check()
            workSignal.throwIfAborted()
            await this.coordination.appendReviewNativeEvent(job, safe.value(event))
          }
          const evidence = tracker.snapshot()
          if (evidence.providerId) lane.providerId = evidence.providerId
          if (evidence.identityConflict) return await failReview({ code: 'REVIEW_JOB_IDENTITY_CONFLICT',
            message: 'Native history conflicts with the durable review identity. No further native response will be sent.' })
          if (evidence.providerId && evidence.acknowledged) await acknowledge(evidence.providerId)
          const pending = history.pendingInteraction ?? history.pendingInteractions[0]
          if (pending) {
            const requests = new Map<string, PendingNativeInteraction>()
            for (const request of [pending, ...history.pendingInteractions]) {
              requests.set(JSON.stringify([request.session, request.turn, request.nativeRequestType]), request)
            }
            return await approvalFailure(pending, [...requests.values()])
          }
          lane.observedStatus = evidence.nativeIdle ? 'idle' : evidence.nativeBusy || evidence.acknowledged ? 'busy' : 'uncertain'
          await maintenance?.stop()
          return await transition(evidence.terminal ? 'completed' : evidence.acknowledged ? 'acknowledged' : 'uncertain', {
            ...(evidence.providerId ? { providerTurnOrMessageId: evidence.providerId } : {}),
            releaseLease: true,
          })
        } catch (rawError) {
          const error = safe.error(rawError)
          if (isLeaseLost(rawError) || guard.signal.aborted || lane.guard.signal.aborted) throw error
          if (isLeaseLost(workSignal.reason)) throw workSignal.reason
          if ((workSignal.aborted && workSignal.reason instanceof DomainError && workSignal.reason.code === 'REVIEWER_CREDENTIAL_LOST')
            || (rawError instanceof DomainError && ['REVIEWER_CREDENTIAL_LOST', 'REVIEWER_AUTHORITY_LOST'].includes(rawError.code))) {
            return await failReview({ code: 'REVIEWER_CREDENTIAL_LOST',
              message: 'Review stopped because its App MCP credential or authority could not be maintained. No replacement native work was started.' })
          }
          if (rawError instanceof DomainError && rawError.code === 'REVIEW_JOB_IDENTITY_CONFLICT') {
            return await failReview({ code: rawError.code, message: 'The review received conflicting native identities.' })
          }
          await maintenance?.stop()
          if (!submitted) {
            const busy = error instanceof DomainError && error.code === 'SESSION_LANE_BUSY'
            if (!busy) lane.observedStatus = 'disconnected'
            return await transition(busy ? 'blocked_busy' : 'blocked_disconnected')
          }
          const rejected = submitting && tracker.processedEvents === 0 && !acknowledged && definitelyRejected(rawError)
          lane.observedStatus = rejected ? 'idle' : 'uncertain'
          return await transition(rejected ? 'failed' : 'uncertain', {
            error: {
              code: rejected ? 'REVIEW_SUBMISSION_REJECTED' : 'REVIEW_DELIVERY_UNCERTAIN',
              message: error instanceof Error ? error.message : 'The review submission outcome is unknown.',
            },
          })
        } finally { await maintenance?.stop() }
      })
    } catch (rawError) {
      const error = safe.error(rawError)
      if (isLeaseLost(rawError) || guard.signal.aborted) throw error
      await guard.check()
      const busy = error instanceof DomainError && error.code === 'SESSION_LANE_BUSY'
      // Even an old uncertain record without submittedAt must never become fresh work on attach failure.
      const mayHaveSubmitted = recovering || Boolean(job.submittedAt || job.acknowledgedAt || job.providerTurnOrMessageId)
      return this.coordination.transitionReviewJob(job.id, jobToken,
        mayHaveSubmitted ? (job.acknowledgedAt || job.providerTurnOrMessageId ? 'acknowledged' : 'uncertain')
          : busy ? 'blocked_busy' : 'blocked_disconnected', {
          releaseLease: true,
          error: { code: busy ? 'REVIEW_SESSION_BUSY' : 'REVIEW_SESSION_DISCONNECTED', message: 'The existing reviewer session could not be exclusively attached.' },
        })
    } finally {
      await guard.stop()
      if (executionId && !guard.signal.aborted) {
        await this.nativeRuntime.finishReview?.(executionId).catch((error) => Promise.reject(safe.error(error)))
      }
    }
  }
}
