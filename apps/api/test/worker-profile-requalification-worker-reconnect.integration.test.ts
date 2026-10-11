import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { latestEvidence, refreshedEvidence, startWhenReady, assertMcpReadback } from './helpers/workerProfileRequalification.js'

describe('automatic Worker profile qualification', () => {
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
      expect(HostHarnessOverrideListSchema.parse(decodeMcpToolResult(readerProfiles))).toEqual(
        HostHarnessOverrideListSchema.parse(await fixture.value('harness_instances_list', {
          hostRef: fixture.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
        })))
    } finally {
      if (blocked) await fixture.provider.releaseModels()
      await fixture.close()
    }
  }, 240_000)
})
