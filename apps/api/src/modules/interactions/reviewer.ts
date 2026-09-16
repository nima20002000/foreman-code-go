import { randomUUID } from 'node:crypto'

import { ReviewJobSchema, type DurableInteraction, type NativeSessionLane, type NativeSessionReference, type ReviewJob } from '@graphql/contracts'

import type { NativeSessionManagerResolver } from './service.js'
import { PostgresInteractionCoordinationRepository } from './coordination.js'

export class ReviewerDispatcher {
  constructor(
    private readonly coordination: PostgresInteractionCoordinationRepository,
    private readonly managers: NativeSessionManagerResolver,
    private readonly leaseMs = 30_000,
  ) {}

  async enqueue(interaction: DurableInteraction, reviewerAgentId: string, session: NativeSessionReference): Promise<ReviewJob> {
    const now = new Date().toISOString()
    const result = await this.coordination.ensureReviewJob(ReviewJobSchema.parse({
      id: `review-${randomUUID()}`, interactionId: interaction.id, reviewerAgentId,
      attempt: 0, state: 'pending', provider: session.harness, nativeSessionId: session.nativeSessionId,
      correlationId: `review-correlation-${randomUUID()}`, createdAt: now, updatedAt: now,
    }))
    return result.job
  }

  async dispatchNext(reviewerAgentId: string, workerId: string): Promise<ReviewJob | undefined> {
    const available = await this.coordination.nextReviewJob(reviewerAgentId)
    if (!available) return undefined
    const jobToken = `review-lease-${randomUUID()}`
    const leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString()
    let job = await this.coordination.claimReviewJob(available.id, workerId, jobToken, leaseExpiresAt)
    const manager = this.managers.resolve(job.provider)
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

    const session = {
      harness: job.provider,
      providerVersion: (await manager.capabilities()).providerVersion,
      nativeSessionId: job.nativeSessionId,
    }
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
