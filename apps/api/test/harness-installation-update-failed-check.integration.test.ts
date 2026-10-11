import { describe, expect, it } from 'vitest'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { installationUpdateFixture, profiles, latestEvidence }
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('persists a failed update check and exposes its reason through MCP without admitting a new Run', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'sequential' })
    try {
      await fixture.provider.hideModels()
      await fixture.provider.updatePayload()
      const failed = await waitForRemoteReview(() => profiles(fixture), values => values.every(value =>
        value.qualification === 'unqualified' && value.qualificationFailure !== undefined), 'failed update readback')
      expect(failed).toHaveLength(fixture.profiles.length)
      expect(failed.every(value => value.qualificationFailure!.message.length > 0)).toBe(true)
      expect((await latestEvidence(fixture)).every(proof => !proof.qualified && proof.failure !== undefined)).toBe(true)
      await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_UNAVAILABLE')
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
    } finally { await fixture.close() }
  }, 240_000)
})
