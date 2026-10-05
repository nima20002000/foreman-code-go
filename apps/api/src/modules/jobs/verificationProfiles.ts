import { JobVerificationProfileSchema, type JobVerificationProfile,
  type JobRuntimeProfileRecord, type JobVerificationProfileInput } from '@foreman-code/contracts/job-verification-runtime'
import { JobVerificationApprovalConfigSchema, JOB_VERIFICATION_APPROVAL_LIFETIME_MS }
  from '@foreman-code/contracts/job-verification-policy'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../errors.js'
import { jobDigest } from './service.js'

export function createVerificationProfile(input: {
  id: string
  workspaceId: string
  revision: number
  name: string
  root: SourceRootRecord
  spec: JobVerificationProfileInput
  previous: JobRuntimeProfileRecord | null
  now: string
}) {
  const previous = input.previous
  let approvalConfig = JobVerificationApprovalConfigSchema.parse({
    schemaVersion: 1, revision: 1, approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS, review: null,
  })
  if (previous?.schemaVersion === 2) approvalConfig = previous.approvalConfig
  if (input.spec.approvalConfig.approvalLifetimeMs !== approvalConfig.approvalLifetimeMs) {
    throw new DomainError('JOB_VERIFICATION_OWNER_REVIEW_REQUIRED',
      'The verification approval lifetime needs owner review before a different value can be saved.', 409,
      { decisions: ['approval-lifetime'] })
  }
  return JobVerificationProfileSchema.parse({
    schemaVersion: 2, id: input.id, workspaceId: input.workspaceId, revision: input.revision,
    name: input.name, root: input.root, spec: input.spec,
    specDigest: jobDigest({ workspaceId: input.workspaceId, id: input.id, revision: input.revision,
      root: input.root, spec: input.spec, approvalConfig }),
    approvalConfig, status: 'unqualified', measurement: null,
    createdAt: previous?.createdAt ?? input.now, updatedAt: input.now,
  })
}

export function requireVerificationOwnerReview(profile: JobVerificationProfile): void {
  if (!profile.approvalConfig.review) {
    const decisions = ['approval-lifetime', 'resource-envelopes']
    if (profile.spec.policy.network.mode !== 'none') decisions.push('egress-enforcement')
    if (profile.spec.suites.some(suite => suite === 'native-acceptance' || suite === 'full-gate-local')) {
      decisions.push('provider-credential-scope')
    }
    if (profile.spec.suites.some(suite => suite === 'browser' || suite === 'full-gate-local')) {
      decisions.push('mandatory-checks')
    }
    throw new DomainError('JOB_VERIFICATION_OWNER_REVIEW_REQUIRED',
      'Verification activation is pending the owner’s approval lifetime and resource decisions. No qualification has started.',
      409, { decisions, activation: 'disabled-pending-owner-decision' })
  }
}
