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
  const reads = await Promise.allSettled([
    // Evidence commits before the inventory refresh finishes and clears the pending check.
    waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(
      await fixture.value('harness_instances_list', {
        hostRef: fixture.hostRef, applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId,
      })), profiles => profiles.overrides.every(profile => profile.qualification !== 'qualifying'),
    'automatic profile checks completing through MCP'),
    fixture.value('harness_qualifications_list', {}),
    fixture.inventory(),
  ])
  const [profilesRead, qualificationsRead, inventoryRead] = reads
  if (profilesRead.status === 'rejected' || qualificationsRead.status === 'rejected'
    || inventoryRead.status === 'rejected') {
    const errors = reads.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    throw new AggregateError(errors, 'Worker profile readback failed.')
  }
  const profiles = HostHarnessOverrideListSchema.parse(profilesRead.value)
  expect(profiles.overrides).toHaveLength(fixture.profiles.length)
  expect(profiles.overrides.every(profile => profile.qualification === 'qualified')).toBe(true)
  const qualifications = HarnessQualificationListSchema.parse(qualificationsRead.value)
  expect(qualifications.qualifications).toContainEqual(evidence.at(-1)!.completedNativeQualification!.record)
  const inventory = inventoryRead.value
  const generation = inventory.installations.find(installation => installation.driverId === 'codex')!.connectionGeneration
  expect(evidence.every(proof => proof.connectionGeneration === generation)).toBe(true)
}

