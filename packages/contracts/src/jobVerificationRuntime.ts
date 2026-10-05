import { z } from 'zod'
import { DeviceDigestSchema, DeviceSafeIntegerSchema, DeviceExecutionAdmissionFields } from './deviceResources.js'
import {
  ProvisionedJobRuntimeFingerprintSchema, JOB_RUNTIME_WORKSPACE_LAYOUT, JobRuntimeMeasurementSchema,
  JobRuntimeProfileSchema, JobRuntimeFingerprintSchema,
  JobRuntimeApprovalSchema, JobQualificationCandidateSchema, ProvisionedJobQualificationCandidateSchema,
  ProvisionedInstalledJobRuntimeDescriptorSchema, JobRuntimeNativeAdmissionSchema,
  JobRuntimeQualificationResultSchema, JobRuntimeQualificationRpcRequestSchema,
  JobRuntimeQualificationRpcResponseSchema,
  JobRuntimeProfileSaveSchema,
  InstalledJobRuntimeDescriptorSchema,
  ProvisionedQualifiedJobRuntimeSchema, validateProvisionedRuntime,
  ProvisionedJobRuntimeQualificationRpcRequestSchema, ProvisionedJobRuntimeQualificationRpcResponseSchema,
  validateJobRuntimeNativeContext,
} from './jobRuntime.js'
import { JobVerificationSuiteSchema, JobVerificationPassSchema } from './jobVerification.js'
import {
  JobNetworkPolicySchema, JobResourceRequestSchema, JobVerificationApprovalConfigInputSchema,
  JobVerificationApprovalConfigSchema, JobVerificationPolicyRequirementsSchema, JobVerificationProfileIdentitySchema,
} from './jobVerificationPolicy.js'
import { SourceProjectQuotaSlotSchema } from './sourceMaterialization.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
export { JobVerificationOfflineSeedReceiptSchema, type JobVerificationOfflineSeedReceipt } from './jobVerificationSeed.js'

/** W09 authenticates these private repository facts before the worker constructs the read-only context. */
export const JobVerificationPrivateGitSchema = z.object({
  sourceCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  generatedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  repositoryReceiptDigest: DeviceDigestSchema,
  configDigest: DeviceDigestSchema,
  indexDigest: DeviceDigestSchema,
}).strict()

export const JobVerificationPreseedFactsSchema = z.object({
  lockfileSha256: DeviceDigestSchema,
  pnpmVersion: z.literal('11.27.0'),
  platform: z.literal('linux'),
  architecture: z.literal('x64'),
  provenanceDigest: DeviceDigestSchema,
  minimumReleaseAgeMinutes: z.literal(2880),
  releaseAgeVerified: z.literal(true),
}).strict()
export const JobVerificationRepositoryContextSchema = z.object({
  identity: JobVerificationPassSchema.shape.expected,
  privateGit: JobVerificationPrivateGitSchema,
  executionTimeoutMs: DeviceSafeIntegerSchema.positive(),
  cancellationTimeoutMs: DeviceSafeIntegerSchema.positive(),
  qualifiedUnitWorkers: DeviceSafeIntegerSchema.min(1).max(256),
  limits: z.object({ summaryBytes: DeviceSafeIntegerSchema.positive(), junitBytes: DeviceSafeIntegerSchema.positive(),
    vitestBytes: DeviceSafeIntegerSchema.positive(), logsArchiveBytes: DeviceSafeIntegerSchema.positive(),
    logBytes: DeviceSafeIntegerSchema.positive() }).strict(),
  mutableDirectory: z.literal('/job-scratch'), storeDirectory: z.literal('/job-scratch/pnpm-store'),
  preseedReceipt: JobVerificationPreseedFactsSchema,
  unitCodex: z.object({ executable: z.literal('/opt/graphql-ci/tools/codex'),
    binarySha256: DeviceDigestSchema, version: IdSchema }).strict().optional(),
}).strict()

export const JobVerificationProfileInputSchema = z.object({
  rootId: z.uuid(),
  bindingRevision: DeviceSafeIntegerSchema.positive(),
  resources: JobResourceRequestSchema,
  policy: JobVerificationPolicyRequirementsSchema,
  suites: z.array(JobVerificationSuiteSchema).min(1).max(9),
  approvalConfig: JobVerificationApprovalConfigInputSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.suites).size !== value.suites.length || value.policy.environmentScopeRefs.length) {
    context.addIssue({ code: 'custom', message: 'Profiles declare unique suites and never inherit credential environments.' })
  }
  if (value.policy.network.mode === 'public-egress'
    && value.suites.some(suite => suite !== 'native-acceptance' && suite !== 'full-gate-local')) {
    context.addIssue({ code: 'custom', message: 'Public egress is limited to approved acceptance profiles.' })
  }
  if (value.policy.maxOutputBytes > value.resources.reportBytes
    || value.policy.maxWorkerSpoolBytes > value.resources.spoolBytes) {
    context.addIssue({ code: 'custom', message: 'Profile output/spool limits must fit measured resource sub-budgets.' })
  }
})
export const JobVerificationProfileSaveSchema = z.object({
  commandId: IdSchema, id: IdSchema.optional(), expectedRevision: DeviceSafeIntegerSchema.positive().nullable(),
  name: z.string().trim().min(1).max(200), spec: JobVerificationProfileInputSchema,
}).strict()

const ToolIdentity = z.object({
  kind: z.enum(['postgresql', 'browser', 'codex', 'opencode']),
  executable: z.string().startsWith('/').max(1024),
  version: IdSchema,
  binarySha256: DeviceDigestSchema,
}).strict()
/** Version 3 belongs to verification; saved build fingerprints retain their original version and evidence. */
export const JobVerificationQuotaPoolSchema = z.object({
  queryExecutable: z.string().startsWith('/').max(2048), queryBinarySha256: DeviceDigestSchema,
  blockDevice: z.string().startsWith('/dev/').max(2048),
  volumeCapacityInodes: DeviceSafeIntegerSchema.positive(),
  slots: z.array(SourceProjectQuotaSlotSchema).min(1).max(64),
}).strict().superRefine((value, context) => {
  if (new Set(value.slots.map(slot => slot.namespace)).size !== value.slots.length
    || new Set(value.slots.map(slot => slot.projectId)).size !== value.slots.length) {
    context.addIssue({ code: 'custom', message: 'Quota slots require distinct namespaces and project identities.' })
  }
})
export type JobVerificationQuotaPool = z.infer<typeof JobVerificationQuotaPoolSchema>
export const JobVerificationRuntimeFingerprintSchema = z.object({
  ...ProvisionedJobRuntimeFingerprintSchema.shape,
  schemaVersion: z.literal(3),
  workspaceLayout: z.literal(JOB_RUNTIME_WORKSPACE_LAYOUT),
  network: JobNetworkPolicySchema,
  resources: JobResourceRequestSchema,
  quotaPool: JobVerificationQuotaPoolSchema.optional(),
  approvalConfig: JobVerificationApprovalConfigSchema,
  tools: z.array(ToolIdentity).max(16),
  seedReceiptSha256: DeviceDigestSchema,
  sourceCommit: JobVerificationPrivateGitSchema.shape.sourceCommit.optional(),
}).strict().superRefine((value, context) => {
  const buildFingerprint = Object.fromEntries(Object.keys(ProvisionedJobRuntimeFingerprintSchema.shape)
    .map(key => [key, value[key as keyof typeof value]]))
  const baseline = ProvisionedJobRuntimeFingerprintSchema.safeParse({ ...buildFingerprint, schemaVersion: 2 })
  if (!baseline.success || JSON.stringify(value.limits) !== JSON.stringify(value.resources.limits)) {
    context.addIssue({ code: 'custom', message: 'Verification retains enforced build geometry and its measured reservation.' })
  }
  if (value.quotaPool) {
    const slots = value.quotaPool.slots
    if (slots.some(slot => slot.projectId === value.quota.controlProjectId
      || slot.filesystem.device !== value.root.binding.filesystem.device
      || slot.filesystem.mountId !== value.root.binding.filesystem.mountId
      || slot.hardLimitBytes !== value.resources.limits.diskBytes
      || slot.hardInodes !== value.resources.mutableInodes)
      || slots.reduce((bytes, slot) => bytes + slot.hardLimitBytes, value.quota.controlHardLimitBytes)
        > Math.min(value.quota.volumeCapacityBytes, value.deviceLimits.diskBytes)
      || slots.reduce((inodes, slot) => inodes + slot.hardInodes, value.quota.controlHardInodes)
        > value.quotaPool.volumeCapacityInodes) {
      context.addIssue({ code: 'custom', message: 'Independent Job quotas and control storage must fit the installed volume.' })
    }
  }
  if (new Set(value.tools.map(tool => tool.kind)).size !== value.tools.length) {
    context.addIssue({ code: 'custom', message: 'Tool identities must be unique.' })
  }
})

export const JOB_VERIFICATION_BASE_CHECKS = [
  'rootless', 'cgroup-v2', 'filesystem-quota', 'descendant-containment', 'image-toolchain',
  'credential-isolation', 'private-git-scheduler', 'executable-scratch', 'private-shm',
  'resource-headroom', 'report-publication', 'failure-publication', 'descendant-cancellation',
  'package-release-age',
] as const
export const JOB_VERIFICATION_EGRESS_CHECKS = [
  'direct-ip-denied', 'redirect-policy', 'dns-rebinding-denied', 'ipv6-policy',
  'host-gateway-denied', 'private-link-local-denied', 'main-device-denied',
] as const
const CheckId = z.enum([
  ...JOB_VERIFICATION_BASE_CHECKS, ...JOB_VERIFICATION_EGRESS_CHECKS,
  'network-none', 'registry-allowlist', 'public-egress-policy', 'postgres-isolation', 'browser-sandbox',
  'native-containment', 'credential-redaction',
])
export const JobVerificationRuntimeMeasurementSchema = z.object({
  schemaVersion: z.literal(2),
  identity: JobVerificationProfileIdentitySchema,
  fingerprint: JobVerificationRuntimeFingerprintSchema,
  origin: z.literal('real-runtime'),
  approvedAt: TimestampSchema,
  checkedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  checks: z.array(z.object({ id: CheckId, passed: z.literal(true), evidenceDigest: DeviceDigestSchema }).strict())
    .min(JOB_VERIFICATION_BASE_CHECKS.length + 1).max(32),
  suites: z.array(z.object({
    suite: JobVerificationSuiteSchema,
    resources: JobResourceRequestSchema,
    coldCachePeakBytes: DeviceSafeIntegerSchema.positive(),
    coldCachePeakInodes: DeviceSafeIntegerSchema.positive(),
    maxConcurrentHeavyJobs: DeviceSafeIntegerSchema.positive(),
    maxUnitWorkers: DeviceSafeIntegerSchema.min(1).max(256),
    maxIntegrationShards: DeviceSafeIntegerSchema.min(1).max(12),
    evidenceDigest: DeviceDigestSchema,
  }).strict()).min(1).max(9),
}).strict().superRefine((value, context) => {
  const { identity, fingerprint } = value
  if (identity.profileId !== fingerprint.profileId || identity.profileRevision !== fingerprint.profileRevision
    || identity.rootId !== fingerprint.root.binding.rootId
    || identity.bindingRevision !== fingerprint.root.binding.bindingRevision
    || identity.imageDigest !== fingerprint.imageDigest || identity.toolchainDigest !== fingerprint.toolchainDigest
    || JSON.stringify(identity.network) !== JSON.stringify(fingerprint.network)
    || value.expiresAt !== identity.qualificationExpiresAt
    || Date.parse(value.checkedAt) < Date.parse(value.approvedAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.checkedAt)
    || !fingerprint.approvalConfig.review
    || Date.parse(identity.approvalExpiresAt) - Date.parse(value.approvedAt) > fingerprint.approvalConfig.approvalLifetimeMs) {
    context.addIssue({ code: 'custom', message: 'Measurement must match its original reviewed fingerprint and approval lifetime.' })
  }
  const checks = new Set(value.checks.map(check => check.id))
  const required: z.infer<typeof CheckId>[] = [...JOB_VERIFICATION_BASE_CHECKS]
  if (identity.network.mode === 'none') required.push('network-none')
  else {
    required.push(...JOB_VERIFICATION_EGRESS_CHECKS)
    required.push(identity.network.mode === 'registry-only' ? 'registry-allowlist' : 'public-egress-policy')
  }
  for (const suite of value.suites) {
    if (identity.network.mode === 'public-egress'
      && suite.suite !== 'native-acceptance' && suite.suite !== 'full-gate-local') {
      context.addIssue({ code: 'custom', message: 'Public egress qualification is limited to approved acceptance suites.' })
    }
    if (suite.suite === 'integration' || suite.suite === 'native-acceptance' || suite.suite === 'full-gate-local') {
      required.push('postgres-isolation')
      if (!fingerprint.tools.some(tool => tool.kind === 'postgresql' && /^17(?:\.|$)/.test(tool.version))) {
        context.addIssue({ code: 'custom', message: 'Database suites require a measured PostgreSQL 17 identity.' })
      }
    }
    if (suite.suite === 'browser') required.push('browser-sandbox')
    if (suite.suite === 'native-acceptance' || suite.suite === 'full-gate-local') {
      required.push('native-containment', 'credential-redaction')
      if (!['codex', 'opencode'].every(kind => fingerprint.tools.some(tool => tool.kind === kind))) {
        context.addIssue({ code: 'custom', message: 'Native acceptance requires both pinned harness binaries.' })
      }
    }
    if (suite.suite === 'browser' && !fingerprint.tools.some(tool => tool.kind === 'browser')) {
      context.addIssue({ code: 'custom', message: 'Browser suites require a pinned browser identity.' })
    }
    if (suite.coldCachePeakBytes > suite.resources.limits.diskBytes
      || suite.coldCachePeakInodes > suite.resources.mutableInodes
      || suite.resources.mutableInodes > fingerprint.resources.mutableInodes
      || (Object.keys(suite.resources.limits) as (keyof typeof suite.resources.limits)[])
        .some(field => suite.resources.limits[field] > fingerprint.resources.limits[field])) {
      context.addIssue({ code: 'custom', message: 'Cold-cache peaks exceed the measured suite reservation.' })
    }
  }
  if (checks.size !== value.checks.length || required.some(check => !checks.has(check))
    || new Set(value.suites.map(suite => suite.suite)).size !== value.suites.length) {
    context.addIssue({ code: 'custom', message: 'Every declared suite and network mode requires its measured checks.' })
  }
})
export type JobVerificationRuntimeMeasurement = z.infer<typeof JobVerificationRuntimeMeasurementSchema>
export type JobVerificationProfileInput = z.infer<typeof JobVerificationProfileInputSchema>
export const JobRuntimeMeasurementRecordSchema = z.union([
  JobRuntimeMeasurementSchema, JobVerificationRuntimeMeasurementSchema,
])
export type JobRuntimeMeasurementRecord = z.infer<typeof JobRuntimeMeasurementRecordSchema>
export const JobRuntimeFingerprintRecordSchema = z.union([
  JobRuntimeFingerprintSchema, JobVerificationRuntimeFingerprintSchema,
])
export type JobRuntimeFingerprintRecord = z.infer<typeof JobRuntimeFingerprintRecordSchema>
export const JobVerificationProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: IdSchema, workspaceId: IdSchema, revision: DeviceSafeIntegerSchema.positive(),
  name: JobRuntimeProfileSchema.shape.name,
  root: JobRuntimeProfileSchema.shape.root,
  sourceCommit: JobVerificationPrivateGitSchema.shape.sourceCommit.optional(),
  spec: JobVerificationProfileInputSchema,
  specDigest: DeviceDigestSchema,
  approvalConfig: JobVerificationApprovalConfigSchema,
  status: JobRuntimeProfileSchema.shape.status,
  measurement: JobVerificationRuntimeMeasurementSchema.nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.root.binding.rootId !== value.spec.rootId
    || value.root.binding.bindingRevision !== value.spec.bindingRevision
    || value.approvalConfig.approvalLifetimeMs !== value.spec.approvalConfig.approvalLifetimeMs
    || (value.measurement && (value.measurement.identity.profileId !== value.id
      || value.measurement.identity.profileRevision !== value.revision))) {
    context.addIssue({ code: 'custom', message: 'Profile history retains its saved root, approval config and qualification identity.' })
  }
  if (value.status === 'qualified' && !value.measurement) {
    context.addIssue({ code: 'custom', message: 'Qualified verification profiles require measured evidence.' })
  }
  if (value.measurement) {
    const fingerprint = value.measurement.fingerprint
    const measuredSuites = new Set(value.measurement.suites.map(suite => suite.suite))
    if (fingerprint.specDigest !== value.specDigest || fingerprint.imageDigest !== value.spec.policy.imageDigest
      || fingerprint.sourceCommit !== value.sourceCommit
      || fingerprint.toolchainDigest !== value.spec.policy.toolchainDigest
      || JSON.stringify(fingerprint.root) !== JSON.stringify(value.root)
      || JSON.stringify(fingerprint.network) !== JSON.stringify(value.spec.policy.network)
      || JSON.stringify(fingerprint.resources) !== JSON.stringify(value.spec.resources)
      || JSON.stringify(fingerprint.approvalConfig) !== JSON.stringify(value.approvalConfig)
      || measuredSuites.size !== value.spec.suites.length || value.spec.suites.some(suite => !measuredSuites.has(suite))) {
      context.addIssue({ code: 'custom', message: 'Qualification must cover the saved profile, policy, resources and every suite.' })
    }
  }
})
export const JobRuntimeProfileRecordSchema = z.union([JobRuntimeProfileSchema, JobVerificationProfileSchema])
export type JobRuntimeProfileRecord = z.infer<typeof JobRuntimeProfileRecordSchema>
export type JobVerificationProfile = z.infer<typeof JobVerificationProfileSchema>
export function jobRuntimeProfilePolicy(profile: JobRuntimeProfileRecord) {
  if (profile.schemaVersion === 1) return profile.policy
  return { ...profile.spec.policy, isolationPolicyId: profile.id, isolationPolicyRevision: profile.revision }
}
export function jobRuntimeProfileLimits(profile: JobRuntimeProfileRecord) {
  return profile.schemaVersion === 1 ? profile.limits : profile.spec.resources.limits
}
export function jobRuntimeQualificationId(profile: JobRuntimeProfileRecord): string | null {
  if (!profile.measurement) return null
  return profile.schemaVersion === 1 ? profile.measurement.qualificationId : profile.measurement.identity.qualificationId
}
export const JobRuntimeProfileSaveRecordSchema = JobRuntimeProfileSaveSchema.extend({
  spec: z.union([JobRuntimeProfileSaveSchema.shape.spec, JobVerificationProfileInputSchema]),
}).strict()
export type JobRuntimeProfileSaveRecord = z.infer<typeof JobRuntimeProfileSaveRecordSchema>

export const JobVerificationRuntimeApprovalSchema = z.object({
  ...JobRuntimeApprovalSchema.shape,
  schemaVersion: z.literal(2),
  fingerprint: JobVerificationRuntimeFingerprintSchema,
  requestedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  const fingerprint = value.fingerprint
  if (value.profileId !== fingerprint.profileId || value.profileRevision !== fingerprint.profileRevision
    || value.workspaceId !== fingerprint.root.binding.workspaceId || !fingerprint.approvalConfig.review
    || Date.parse(value.expiresAt) - Date.parse(value.requestedAt) !== fingerprint.approvalConfig.approvalLifetimeMs
    || (value.approvedAt !== null && Date.parse(value.approvedAt) < Date.parse(value.requestedAt))) {
    context.addIssue({ code: 'custom', message: 'Verification approval retains its reviewed configuration and fingerprint.' })
  }
})
export const JobRuntimeApprovalRecordSchema = z.union([JobRuntimeApprovalSchema, JobVerificationRuntimeApprovalSchema])
export type JobRuntimeApprovalRecord = z.infer<typeof JobRuntimeApprovalRecordSchema>

export const JobVerificationQualificationCandidateSchema = z.object({
  ...ProvisionedJobQualificationCandidateSchema.shape,
  fingerprint: JobVerificationRuntimeFingerprintSchema,
  profile: JobVerificationProfileSchema,
  approvedAt: TimestampSchema,
}).strict().superRefine((value, context) => {
  const fingerprint = value.fingerprint
  const profile = value.profile
  if (profile.id !== fingerprint.profileId || profile.revision !== fingerprint.profileRevision
    || profile.specDigest !== fingerprint.specDigest || profile.sourceCommit !== fingerprint.sourceCommit
    || JSON.stringify(profile.root) !== JSON.stringify(fingerprint.root)
    || JSON.stringify(profile.spec.resources) !== JSON.stringify(fingerprint.resources)
    || JSON.stringify(profile.spec.policy.network) !== JSON.stringify(fingerprint.network)
    || JSON.stringify(profile.approvalConfig) !== JSON.stringify(fingerprint.approvalConfig)) {
    context.addIssue({ code: 'custom', message: 'Qualification must retain its complete immutable verification profile.' })
  }
  if (value.sourceParent !== fingerprint.root.binding.canonicalPath
    || fingerprint.root.binding.accessMode !== 'exclusive-write'
    || value.operationId !== value.qualificationId
    || value.volumeCapacityBytes !== fingerprint.quota.volumeCapacityBytes
    || (value.backingFile === null) !== (value.backingBytes === null)
    || value.backingFile === null && fingerprint.quota.growthMode !== 'filesystem-project-quota'
    || value.backingBytes !== null && value.backingBytes !== value.volumeCapacityBytes
    || value.ttlSeconds * 1000 > fingerprint.approvalConfig.approvalLifetimeMs) {
    context.addIssue({ code: 'custom', message: 'Verification candidate retains the original approved operation and quota.' })
  }
})
export const JobQualificationCandidateRecordSchema = z.union([
  JobQualificationCandidateSchema, ProvisionedJobQualificationCandidateSchema, JobVerificationQualificationCandidateSchema,
])
export type JobQualificationCandidateRecord = z.infer<typeof JobQualificationCandidateRecordSchema>

export const JobVerificationInstalledRuntimeDescriptorSchema = ProvisionedInstalledJobRuntimeDescriptorSchema.safeExtend({
  resources: JobResourceRequestSchema,
  quotaPool: JobVerificationQuotaPoolSchema.optional(),
  network: JobNetworkPolicySchema,
  approvalConfig: JobVerificationApprovalConfigSchema,
}).strict()
export const JobVerificationRuntimeNativeAdmissionSchema = z.object({
  ...JobRuntimeNativeAdmissionSchema.shape,
  ...DeviceExecutionAdmissionFields,
  schemaVersion: z.literal(3),
}).strict().superRefine(validateJobRuntimeNativeContext)
export const InstalledJobRuntimeDescriptorRecordSchema = z.union([
  InstalledJobRuntimeDescriptorSchema, ProvisionedInstalledJobRuntimeDescriptorSchema,
  JobVerificationInstalledRuntimeDescriptorSchema,
])
export const JobRuntimeNativeAdmissionRecordSchema = z.union([
  JobRuntimeNativeAdmissionSchema, JobVerificationRuntimeNativeAdmissionSchema,
])
export type JobRuntimeNativeAdmissionRecord = z.infer<typeof JobRuntimeNativeAdmissionRecordSchema>
export const QualifiedVerificationJobRuntimeSchema = z.object({
  ...ProvisionedQualifiedJobRuntimeSchema.shape,
  network: JobNetworkPolicySchema,
}).strict().superRefine(validateProvisionedRuntime)
export const JobVerificationRuntimeQualificationResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('qualified'), measurement: JobVerificationRuntimeMeasurementSchema,
    runtime: QualifiedVerificationJobRuntimeSchema }).strict().superRefine((value, context) => {
    const { fingerprint, identity } = value.measurement
    if (value.runtime.policyId !== identity.profileId || value.runtime.policyRevision !== identity.profileRevision
      || value.runtime.qualificationId !== identity.qualificationId
      || value.runtime.imageDigest !== fingerprint.imageDigest || value.runtime.toolchainDigest !== fingerprint.toolchainDigest
      || JSON.stringify(value.runtime.network) !== JSON.stringify(fingerprint.network)
      || Object.keys(fingerprint.limits).some(field => Reflect.get(value.runtime, field) !== Reflect.get(fingerprint.limits, field))
      || JSON.stringify(value.runtime.quota) !== JSON.stringify(fingerprint.quota)
      || value.runtime.aggregateCgroupIdentityDigest !== fingerprint.aggregateCgroupIdentityDigest) {
      context.addIssue({ code: 'custom', message: 'Verification runtime must retain its measured profile and enforcement.' })
    }
  }),
  JobRuntimeQualificationResultSchema.options[1],
])
export const JobRuntimeQualificationResultRecordSchema = z.union([
  JobRuntimeQualificationResultSchema, JobVerificationRuntimeQualificationResultSchema,
])
export type JobRuntimeQualificationResultRecord = z.infer<typeof JobRuntimeQualificationResultRecordSchema>
export const JobVerificationRuntimeQualificationRpcRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(3), operation: z.literal('inspect'), profile: JobVerificationProfileSchema }).strict(),
  z.object({ version: z.literal(3), operation: z.enum(['run', 'authorize']),
    admission: JobVerificationRuntimeNativeAdmissionSchema, candidate: JobVerificationQualificationCandidateSchema }).strict(),
]).superRefine((value, context) => {
  if (value.operation === 'inspect') return
  const { admission, candidate } = value
  if (admission.approvalId !== candidate.approvalId || admission.qualificationId !== candidate.qualificationId
    || admission.operationId !== candidate.operationId || admission.profileId !== candidate.fingerprint.profileId
    || admission.profileRevision !== candidate.fingerprint.profileRevision
    || admission.workspaceId !== candidate.fingerprint.root.binding.workspaceId
    || Object.keys(DeviceExecutionAdmissionFields).some(field =>
      Reflect.get(admission, field) !== Reflect.get(candidate.fingerprint, field))) {
    context.addIssue({ code: 'custom', message: 'Verification transport retains the original admission and device authority.' })
  }
})
export const JobVerificationRuntimeQualificationRpcResponseSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(3), operation: z.literal('inspect'),
    descriptor: JobVerificationInstalledRuntimeDescriptorSchema,
    fingerprint: JobVerificationRuntimeFingerprintSchema }).strict(),
  z.object({ version: z.literal(3), operation: z.literal('run'), admission: JobVerificationRuntimeNativeAdmissionSchema,
    candidate: JobVerificationQualificationCandidateSchema, result: JobVerificationRuntimeQualificationResultSchema }).strict(),
  z.object({ version: z.literal(3), operation: z.literal('authorize'), admission: JobVerificationRuntimeNativeAdmissionSchema,
    candidate: JobVerificationQualificationCandidateSchema,
    approval: z.object({ status: z.literal('approved'), fingerprint: DeviceDigestSchema,
      expiresAt: TimestampSchema }).strict() }).strict(),
]).superRefine((value, context) => {
  if (value.operation === 'inspect') {
    const { descriptor, fingerprint } = value
    if (JSON.stringify(descriptor.target) !== JSON.stringify({ hostRef: fingerprint.hostRef,
      registration: fingerprint.registration, mainInstallationId: fingerprint.mainInstallationId })
      || JSON.stringify(descriptor.resources) !== JSON.stringify(fingerprint.resources)
      || JSON.stringify(descriptor.network) !== JSON.stringify(fingerprint.network)
      || JSON.stringify(descriptor.approvalConfig) !== JSON.stringify(fingerprint.approvalConfig)
      || JSON.stringify(descriptor.quota) !== JSON.stringify(fingerprint.quota)
      || descriptor.runtimeExecutable !== fingerprint.runtimeExecutable
      || descriptor.ociExecutable !== fingerprint.ociExecutable
      || descriptor.aggregateCgroupIdentityDigest !== fingerprint.aggregateCgroupIdentityDigest
      || Object.keys(DeviceExecutionAdmissionFields).some(field =>
        Reflect.get(descriptor, field) !== Reflect.get(fingerprint, field))) {
      context.addIssue({ code: 'custom', message: 'Installed descriptor must retain the captured verification configuration.' })
    }
    return
  }
  if (!JobVerificationRuntimeQualificationRpcRequestSchema.safeParse({ version: value.version,
    operation: value.operation, admission: value.admission, candidate: value.candidate }).success) {
    context.addIssue({ code: 'custom', message: 'Qualification response must retain its original admission and candidate.' })
  }
  if (value.operation === 'authorize') {
    if (value.approval.fingerprint !== value.admission.fingerprintDigest
      || value.approval.expiresAt !== value.admission.expiresAt) {
      context.addIssue({ code: 'custom', message: 'Qualification authorization cannot replace or renew the original approval.' })
    }
    return
  }
  if (value.result.outcome !== 'qualified') return
  const { measurement } = value.result
  if (measurement.identity.approvalId !== value.admission.approvalId
    || measurement.identity.qualificationId !== value.admission.qualificationId
    || measurement.identity.fingerprintDigest !== value.admission.fingerprintDigest
    || JSON.stringify(measurement.fingerprint) !== JSON.stringify(value.candidate.fingerprint)
    || Date.parse(measurement.expiresAt) > Date.parse(value.admission.expiresAt)) {
    context.addIssue({ code: 'custom', message: 'Measured verification cannot change its approved operation or lifetime.' })
  }
})
export const JobRuntimeQualificationRpcRequestRecordSchema = z.union([
  JobRuntimeQualificationRpcRequestSchema, ProvisionedJobRuntimeQualificationRpcRequestSchema,
  JobVerificationRuntimeQualificationRpcRequestSchema,
])
export const JobRuntimeQualificationRpcResponseRecordSchema = z.union([
  JobRuntimeQualificationRpcResponseSchema, ProvisionedJobRuntimeQualificationRpcResponseSchema,
  JobVerificationRuntimeQualificationRpcResponseSchema,
])
export const JobRuntimeProfileListRecordSchema = z.object({
  profiles: z.array(z.object({ profile: JobRuntimeProfileRecordSchema, ready: z.boolean(),
    reasons: z.array(z.string()), sideEffects: z.literal(false) }).strict()),
  approvals: z.array(JobRuntimeApprovalRecordSchema),
}).strict()
export const JobRuntimeQualificationReadRecordSchema = z.object({
  approval: JobRuntimeApprovalRecordSchema,
  nativeAdmission: z.union([JobRuntimeNativeAdmissionSchema, JobVerificationRuntimeNativeAdmissionSchema]).nullable(),
  measurement: JobRuntimeMeasurementRecordSchema.nullable(), profile: JobRuntimeProfileRecordSchema,
  readiness: z.object({ ready: z.boolean(), reasons: z.array(z.string()), sideEffects: z.literal(false) }).strict(),
}).strict()
