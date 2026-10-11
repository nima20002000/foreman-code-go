import { describe, it } from 'vitest'
import { retainedReviewRecovery, withRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

describe('production remote review and native recovery through authenticated MCP', () => {
  it.each(['expired-receipt'] as const)(
    'continues the original retained review after Main recovery from %s with the Worker alive', async recovery => {
      await withRemoteReviewFixture(fixture => retainedReviewRecovery(fixture, recovery))
    }, 50_000,
  )
})
