import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'
import { latestEvidence, assertMcpReadback } from './helpers/workerProfileRequalification.js'
import { waitForReplacementReviewInventory } from './helpers/remoteReviewProductionCases.js'

describe('automatic Worker profile qualification', () => {
  it('retains same-boot qualification through MCP while refusing an unpublished Worker bundle', async () => {
    const fixture = await remoteReviewProduction({
      workflow: 'sequential', parallelProfileChecks: true, parallelSetup: true,
    })
    try {
      const before = await latestEvidence(fixture)
      expect(before).toHaveLength(fixture.profiles.length)
      expect(before.every(proof => proof.qualified)).toBe(true)
      const checksBefore = (await fixture.provider.calls()).filter(call => call.qualificationSuite).length
      const inventoryBefore = await fixture.inventory()
      await fixture.restartWorker()
      const inventoryAfter = await waitForReplacementReviewInventory(fixture, inventoryBefore)
      expect(inventoryAfter.hostMetadata!.connection!.binding.bootId)
        .toBe(inventoryBefore.hostMetadata!.connection!.binding.bootId)
      expect(await latestEvidence(fixture)).toEqual(before)
      await assertMcpReadback(fixture, before)
      await expect(fixture.start()).rejects.toThrow('WORKER_BUNDLE_UNPUBLISHED')
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect((await fixture.provider.calls()).filter(call => call.qualificationSuite)).toHaveLength(checksBefore)
      const audit = await fixture.db.pool.query<{ source: string; principal_id: string | null; details: unknown }>(
        "select source,principal_id,details from management_audit where action='harness.instance.check' and source='system'")
      expect(audit.rows).toHaveLength(0)

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
      await fixture.close()
    }
  }, 240_000)
})
