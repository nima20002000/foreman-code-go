import { expect } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>

export async function latestEvidence(fixture: Fixture) {
  const rows = await fixture.db.pool.query<{ record: unknown }>(`select distinct on(instance_id) record
    from harness_instance_profile_evidence order by instance_id,created_at desc,check_id desc`)
  return rows.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record))
}

export async function refreshedEvidence(fixture: Fixture, previousGeneration: string) {
  return waitForRemoteReview(async () => {
    const evidence = await latestEvidence(fixture)
    const failed = evidence.find(proof => proof.connectionGeneration !== previousGeneration && !proof.qualified)
    if (failed) throw new Error(`Automatic profile qualification failed: ${failed.failure?.code}`)
    const audit = await fixture.db.pool.query<{ details: { code: string } }>(`select details from management_audit
      where source='system' and action='harness.instance.check' and outcome='failed' order by sequence desc limit 1`)
    if (audit.rows[0]) throw new Error(`Automatic profile check failed: ${audit.rows[0].details.code}`)
    return evidence
  }, evidence =>
    evidence.length === fixture.profiles.length && evidence.every(proof =>
      proof.connectionGeneration !== previousGeneration && proof.qualified), 'fresh automatic profile evidence')
}

export async function startWhenReady(fixture: Fixture) {
  return waitForRemoteReview(async () => {
    try { return await fixture.start() } catch (error) {
      if (error instanceof Error && error.message.includes('HARNESS_PROFILE_CHECK_PENDING')) return undefined
      throw error
    }
  }, result => result !== undefined, 'Run admission after automatic profile checks')
}

export async function assertMcpReadback(fixture: Fixture, evidence: Awaited<ReturnType<typeof latestEvidence>>) {
  const profiles = HostHarnessOverrideListSchema.parse(await fixture.value('harness_instances_list', {
    hostRef: fixture.hostRef, applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId,
  }))
  expect(profiles.overrides).toHaveLength(fixture.profiles.length)
  expect(profiles.overrides.every(profile => profile.qualification === 'qualified')).toBe(true)
  const qualifications = HarnessQualificationListSchema.parse(await fixture.value('harness_qualifications_list', {}))
  expect(qualifications.qualifications).toContainEqual(evidence.at(-1)!.completedNativeQualification!.record)
  const inventory = await fixture.inventory()
  const generation = inventory.installations.find(installation => installation.driverId === 'codex')!.connectionGeneration
  expect(evidence.every(proof => proof.connectionGeneration === generation)).toBe(true)
}

