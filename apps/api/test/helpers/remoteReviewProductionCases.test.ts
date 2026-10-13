import { expect, it, vi } from 'vitest'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, ReviewJobSchema } from '@foreman-code/contracts'
import { deliveredReview } from './remoteReviewProductionCases.js'
import type { remoteReviewProduction } from './remoteReviewProduction.js'

it('observes remote delivery through the original decision retry without application maintenance', async () => {
  const now = new Date().toISOString()
  const interaction = DurableInteractionSchema.parse({
    ...NATIVE_INTERACTION_FIXTURES.codex,
    status: 'delivered',
    deliveryState: 'delivered',
    selectedOptionId: 'codex-approve-once',
    selectedSemantic: 'approve_once',
    nativeResponse: { decision: 'accept' },
    decidedAt: now,
    deliveredAt: now,
  })
  const job = ReviewJobSchema.parse({
    id: 'review-job',
    interactionId: interaction.id,
    reviewerAgentId: 'agent-orchestrator',
    attempt: 1,
    state: 'completed',
    provider: 'codex',
    nativeSessionId: 'review-session',
    providerTurnOrMessageId: 'review-turn',
    correlationId: 'review-correlation',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  })
  let retried = false
  const fixture = {
    provider: {
      calls: async () => [],
      retryReview: async () => { retried = true },
    },
    reconcile: async () => { throw new Error('Application maintenance is unavailable.') },
    reconcileReviews: async () => undefined,
    db: { pool: { query: async () => ({ rows: [{ record: job }] }) } },
    value: vi.fn(async () => {
      if (!retried) throw new Error('The original reviewer has not retried its decision.')
      return { interaction }
    }),
  } as unknown as Awaited<ReturnType<typeof remoteReviewProduction>>

  await expect(deliveredReview(fixture, interaction.id)).resolves.toEqual({ interaction, job })
})
