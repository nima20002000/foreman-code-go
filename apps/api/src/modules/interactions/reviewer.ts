import { randomUUID } from 'node:crypto'

import { ReviewJobSchema, type DurableInteraction, type NativeSessionReference, type ReviewJob } from '@graphql/contracts'

import { PostgresInteractionCoordinationRepository } from './coordination.js'
import type { InteractionNativeRuntime, NativeManagerResolutionContext } from './runtimePorts.js'

export class ReviewerDispatcher {
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
    const now = new Date().toISOString()
    const result = await this.coordination.ensureReviewJob(ReviewJobSchema.parse({
      id: `review-${randomUUID()}`, interactionId: interaction.id, reviewerAgentId,
      attempt: 0, state: 'pending', provider: session.harness, nativeSessionId: session.nativeSessionId,
      correlationId: `review-correlation-${randomUUID()}`, createdAt: now, updatedAt: now,
    }), { ...context, providerVersion: session.providerVersion })
    return result.job
  }

  async dispatchNext(reviewerAgentId: string, workerId: string): Promise<ReviewJob | undefined> {
    const available = await this.coordination.nextReviewJob(reviewerAgentId)
    if (!available) return undefined
    const jobToken = `review-lease-${randomUUID()}`
    const leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString()
    let job = await this.coordination.claimReviewJob(available.id, workerId, jobToken, leaseExpiresAt)
    const durableContext = await this.coordination.getReviewJobContext(job.id)
    let lane = await this.coordination.getLane(job.provider, job.nativeSessionId)
    if (!lane) throw new Error('The designated reviewer session has no durable single-writer lane.')
    if (lane.observedStatus === 'busy') return this.coordination.transitionReviewJob(job.id, jobToken, 'blocked_busy')
    if (lane.observedStatus === 'disconnected') return this.coordination.transitionReviewJob(job.id, jobToken, 'blocked_disconnected')
    if (lane.observedStatus === 'uncertain') return this.coordination.transitionReviewJob(job.id, jobToken, 'uncertain')

    const laneToken = `lane-lease-${randomUUID()}`
    try {
      lane = await this.coordination.claimLane(
        lane.id, lane.revision, workerId, laneToken, leaseExpiresAt, job.correlationId,
      )
    } catch {
      return this.coordination.transitionReviewJob(job.id, jobToken, 'blocked_busy')
    }

    const { providerVersion, ...ownerContext } = durableContext
    let attached
    try {
      attached = await this.nativeRuntime.attachOwnedSession({
        harness: job.provider, agentId: job.reviewerAgentId, ...ownerContext,
      }, {
        harness: job.provider, providerVersion,
        nativeSessionId: job.nativeSessionId,
      })
    } catch {
      const blocked = await this.coordination.transitionReviewJob(job.id, jobToken, 'blocked_disconnected')
      await this.coordination.releaseLane(lane.id, laneToken, { observedStatus: 'disconnected' }).catch(() => undefined)
      return blocked
    }
    const manager = attached.manager
    const session = attached.session
    let acknowledged = false
    try {
      job = await this.coordination.transitionReviewJob(job.id, jobToken, 'submitted')
      for await (const event of manager.startTurn(session, {
        clientCorrelationId: job.correlationId,
        prompt: `Review pending interaction ${job.interactionId}. Inspect it through App MCP and respond only if authorized.`,
      })) {
        if (acknowledged) continue
        acknowledged = true
        const providerId = typeof event.payload.turnId === 'string' ? event.payload.turnId
          : typeof event.payload.messageId === 'string' ? event.payload.messageId : undefined
        job = await this.coordination.transitionReviewJob(job.id, jobToken, 'acknowledged', {
          ...(providerId ? { providerTurnOrMessageId: providerId } : {}),
        })
      }
      job = await this.coordination.transitionReviewJob(job.id, jobToken, 'completed')
      await this.coordination.releaseLane(lane.id, laneToken, { observedStatus: 'idle' })
      return job
    } catch (error) {
      const uncertain = acknowledged || (error && typeof error === 'object' && 'certainty' in error && error.certainty === 'uncertain')
      const next = await this.coordination.transitionReviewJob(job.id, jobToken, uncertain ? 'uncertain' : 'failed', {
        error: { code: uncertain ? 'REVIEW_DELIVERY_UNCERTAIN' : 'REVIEW_DELIVERY_FAILED', message: error instanceof Error ? error.message : 'Review delivery failed.' },
      })
      await this.coordination.releaseLane(lane.id, laneToken, { observedStatus: uncertain ? 'uncertain' : 'idle' }).catch(() => undefined)
      return next
    }
  }
}
