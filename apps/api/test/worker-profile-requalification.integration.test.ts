import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>

async function latestEvidence(fixture: Fixture) {
  const rows = await fixture.db.pool.query<{ record: unknown }>(`select distinct on(instance_id) record
    from harness_instance_profile_evidence order by instance_id,created_at desc,check_id desc`)
  return rows.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record))
}

async function refreshedEvidence(fixture: Fixture, previousGeneration: string) {
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

async function startWhenReady(fixture: Fixture) {
  return waitForRemoteReview(async () => {
    try { return await fixture.start() } catch (error) {
      if (error instanceof Error && error.message.includes('HARNESS_PROFILE_CHECK_PENDING')) return undefined
      throw error
    }
  }, result => result !== undefined, 'Run admission after automatic profile checks')
}

async function assertMcpReadback(fixture: Fixture, evidence: Awaited<ReturnType<typeof latestEvidence>>) {
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

describe('automatic Worker profile qualification', () => {
  it('checks previously qualified Worker profiles after Main restarts before admitting a new Run', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'sequential' })
    try {
      const before = await latestEvidence(fixture)
      await fixture.restartMain()
      const evidence = await refreshedEvidence(fixture, before[0]!.connectionGeneration)
      await assertMcpReadback(fixture, evidence)
      const started = (await startWhenReady(fixture))!
      expect((await fixture.details(started.run.id)).run.id).toBe(started.run.id)
    } catch (error) {
      const audit = await fixture.db.pool.query(`select outcome,details from management_audit
        where source='system' and action='harness.instance.check' order by sequence`)
      console.error('Main restart qualification failure', { error: String(error), audit: audit.rows,
        evidence: (await latestEvidence(fixture)).map(proof => ({ generation: proof.connectionGeneration,
          qualified: proof.qualified, failure: proof.failure })), failures: fixture.failures() })
      throw error
    } finally { await fixture.close() }
  }, 240_000)

  it('retries Start during a reconnect check and then starts with fresh evidence through authenticated MCP', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'sequential' })
    let blocked = false
    try {
      const before = await latestEvidence(fixture)
      const modelsBefore = (await fixture.provider.calls()).filter(call => call.method === 'model/list').length
      await fixture.provider.blockModels()
      blocked = true
      await fixture.restartWorker()
      await waitForRemoteReview(() => fixture.provider.calls(), calls =>
        calls.filter(call => call.method === 'model/list').length > modelsBefore, 'automatic native profile check')
      await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
      expect(await latestEvidence(fixture)).toEqual(before)
      await fixture.provider.releaseModels()
      blocked = false
      const evidence = await refreshedEvidence(fixture, before[0]!.connectionGeneration)
      await assertMcpReadback(fixture, evidence)
      const started = (await startWhenReady(fixture))!
      expect((await fixture.details(started.run.id)).run.id).toBe(started.run.id)
      const audit = await fixture.db.pool.query<{ source: string; principal_id: string | null; details: unknown }>(
        "select source,principal_id,details from management_audit where action='harness.instance.check' and source='system'")
      expect(audit.rows).toHaveLength(fixture.profiles.length)
      expect(audit.rows.every(row => row.principal_id === null)).toBe(true)

      const reader = await fixture.access.issue({ name: 'profile reader', audience: 'operator',
        grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      const profile = fixture.profiles[0]!
      const deniedCheck = await fixture.call('harness_instance_check', { commandId: randomUUID(),
        instanceId: profile.instanceId, expectedRevision: profile.revision, target: profile.target }, reader.token)
      expect(deniedCheck.isError).toBe(true)
      expect(JSON.stringify(deniedCheck.content)).toContain('ACCESS_DENIED')
      const readerProfiles = await fixture.call('harness_instances_list', {
        hostRef: fixture.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
      }, reader.token)
      expect(readerProfiles.isError).not.toBe(true)
      expect(HostHarnessOverrideListSchema.parse(readerProfiles.structuredContent)).toEqual(
        HostHarnessOverrideListSchema.parse(await fixture.value('harness_instances_list', {
          hostRef: fixture.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
        })))
    } finally {
      if (blocked) await fixture.provider.releaseModels()
      await fixture.close()
    }
  }, 240_000)

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
