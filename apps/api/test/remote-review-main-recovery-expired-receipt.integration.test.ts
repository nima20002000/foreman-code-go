import { describe, expect, it } from 'vitest'
import { retainedReviewRecovery, useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

describe.each(['expired-receipt'] as const)('production remote review after %s Main recovery', recovery => {
  const withRemoteReviewFixture = useRemoteReviewFixture()
  it('continues the original retained review with the Worker alive', async () => {
    await withRemoteReviewFixture(async fixture => {
      const recovered = await retainedReviewRecovery(fixture, recovery)
      const settled = await fixture.details(recovered.runId)
      expect(settled.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(settled.cleanupPending).not.toBe(true)
      expect((await fixture.executions(recovered.runId)).every(execution => execution.state === 'completed')).toBe(true)
      expect(fixture.registry.snapshot().launches.filter(launch => recovered.launchIds.includes(launch.launchId))
        .every(launch => launch.lifecycle !== 'active')).toBe(true)
    })
  }, 120_000)
})
