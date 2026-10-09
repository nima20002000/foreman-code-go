import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { ciEnrollmentProfileInput, ciEnrollmentTemplateDigest } from './ciEnrollmentProfiles.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'

describe('CI enrollment profile sizing', () => {
  it('preserves policy and suites while fitting scratch and inode reservations to installed storage', () => {
    const template = verificationCapacityFixture('device')
    const resources = template.spec.resources
    const reserved = resources.controlTempBytes + resources.reportBytes + resources.spoolBytes
    const storage = { diskBytes: reserved + 1024, mutableInodes: 100 }
    const root = structuredClone(template.root)
    root.binding.rootId = randomUUID()
    root.binding.bindingRevision = 4
    const input = ciEnrollmentProfileInput(template, root, storage, 'enroll')
    expect(input.expectedRevision).toBeNull()
    expect(input.spec).toMatchObject({ rootId: root.binding.rootId, bindingRevision: 4,
      policy: template.spec.policy, suites: template.spec.suites,
      resources: { limits: { ...resources.limits, diskBytes: storage.diskBytes },
        scratchBytes: 1024, mutableInodes: 100, reportBytes: resources.reportBytes, spoolBytes: resources.spoolBytes } })
    expect(template.spec.resources).toEqual(resources)
  })

  it('does not increase a template budget on larger storage and preserves revision conflicts', () => {
    const template = verificationCapacityFixture('device')
    const input = ciEnrollmentProfileInput(template, template.root,
      { diskBytes: template.spec.resources.limits.diskBytes * 2, mutableInodes: template.spec.resources.mutableInodes * 2 },
      'enroll', template)
    expect(input).toMatchObject({ id: template.id, expectedRevision: template.revision, spec: template.spec })
  })

  it('reports insufficient storage instead of shrinking required output budgets', () => {
    const template = verificationCapacityFixture('device')
    expect(() => ciEnrollmentProfileInput(template, template.root,
      { diskBytes: 1, mutableInodes: 100 }, 'enroll')).toThrow('too small')
  })

  it('does not clone again after qualification or an image refresh, but notices policy changes', () => {
    const profile = verificationCapacityFixture('device')
    const digest = ciEnrollmentTemplateDigest(profile)
    const refreshed = structuredClone(profile)
    refreshed.revision++
    refreshed.spec.policy.imageDigest = `sha256:${'9'.repeat(64)}`
    expect(ciEnrollmentTemplateDigest(refreshed)).toBe(digest)
    refreshed.spec.resources.limits.memoryBytes++
    expect(ciEnrollmentTemplateDigest(refreshed)).not.toBe(digest)
  })

  it('sizes ordinary job profiles without changing their runtime policy requirements', () => {
    const template = buildComputerFixture(randomUUID(), randomUUID()).candidate.profile
    template.policy.maxOutputBytes = 1024
    template.policy.maxWorkerSpoolBytes = 131072
    const input = ciEnrollmentProfileInput(template, template.root,
      { diskBytes: template.limits.diskBytes / 2, mutableInodes: 100 }, 'enroll')
    const { isolationPolicyId, isolationPolicyRevision, ...policy } = template.policy
    expect(isolationPolicyId).toBe(template.id)
    expect(isolationPolicyRevision).toBe(template.revision)
    expect(input.spec).toEqual({ rootId: template.root.binding.rootId,
      bindingRevision: template.root.binding.bindingRevision, policy,
      limits: { ...template.limits, diskBytes: template.limits.diskBytes / 2 } })
  })
})
