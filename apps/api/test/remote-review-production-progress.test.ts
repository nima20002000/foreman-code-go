import { expect, it } from 'vitest'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, ReviewJobSchema } from '@foreman-code/contracts'
import { deliveredReview } from './helpers/remoteReviewProductionCases.js'

it('recovers native delivery after the reviewer accepts its decision and completes its turn', async () => {
  const pending = NATIVE_INTERACTION_FIXTURES.codex
  const option = pending.responseOptions.find(value => value.semantic === 'approve_once')!
  const time = '2026-10-01T00:00:00.000Z'
  let interaction = DurableInteractionSchema.parse({ ...pending, revision: 1,
    status: 'delivery_pending', deliveryState: 'pending', selectedOptionId: option.optionId,
    selectedSemantic: option.semantic, nativeResponse: { decision: 'accept' }, decidedAt: time, updatedAt: time,
  })
  let job = ReviewJobSchema.parse({ id: 'review-original', interactionId: interaction.id,
    reviewerAgentId: interaction.approval.designatedOrchestratorAgentId, attempt: 1, state: 'acknowledged',
    provider: 'codex', nativeSessionId: 'review-session', providerTurnOrMessageId: 'review-turn',
    correlationId: 'review-correlation', createdAt: time, acknowledgedAt: time, updatedAt: time,
  })
  const reconcileReviews = async () => {
    job = ReviewJobSchema.parse({ ...job, state: 'completed', completedAt: time })
  }
  const fixture = {
    provider: { calls: async () => [] },
    reconcileReviews,
    async reconcile() {
      await reconcileReviews()
      interaction = DurableInteractionSchema.parse({ ...interaction,
        status: 'delivered', deliveryState: 'delivered', deliveredAt: time,
      })
    },
    async value() { return { interaction } },
    db: { pool: { query: async () => ({ rows: [{ record: job }] }) } },
  } as unknown as Parameters<typeof deliveredReview>[0]
  const completed = await deliveredReview(fixture, interaction.id)
  expect(completed.interaction).toEqual(interaction)
  expect(completed.interaction.deliveryState).toBe('delivered')
  expect(completed.job.state).toBe('completed')
  expect(completed.job.providerTurnOrMessageId).toBe('review-turn')
})
