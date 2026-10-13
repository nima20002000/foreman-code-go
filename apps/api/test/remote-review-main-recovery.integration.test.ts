import { describe, it } from 'vitest'
import { retainedReviewRecovery, useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

describe.each(['graceful', 'expired-receipt'] as const)('production remote review after %s Main recovery', recovery => {
  const withRemoteReviewFixture = useRemoteReviewFixture()
  it('continues the original retained review with the Worker alive', async () => {
    await withRemoteReviewFixture(fixture => retainedReviewRecovery(fixture, recovery))
  }, 120_000)
})
