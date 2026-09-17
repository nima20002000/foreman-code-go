import assert from 'node:assert/strict'

import type { NativeSessionLane, NativeSessionReference, ReviewJob } from '@graphql/contracts'

import type { PostgresInteractionCoordinationRepository, WriterFence } from '../src/modules/interactions/coordination.js'

export const reviewSession: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'review-session' }
export function reviewJob(): ReviewJob {
  const now = new Date().toISOString()
  return { id: 'review-job', interactionId: 'interaction', reviewerAgentId: 'reviewer', attempt: 1,
    provider: 'codex', nativeSessionId: reviewSession.nativeSessionId, correlationId: 'review-correlation',
    providerTurnOrMessageId: 'review-turn', state: 'acknowledged', submittedAt: now, acknowledgedAt: now, createdAt: now, updatedAt: now }
}

/** In-memory port fake; PostgreSQL predicate/fencing behavior has separate repository-boundary coverage. */
export function reviewCoordination(initial = reviewJob()) {
  let job = structuredClone(initial)
  let lane: NativeSessionLane = { id: 'lane', harness: initial.provider, nativeSessionId: initial.nativeSessionId,
    ownerAgentId: 'reviewer', observedStatus: 'busy', correlationId: initial.correlationId,
    currentTurnOrMessageId: initial.providerTurnOrMessageId, connectionGeneration: 0, observedAt: new Date().toISOString(), revision: 0 }
  const transitions: ReviewJob[] = []
  const value = {
    async nextReviewJob() { return job.cleanup?.completedAt ? undefined : structuredClone(job) },
    async claimReviewJob(_id: string, owner: string, token: string, expires: string) {
      job = { ...job, attempt: job.attempt + 1, leaseToken: token, leaseOwner: owner, leaseExpiresAt: expires }
      return structuredClone(job)
    },
    async getReviewJobContext() { return { executionId: 'execution', workingDirectory: '/tmp/reviewer', providerVersion: initial.provider === 'opencode' ? '1.18.31' : reviewSession.providerVersion } },
    async assertReviewJobLease(_id: string, token: string) { assert.equal(token, job.leaseToken) },
    async renewReviewJob() { return new Date(Date.now() + 60_000).toISOString() },
    async isReviewPending() { return true },
    async appendReviewNativeEvent() {},
    async transitionReviewJob(_id: string, token: string, state: ReviewJob['state'], fields: {
      error?: ReviewJob['error']; providerTurnOrMessageId?: string; cleanup?: ReviewJob['cleanup']; releaseLease?: boolean; writerFence?: WriterFence
    } = {}) {
      assert.equal(token, job.leaseToken)
      const { releaseLease, writerFence, ...patch } = fields
      if (writerFence) assert.equal(writerFence.token, lane.leaseToken)
      job = { ...job, ...patch, state }
      if (releaseLease ?? ['failed', 'completed', 'uncertain'].includes(state)) {
        delete job.leaseToken; delete job.leaseOwner; delete job.leaseExpiresAt
      }
      transitions.push(structuredClone(job))
      return structuredClone(job)
    },
    async ensureLane() { return structuredClone(lane) },
    async claimLane(_id: string, revision: number, owner: string, token: string, expires: string, correlation: string) {
      assert.equal(revision, lane.revision)
      lane = { ...lane, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expires,
        correlationId: correlation, revision: revision + 1 }
      return structuredClone(lane)
    },
    async assertLaneLease(_id: string, token: string) { assert.equal(token, lane.leaseToken) },
    async renewLane() { return new Date(Date.now() + 60_000).toISOString() },
    async releaseLane(_id: string, token: string, fields: { observedStatus: NativeSessionLane['observedStatus']; currentTurnOrMessageId?: string }) {
      assert.equal(token, lane.leaseToken)
      lane = { ...lane, ...fields }
      if (fields.observedStatus === 'idle') delete lane.correlationId
      delete lane.leaseToken; delete lane.leaseOwner; delete lane.leaseExpiresAt
      return structuredClone(lane)
    },
    async bindLaneTurn(_fence: WriterFence, correlation: string) { lane.correlationId = correlation; delete lane.currentTurnOrMessageId },
  }
  return { repository: value as unknown as PostgresInteractionCoordinationRepository,
    transitions, get job() { return structuredClone(job) }, get lane() { return structuredClone(lane) },
    successor() { lane = { ...lane, correlationId: 'successor-correlation', currentTurnOrMessageId: 'successor-turn', observedStatus: 'busy' } },
  }
}
