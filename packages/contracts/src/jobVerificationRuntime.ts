import { z } from 'zod'
import { DeviceDigestSchema, DeviceSafeIntegerSchema } from './deviceResources.js'
import {
  ProvisionedJobRuntimeFingerprintSchema, JOB_RUNTIME_WORKSPACE_LAYOUT, JobRuntimeMeasurementSchema,
  JobRuntimeProfileSchema, JobRuntimeFingerprintSchema,
} from './jobRuntime.js'
import { JobVerificationSuiteSchema } from './jobVerification.js'
import {
  JobNetworkPolicySchema, JobResourceRequestSchema, JobVerificationApprovalConfigInputSchema,
  JobVerificationApprovalConfigSchema, JobVerificationPolicyRequirementsSchema, JobVerificationProfileIdentitySchema,
} from './jobVerificationPolicy.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'

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
export const JobVerificationRuntimeFingerprintSchema = z.object({
  ...ProvisionedJobRuntimeFingerprintSchema.shape,
  schemaVersion: z.literal(3),
  workspaceLayout: z.literal(JOB_RUNTIME_WORKSPACE_LAYOUT),
  network: JobNetworkPolicySchema,
  resources: JobResourceRequestSchema,
  approvalConfig: JobVerificationApprovalConfigSchema,
  tools: z.array(ToolIdentity).max(16),
}).strict().superRefine((value, context) => {
  const buildFingerprint = Object.fromEntries(Object.keys(ProvisionedJobRuntimeFingerprintSchema.shape)
    .map(key => [key, value[key as keyof typeof value]]))
  const baseline = ProvisionedJobRuntimeFingerprintSchema.safeParse({ ...buildFingerprint, schemaVersion: 2 })
  if (!baseline.success || JSON.stringify(value.limits) !== JSON.stringify(value.resources.limits)) {
    context.addIssue({ code: 'custom', message: 'Verification retains enforced build geometry and its measured reservation.' })
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
export const JobRuntimeFingerprintRecordSchema = z.union([
  JobRuntimeFingerprintSchema, JobVerificationRuntimeFingerprintSchema,
])
export const JobVerificationProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: IdSchema, workspaceId: IdSchema, revision: DeviceSafeIntegerSchema.positive(),
  name: JobRuntimeProfileSchema.shape.name,
  root: JobRuntimeProfileSchema.shape.root,
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
