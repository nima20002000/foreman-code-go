import { describe, it } from 'vitest'
import { retainedReviewRecovery, useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

describe('production remote review and native recovery through authenticated MCP', () => {
  it.each(['expired-receipt'] as const)(
    'continues the original retained review after Main recovery from %s with the Worker alive', async recovery => {
      await withRemoteReviewFixture(fixture => retainedReviewRecovery(fixture, recovery))
    }, 50_000,
  )
})
