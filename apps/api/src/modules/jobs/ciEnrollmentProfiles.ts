import type { CiInstalledStorage } from '@foreman-code/contracts'
import { JobRuntimeProfileSaveRecordSchema, jobRuntimeProfilePolicy, jobRuntimeProfileLimits,
  type JobRuntimeProfileRecord, type JobRuntimeProfileSaveRecord } from '@foreman-code/contracts/job-verification-runtime'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { DomainError } from '../errors.js'
import { jobDigest } from './digest.js'

export function ciEnrollmentTemplateDigest(profile: JobRuntimeProfileRecord): string {
  const policy = jobPolicyRequirementsRecord(jobRuntimeProfilePolicy(profile))
  return jobDigest({ name: profile.name, policy: { ...policy, imageDigest: null },
    limits: jobRuntimeProfileLimits(profile),
    source: profile.root.source, sourceCommit: profile.schemaVersion === 2 ? profile.sourceCommit : null,
    verification: profile.schemaVersion === 2 ? {
      resources: profile.spec.resources, suites: profile.spec.suites, approvalConfig: profile.spec.approvalConfig,
    } : null })
}

export function ciEnrollmentProfileInput(template: JobRuntimeProfileRecord, root: SourceRootRecord,
  storage: CiInstalledStorage, commandId: string, previous?: JobRuntimeProfileRecord): JobRuntimeProfileSaveRecord {
  const templateLimits = jobRuntimeProfileLimits(template)
  const limits = { ...templateLimits, diskBytes: Math.min(templateLimits.diskBytes, storage.diskBytes) }
  let spec: JobRuntimeProfileSaveRecord['spec']
  if (template.schemaVersion === 2) {
    const resources = { ...template.spec.resources, limits,
      mutableInodes: Math.min(template.spec.resources.mutableInodes, storage.mutableInodes) }
    const reserved = resources.controlTempBytes + resources.spoolBytes + resources.reportBytes
    if (reserved >= limits.diskBytes) {
      throw new DomainError('CI_ENROLLMENT_STORAGE_REQUIRED', 'The installed CI volume is too small for this profile.', 409)
    }
    resources.scratchBytes = Math.min(resources.scratchBytes, limits.diskBytes - reserved)
    spec = { ...template.spec, resources, rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }
  } else {
    spec = { limits, policy: jobPolicyRequirementsRecord(template.policy),
      rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }
  }
  return JobRuntimeProfileSaveRecordSchema.parse({ commandId, name: template.name, spec,
    expectedRevision: previous?.revision ?? null, ...(previous ? { id: previous.id } : {}) })
}
