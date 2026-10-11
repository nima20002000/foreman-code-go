import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { latestEvidence } from './helpers/workerProfileRequalification.js'

describe('automatic Worker profile qualification', () => {
  it('persists a failed automatic check and refuses Start without borrowing the previous generation', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'sequential' })
    try {
      const before = await latestEvidence(fixture)
      await fixture.provider.hideModels()
      await fixture.restartWorker()
      const evidence = await waitForRemoteReview(() => latestEvidence(fixture), proofs =>
        proofs.length === fixture.profiles.length && proofs.every(proof =>
          proof.connectionGeneration !== before[0]!.connectionGeneration && !proof.qualified),
      'persisted failed automatic profile checks')
      expect(evidence.every(proof => proof.failure !== undefined)).toBe(true)
      const profiles = await waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(
        await fixture.value('harness_instances_list', { hostRef: fixture.hostRef,
          applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId })),
      value => value.overrides.every(profile => profile.qualification === 'unqualified'), 'unqualified MCP readback')
      expect(profiles.overrides).toHaveLength(fixture.profiles.length)
      const refusal = await waitForRemoteReview(async () => {
        try { await fixture.start() } catch (error) { return error }
        throw new Error('A failed profile check admitted a Run.')
      }, error => error instanceof Error && error.message.includes('HARNESS_PROFILE_UNAVAILABLE'),
      'Run refusal after the failed automatic check')
      expect(refusal).toBeInstanceOf(Error)
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      const qualifications = HarnessQualificationListSchema.parse(await fixture.value('harness_qualifications_list', {}))
      expect(qualifications.qualifications.some(record => record.status === 'failed'
        && evidence.some(proof => proof.checkedAt === record.checkedAt))).toBe(true)
    } finally { await fixture.close() }
  }, 240_000)
})
