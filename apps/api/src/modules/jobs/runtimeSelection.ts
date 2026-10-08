import { jobPolicyRequirementsRecord, type JobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import type { JobRuntimeProfileRecord } from '@foreman-code/contracts/job-verification-runtime'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { canonical } from './digest.js'

export function matchesRuntimePolicy(spec: JobDefinitionSpecRecord, profile: JobRuntimeProfileRecord,
  runtimePolicy = jobRuntimeProfilePolicy(profile)): boolean {
  const policy = jobPolicyRequirementsRecord(runtimePolicy)
  if ('runtimeSelection' in spec && spec.runtimeSelection === 'qualified-profile' && profile.schemaVersion === 2
    && profile.approvalConfig.review && profile.status !== 'revoked') {
    const { imageDigest: requestedImage, ...requested } = spec.policy
    const { imageDigest: profileImage, ...candidate } = policy
    void requestedImage
    void profileImage
    return canonical(requested) === canonical(candidate)
  }
  return canonical(spec.policy) === canonical(policy)
}
