import { randomUUID } from 'node:crypto'

import { ReviewJobSchema, type DurableInteraction, type NativeHarnessEvent, type NativeSessionReference, type ReviewJob } from '@graphql/contracts'

import { DomainError } from '../errors.js'
import { PostgresInteractionCoordinationRepository } from './coordination.js'
import { definitelyRejected, reviewTurnEvidence } from './reviewerEvidence.js'
import type { InteractionNativeRuntime, NativeManagerResolutionContext } from './runtimePorts.js'
import { coordinateSessionManager, isLeaseLost, LeaseGuard, ownedEvents } from './sessionWriter.js'

export class ReviewerDispatcher {
  private readonly workerId = `review-worker-${randomUUID()}`
  private readonly stopping = new AbortController()
  private readonly active = new Map<string, Promise<unknown>>()

  constructor(
    private readonly coordination: PostgresInteractionCoordinationRepository,
    private readonly nativeRuntime: InteractionNativeRuntime,
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

  async shutdown(): Promise<void> {
    this.stopping.abort(new Error('Reviewer dispatcher is shutting down.'))
    await Promise.allSettled(this.active.values())
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
    const recovering = Boolean(job.submittedAt || job.acknowledgedAt || job.providerTurnOrMessageId
      || ['submitted', 'acknowledged', 'uncertain'].includes(available.state))
    try {
      const { providerVersion, ...ownerContext } = await guard.wait(this.coordination.getReviewJobContext(job.id))
      await guard.check()
      const attached = await guard.wait(this.nativeRuntime.attachOwnedSession({
        harness: job.provider, agentId: job.reviewerAgentId, ...ownerContext,
      }, { harness: job.provider, providerVersion, nativeSessionId: job.nativeSessionId }, guard.signal))
      await guard.check()
      if (attached.session.harness !== job.provider || attached.session.nativeSessionId !== job.nativeSessionId
        || attached.session.providerVersion !== providerVersion) throw new Error('Reviewer attach changed its durable native identity.')
      const writer = coordinateSessionManager(attached.manager, this.coordination, job.reviewerAgentId, this.leaseMs)
      return await writer.withLane(attached.session, job.correlationId, guard.signal, async (manager, lane) => {
        const session = attached.session
        let submitted = recovering
        let submitting = !recovering
        let acknowledged = Boolean(job.acknowledgedAt || job.providerTurnOrMessageId)
        const events: NativeHarnessEvent[] = []
        const transition = async (state: ReviewJob['state'], fields: {
          providerTurnOrMessageId?: string; error?: ReviewJob['error']; releaseLease?: boolean
        } = {}) => {
          await guard.check()
          await lane.guard.check()
          job = await this.coordination.transitionReviewJob(job.id, jobToken, state, { ...fields, writerFence: lane.fence })
          return job
        }
        try {
          if (!recovering) {
            if (!await this.coordination.isReviewPending(job.interactionId, job.reviewerAgentId)) {
              return await transition('failed', { error: { code: 'REVIEW_NO_LONGER_PENDING', message: 'The interaction no longer needs this review.' } })
            }
            // Refresh native evidence while exclusively owned; never bounce a cached lane status.
            await writer.requireIdle(manager, session, job.correlationId, lane)
            await this.coordination.bindLaneTurn(lane.fence, job.correlationId)
            delete lane.providerId
            await transition('submitted')
            submitted = true
            lane.observedStatus = 'uncertain'
            await guard.check()
            await lane.guard.check()
            for await (const event of ownedEvents(manager.startTurn(session, {
              clientCorrelationId: job.correlationId,
              prompt: `Review pending interaction ${job.interactionId}. Inspect it through App MCP and respond only if authorized.`,
            }, lane.guard.signal), lane.guard)) {
              await this.coordination.appendReviewNativeEvent(job, event)
              events.push(event)
              const evidence = reviewTurnEvidence(session, { events, pendingInteractions: [] }, job.correlationId, job.providerTurnOrMessageId)
              if (evidence.providerId) lane.providerId = evidence.providerId
              if (!acknowledged && evidence.acknowledged) {
                job = await transition('acknowledged', evidence.providerId ? { providerTurnOrMessageId: evidence.providerId } : {})
                acknowledged = true
                lane.observedStatus = 'busy'
              }
            }
          }
          submitting = false
          // Submitted/unknown work is observation-only. Missing evidence is not permission to resend.
          await guard.check()
          await lane.guard.check()
          const history = await lane.guard.wait(manager.reconcile(session, job.correlationId, lane.guard.signal))
          for (const event of history.events) await this.coordination.appendReviewNativeEvent(job, event)
          const evidence = reviewTurnEvidence(session, { ...history, events: [...events, ...history.events] }, job.correlationId, job.providerTurnOrMessageId)
          if (evidence.providerId) lane.providerId = evidence.providerId
          lane.observedStatus = evidence.nativeIdle ? 'idle' : evidence.nativeBusy || evidence.acknowledged ? 'busy' : 'uncertain'
          return await transition(evidence.terminal ? 'completed' : evidence.acknowledged ? 'acknowledged' : 'uncertain', {
            ...(evidence.providerId ? { providerTurnOrMessageId: evidence.providerId } : {}),
            releaseLease: true,
          })
        } catch (error) {
          if (isLeaseLost(error) || guard.signal.aborted || lane.guard.signal.aborted) throw error
          if (!submitted) {
            const busy = error instanceof DomainError && error.code === 'SESSION_LANE_BUSY'
            if (!busy) lane.observedStatus = 'disconnected'
            return await transition(busy ? 'blocked_busy' : 'blocked_disconnected')
          }
          const rejected = submitting && events.length === 0 && !acknowledged && definitelyRejected(error)
          lane.observedStatus = rejected ? 'idle' : 'uncertain'
          return await transition(rejected ? 'failed' : 'uncertain', {
            error: {
              code: rejected ? 'REVIEW_SUBMISSION_REJECTED' : 'REVIEW_DELIVERY_UNCERTAIN',
              message: error instanceof Error ? error.message : 'The review submission outcome is unknown.',
            },
          })
        }
      })
    } catch (error) {
      if (isLeaseLost(error) || guard.signal.aborted) throw error
      await guard.check()
      const busy = error instanceof DomainError && error.code === 'SESSION_LANE_BUSY'
      // Even an old uncertain record without submittedAt must never become fresh work on attach failure.
      return this.coordination.transitionReviewJob(job.id, jobToken,
        recovering ? (job.acknowledgedAt || job.providerTurnOrMessageId ? 'acknowledged' : 'uncertain')
          : busy ? 'blocked_busy' : 'blocked_disconnected', {
          releaseLease: true,
          error: { code: busy ? 'REVIEW_SESSION_BUSY' : 'REVIEW_SESSION_DISCONNECTED', message: 'The existing reviewer session could not be exclusively attached.' },
        })
    } finally { await guard.stop() }
  }
}
