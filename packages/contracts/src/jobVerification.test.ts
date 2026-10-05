import { describe, expect, it } from 'vitest'
import {
  AcceptedVerificationJobSpecSchema, AutoVerificationJobSpecSchema, JobAcceptedSpecRecordSchema,
  JobDefinitionRecordSchema, JobVerificationOutputsSchema, JobVerificationPassSchema, JobVerificationReportSchema,
  ResolvedVerificationJobSpecSchema,
} from './jobVerification.js'
import {
  JOB_VERIFICATION_APPROVAL_LIFETIME_MS, JobNetworkPolicySchema, JobResourceRequestSchema,
  JobVerificationApprovalConfigInputSchema, JobVerificationApprovalConfigSchema, JobVerificationDispatchValiditySchema,
} from './jobVerificationPolicy.js'
import { JobVerificationGateResultSchema } from './jobVerificationGate.js'
import { verificationFixture, verificationId, verificationTime, verificationDigest } from '../tests/helpers/jobVerification.js'

describe('verification placement and policy', () => {
  it('keeps Auto requests separate from concrete immutable acceptance and preserves build history unchanged', () => {
    const { spec, acceptedBuild, definition, profile, resources, lifecycle } = verificationFixture()
    const { isolationPolicyId, isolationPolicyRevision, ...policy } = spec.policy
    expect(isolationPolicyId).toBe(profile.profileId)
    expect(isolationPolicyRevision).toBe(profile.profileRevision)
    const auto = { ...spec, target: { kind: 'auto' }, policy, limits: resources.limits }
    expect(AutoVerificationJobSpecSchema.parse(auto)).toEqual(auto)
    const accepted = { ...acceptedBuild, ...spec, source: acceptedBuild.source,
      schemaVersion: 2, profile, reservationId: verificationId, lifecycle,
      resourcePolicyRevision: 1, resourcePolicyDigest: verificationDigest,
      runtimeApprovalId: verificationId, runtimeApprovalRevision: 1 }
    expect(AcceptedVerificationJobSpecSchema.parse(accepted)).toEqual(accepted)
    expect(Object.isFrozen(AcceptedVerificationJobSpecSchema.parse(accepted))).toBe(true)
    expect(AcceptedVerificationJobSpecSchema.safeParse({ ...accepted, target: auto.target }).success).toBe(false)
    expect(AcceptedVerificationJobSpecSchema.safeParse({ ...accepted,
      profile: { ...profile, profileRevision: 2 } }).success).toBe(false)
    expect(JobAcceptedSpecRecordSchema.parse(acceptedBuild)).toEqual(acceptedBuild)
    expect(JobDefinitionRecordSchema.parse(definition)).toEqual(definition)
    expect(AcceptedVerificationJobSpecSchema.safeParse(acceptedBuild).success).toBe(false)
  })
  it('rejects public egress for ordinary suites, inherited credentials, missing enforcement and resource widening', () => {
    const { spec, resources } = verificationFixture()
    const network = { schemaVersion: 2, mode: 'public-egress', enforcement: {
      implementation: 'reviewed-worker-egress', version: '1', destinationPolicyDigest: verificationDigest,
    } }
    expect(ResolvedVerificationJobSpecSchema.safeParse({ ...spec, policy: { ...spec.policy, network } }).success).toBe(false)
    expect(JobNetworkPolicySchema.safeParse({ schemaVersion: 2, mode: 'registry-only' }).success).toBe(false)
    expect(JobNetworkPolicySchema.safeParse({ schemaVersion: 2, mode: 'host' }).success).toBe(false)
    expect(JobNetworkPolicySchema.safeParse({ schemaVersion: 1, mode: 'none' }).success).toBe(false)
    expect(JobResourceRequestSchema.safeParse({ ...resources, shmBytes: resources.limits.memoryBytes + 1 }).success).toBe(false)
    expect(JobResourceRequestSchema.safeParse({ ...resources, scratchBytes: resources.limits.diskBytes }).success).toBe(false)
    const credentials = [{ id: 'provider-test-account', version: 1, scopeDigest: verificationDigest }]
    expect(ResolvedVerificationJobSpecSchema.safeParse({ ...spec,
      verification: { ...spec.verification, credentialRefs: credentials } }).success).toBe(false)
    expect(ResolvedVerificationJobSpecSchema.safeParse({ ...spec,
      policy: { ...spec.policy, environmentScopeRefs: ['owner-environment'] } }).success).toBe(false)
    expect(ResolvedVerificationJobSpecSchema.safeParse({ ...spec,
      verification: { ...spec.verification, parameters: { unitWorkers: 1, integrationShards: 13 } } }).success).toBe(false)
  })
  it('requires fixed report paths, roles, media types and bounded declared publication', () => {
    const { spec } = verificationFixture()
    expect(JobVerificationOutputsSchema.parse(spec.outputs)).toEqual(spec.outputs)
    expect(JobVerificationOutputsSchema.safeParse([]).success).toBe(false)
    expect(JobVerificationOutputsSchema.safeParse([...spec.outputs, ...spec.outputs]).success).toBe(false)
    expect(JobVerificationOutputsSchema.safeParse([{ ...spec.outputs[0], path: '../outside.json' }]).success).toBe(false)
    expect(JobVerificationOutputsSchema.safeParse([{ ...spec.outputs[0], required: false }]).success).toBe(false)
    expect(JobVerificationOutputsSchema.safeParse([{ ...spec.outputs[0], mediaType: 'text/plain' }]).success).toBe(false)
    expect(ResolvedVerificationJobSpecSchema.safeParse({ ...spec,
      outputs: [{ ...spec.outputs[0], maxBytes: spec.policy.maxOutputBytes + 1 }] }).success).toBe(false)
  })
})

describe('reviewed bounded approval lifetime', () => {
  it('defaults conservatively, admits no caller review, and blocks dispatch until owner review', () => {
    expect(JobVerificationApprovalConfigInputSchema.parse({})).toEqual({
      approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
    })
    const review = { reviewedByPrincipalId: 'human-owner', reviewedAt: verificationTime, decisionDigest: verificationDigest }
    expect(JobVerificationApprovalConfigInputSchema.safeParse({ review }).success).toBe(false)
    const config = { schemaVersion: 1, revision: 1, approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS, review: null }
    expect(JobVerificationApprovalConfigSchema.parse(config)).toEqual(config)
    expect(JobVerificationApprovalConfigSchema.safeParse({ ...config, approvalLifetimeMs: 9_000_000 }).success).toBe(false)
    expect(JobVerificationApprovalConfigSchema.parse({ ...config, approvalLifetimeMs: 9_000_000, review }).review).toEqual(review)
    const { profile, spec } = verificationFixture()
    const validity = { identity: profile, approvalConfig: config, approvedAt: verificationTime,
      dispatchAt: verificationTime, policy: spec.policy }
    expect(JobVerificationDispatchValiditySchema.safeParse(validity).success).toBe(false)
    expect(JobVerificationDispatchValiditySchema.safeParse({ ...validity, approvalConfig: { ...config, review } }).success).toBe(true)
    expect(JobVerificationDispatchValiditySchema.safeParse({ ...validity, approvalConfig: { ...config, review },
      dispatchAt: '2026-10-04T12:59:00.000Z' }).success).toBe(false)
    expect(JobVerificationDispatchValiditySchema.safeParse({ ...validity, approvalConfig: { ...config, review },
      policy: { ...spec.policy, executionTimeoutMs: 9_000_000 } }).success).toBe(false)
  })
})

describe('verification reports and commit gates', () => {
  it('requires full reports and confirmed successful closure/publication rather than exit zero alone', () => {
    const { report, pass } = verificationFixture()
    expect(JobVerificationPassSchema.parse(pass).report).toEqual(report)
    for (const change of [{ firstPassFailed: 1 }, { disallowedSkipped: 1, totals: {
      total: 4, passed: 3, failed: 0, skipped: 1,
    } }, { completeness: 'partial', completedPortions: 0 }]) {
      expect(JobVerificationReportSchema.safeParse({ ...report, ...change }).success).toBe(false)
    }
    expect(JobVerificationPassSchema.safeParse({ ...pass, publication: 'pending' }).success).toBe(false)
    expect(JobVerificationPassSchema.safeParse({ ...pass, requiredOutputsVerified: false }).success).toBe(false)
    expect(JobVerificationPassSchema.safeParse({ ...pass, process: { ...pass.process, processStopped: false } }).success).toBe(false)
    for (const field of ['commit', 'definitionVersionId', 'attemptId', 'executionId'] as const) {
      expect(JobVerificationPassSchema.safeParse({ ...pass,
        expected: { ...pass.expected, [field]: field === 'commit' ? 'c'.repeat(40) : 'different' } }).success).toBe(false)
    }
    expect(JobVerificationPassSchema.safeParse({ ...pass, expected: { ...pass.expected,
      parameters: { ...pass.expected.parameters, integrationShards: 2 },
    } }).success).toBe(false)
  })
  it('keeps an honest partial failure report readable and never erases first-pass failures with a retest', () => {
    const { report } = verificationFixture()
    expect(JobVerificationReportSchema.parse({ ...report, firstPassFailed: 1, outcome: 'failed',
      completeness: 'partial', completedPortions: 0 }).outcome).toBe('failed')
    expect(JobVerificationReportSchema.safeParse({ ...report, totals: { ...report.totals, total: 5 } }).success).toBe(false)
  })
  it('requires every pinned child including native acceptance and rejects cross-commit/attempt aggregation', () => {
    const { pass, build } = verificationFixture()
    const step = { nodeId: 'unit-node', suite: 'unit', definitionId: 'definition', definitionRevision: 1,
      definitionVersionId: pass.report.definitionVersionId }
    const child = { nodeId: step.nodeId, suite: step.suite, definitionVersionId: step.definitionVersionId,
      ticketId: verificationId, executionId: pass.report.executionId, attemptId: pass.report.attemptId,
      outcome: 'passed', pass }
    const gate = { schemaVersion: 1, id: 'gate', runId: 'run', outcome: 'passed',
      plan: { schemaVersion: 1, workflowId: 'workflow', workflowVersionId: 'workflow-version', source: build.source,
        requiredSteps: [step] }, children: [child] }
    expect(JobVerificationGateResultSchema.parse(gate).outcome).toBe('passed')
    const native = { ...step, nodeId: 'native-node', suite: 'native-acceptance', definitionVersionId: 'native-version' }
    expect(JobVerificationGateResultSchema.safeParse({ ...gate, plan: {
      ...gate.plan, requiredSteps: [step, native],
    } }).success).toBe(false)
    expect(JobVerificationGateResultSchema.safeParse({ ...gate, children: [{ ...child, attemptId: 'other' }] }).success).toBe(false)
    expect(JobVerificationGateResultSchema.safeParse({ ...gate, plan: {
      ...gate.plan, source: { ...build.source, commit: 'c'.repeat(40) },
    } }).success).toBe(false)
  })
})
