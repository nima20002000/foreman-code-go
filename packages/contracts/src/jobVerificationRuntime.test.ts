import { describe, expect, it } from 'vitest'
import { JOB_RUNTIME_PROVISIONING_SUITE, JOB_RUNTIME_WORKSPACE_LAYOUT } from './jobRuntime.js'
import {
  JobVerificationProfileInputSchema, JobVerificationRuntimeMeasurementSchema,
  JOB_VERIFICATION_BASE_CHECKS, JOB_VERIFICATION_EGRESS_CHECKS,
} from './jobVerificationRuntime.js'
import { verificationFixture, verificationId, verificationTime, verificationDigest } from '../tests/helpers/jobVerification.js'

function measurementFixture() {
  const { build, resources, profile } = verificationFixture()
  const id = verificationId
  const digest = verificationDigest
  const gib = 2 ** 30
  const root = {
    version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
    selection: { hostRef: build.target.hostRef, rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: id, deviceId: null, workerInstallationId: null, workspaceId: 'workspace', rootId: id,
      bindingRevision: 1, locationRevision: 1, canonicalPath: '/approved/source',
      filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', registration: null,
    attestationId: 'attestation', attestationDigest: digest, boundAt: verificationTime,
  }
  const fingerprint = {
    schemaVersion: 3, profileId: profile.profileId, profileRevision: 1, specDigest: digest,
    hostRef: build.target.hostRef, registration: null, mainInstallationId: id, bootId: id, root,
    runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest, ociExecutable: '/usr/bin/crun', ociBinarySha256: digest,
    configurationDigest: digest, imageDigest: build.policy.imageDigest, toolchainDigest: digest,
    limits: resources.limits, workspaceLayout: JOB_RUNTIME_WORKSPACE_LAYOUT,
    resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
    provisioningSuite: JOB_RUNTIME_PROVISIONING_SUITE,
    deviceLimits: { cpuLimit: 4, memoryBytes: 8 * gib, pidsLimit: 1024, diskBytes: 64 * gib },
    quota: {
      volumeId: id, mountIdentityDigest: digest, volumeCapacityBytes: 64 * gib,
      growthMode: 'filesystem-project-quota', reservedHostBytes: gib, controlProjectId: 1, workloadProjectId: 2,
      controlHardLimitBytes: gib, controlUsageBytes: 0, workloadHardLimitBytes: 63 * gib, workloadUsageBytes: 0,
      controlHardInodes: 1000, controlUsedInodes: 0, workloadHardInodes: 1_000_000, workloadUsedInodes: 0,
      quotaRevision: 1, quotaDigest: digest, accountingEnabled: true, enforcementEnabled: true,
      inheritanceVerified: true, rootlessAccountingVerified: true,
    },
    aggregateCgroupIdentityDigest: digest, imageManifestDigest: `sha256:${digest}`, imageConfigDigest: `sha256:${digest}`,
    network: profile.network, resources,
    approvalConfig: { schemaVersion: 1, revision: 1, approvalLifetimeMs: 3_600_000,
      review: { reviewedByPrincipalId: 'owner', reviewedAt: verificationTime, decisionDigest: digest } },
    tools: [],
  }
  const checkIds = [...JOB_VERIFICATION_BASE_CHECKS, 'network-none']
  return {
    schemaVersion: 2, identity: profile, fingerprint, origin: 'real-runtime', approvedAt: verificationTime,
    checkedAt: verificationTime, expiresAt: profile.qualificationExpiresAt,
    checks: checkIds.map(id => ({ id, passed: true, evidenceDigest: digest })),
    suites: [{ suite: 'unit', resources, coldCachePeakBytes: gib, coldCachePeakInodes: 1000,
      maxConcurrentHeavyJobs: 1, maxUnitWorkers: 1, maxIntegrationShards: 1, evidenceDigest: digest }],
  }
}

describe('verification profile qualification contracts', () => {
  it('keeps save input separate from human review and worker-produced measurements', () => {
    const { spec, resources } = verificationFixture()
    const { isolationPolicyId, isolationPolicyRevision, ...policy } = spec.policy
    expect(isolationPolicyId).toBe('profile')
    expect(isolationPolicyRevision).toBe(1)
    const input = { rootId: verificationId, bindingRevision: 1, resources, policy,
      suites: ['unit'], approvalConfig: { approvalLifetimeMs: 3_600_000 } }
    expect(JobVerificationProfileInputSchema.parse(input)).toEqual(input)
    for (const field of ['ready', 'measurement', 'approvedByPrincipalId']) {
      expect(JobVerificationProfileInputSchema.safeParse({ ...input, [field]: true }).success).toBe(false)
    }
    expect(JobVerificationProfileInputSchema.safeParse({ ...input, suites: ['unit', 'unit'] }).success).toBe(false)
    expect(JobVerificationProfileInputSchema.safeParse({ ...input,
      policy: { ...policy, environmentScopeRefs: ['owner-login'] } }).success).toBe(false)
  })
  it('requires the extended checks and preserves bounded validity for ordinary verification', () => {
    const measurement = measurementFixture()
    expect(JobVerificationRuntimeMeasurementSchema.parse(measurement)).toEqual(measurement)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
      checks: measurement.checks.filter(check => check.id !== 'failure-publication') }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
      identity: { ...measurement.identity, qualificationExpiresAt: '2026-10-04T14:00:00.000Z' } }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
      fingerprint: { ...measurement.fingerprint, approvalConfig: {
        ...measurement.fingerprint.approvalConfig, review: null,
      } } }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement, suites: [{
      ...measurement.suites[0], coldCachePeakInodes: measurement.fingerprint.resources.mutableInodes + 1,
    }] }).success).toBe(false)
  })
  it('requires every egress bypass check and the same mode in the approved fingerprint', () => {
    const measurement = measurementFixture()
    const network = { schemaVersion: 2, mode: 'registry-only', enforcement: {
      implementation: 'reviewed-worker-component', version: '1', destinationPolicyDigest: verificationDigest,
    } }
    const checkIds = [...JOB_VERIFICATION_BASE_CHECKS, ...JOB_VERIFICATION_EGRESS_CHECKS, 'registry-allowlist']
    const egress = { ...measurement, identity: { ...measurement.identity, network },
      fingerprint: { ...measurement.fingerprint, network },
      checks: checkIds.map(id => ({ id, passed: true, evidenceDigest: verificationDigest })) }
    expect(JobVerificationRuntimeMeasurementSchema.safeParse(egress).success).toBe(true)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...egress,
      checks: egress.checks.filter(check => check.id !== 'main-device-denied') }).success).toBe(false)
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...egress,
      fingerprint: measurement.fingerprint }).success).toBe(false)
    const publicNetwork = { ...network, mode: 'public-egress' }
    expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...egress,
      identity: { ...egress.identity, network: publicNetwork },
      fingerprint: { ...egress.fingerprint, network: publicNetwork },
    }).success).toBe(false)
  })
  it('cannot qualify native or browser suites by relabeling an ordinary runtime', () => {
    const measurement = measurementFixture()
    for (const suite of ['integration', 'browser', 'native-acceptance']) {
      expect(JobVerificationRuntimeMeasurementSchema.safeParse({ ...measurement,
        suites: [{ ...measurement.suites[0], suite }] }).success).toBe(false)
    }
  })
})
