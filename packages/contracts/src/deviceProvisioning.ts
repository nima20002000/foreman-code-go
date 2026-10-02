import { z } from 'zod'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
import { WorkerIdentityRequestSchema } from './deviceSetup.js'
import { TimestampSchema } from './schemaPrimitives.js'
import type { ManagementAction } from './management/index.js'
import { DeviceCapacitySchema, DeviceCommandIdSchema, DeviceDigestSchema, DeviceProvisioningTargetSchema,
  DeviceReasonCodeSchema, DeviceResourceAdmissionSchema, DeviceResourcePolicySchema, DeviceRevisionSchema,
  DeviceSafeIntegerSchema, sameDeviceProvisioningTarget } from './deviceResources.js'
export * from './deviceResources.js'

export const DEVICE_PROVISIONING_EXTENSION = Object.freeze({ namespace: 'device-provisioning-v1', version: 1 as const,
  role: 'duplex' as const, maxJsonBytes: 65536, maxBinaryBytes: 0 })
export const DEVICE_READINESS_SAMPLE_SECONDS = 30
export const DEVICE_READINESS_EXPIRY_SECONDS = 90
export const DeviceProvisioningManagementActionSchema = z.enum(['settings:read', 'settings:update', 'devices:provision',
  'jobs:cancel', 'workspace_locations:update', 'source_roots:bind', 'harnesses:update']) satisfies z.ZodType<ManagementAction>
const Actions = z.array(DeviceProvisioningManagementActionSchema).max(7).refine(value => new Set(value).size === value.length, 'Actions must be unique.')
export const DeviceReadinessCheckIdSchema = z.enum(['runtime', 'toolchain', 'container-runtime', 'ci-image',
  'cgroup-cpu', 'cgroup-memory', 'cgroup-pids', 'storage', 'resource-policy', 'execution-authorization',
  'runtime-approval', 'workspace-roots', 'harness-dependencies'])
export const DeviceReadinessCheckStateSchema = z.enum(['unknown', 'checking', 'ready', 'missing', 'blocked', 'repairing', 'failed', 'stale', 'unsupported'])
export const DeviceFixActionIdSchema = z.enum(['check', 'restore-toolchain', 'prepare-ci-image', 'repair-user-service',
  'capture-runtime', 'apply-resource-policy', 'apply-resource-policy-now', 'install-system-prerequisites', 'enable-storage-quota',
  'approve-execution', 'approve-runtime', 'select-workspace-root', 'prepare-harness'])
export const DeviceFixActionSchema = z.object({ id: DeviceFixActionIdSchema, executor: z.enum(['worker', 'local-admin', 'human']),
  requiredActions: Actions, approvalRequired: z.boolean(), disruptive: z.boolean(), enabled: z.boolean(),
  disabledReason: DeviceReasonCodeSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.enabled === (value.disabledReason !== null))
    ctx.addIssue({ code: 'custom', message: 'Disabled actions need a safe reason; enabled actions must not have one.' })
  if (value.executor !== 'worker' && !value.approvalRequired)
    ctx.addIssue({ code: 'custom', message: 'Human and local administrator actions require explicit consent.' })
  if (['install-system-prerequisites', 'enable-storage-quota'].includes(value.id) && value.executor !== 'local-admin'
    || ['approve-execution', 'approve-runtime', 'select-workspace-root'].includes(value.id) && value.executor !== 'human')
    ctx.addIssue({ code: 'custom', message: 'Advertised actions cannot bypass their human/local administrator authority.' })
  if (value.id === 'apply-resource-policy-now' && (!value.disruptive || !value.approvalRequired
    || !value.requiredActions.includes('settings:update') || !value.requiredActions.includes('jobs:cancel')))
    ctx.addIssue({ code: 'custom', message: 'Apply now requires confirmation and the exact update/cancel permissions.' })
})
export const DeviceReadinessCheckSchema = z.object({ id: DeviceReadinessCheckIdSchema, state: DeviceReadinessCheckStateSchema,
  requiredFor: z.array(z.enum(['jobs', 'agents', 'files'])).max(3).refine(value => new Set(value).size === value.length),
  reasonCode: DeviceReasonCodeSchema.nullable(), checkedAt: TimestampSchema.nullable(), evidenceDigest: DeviceDigestSchema.nullable(),
  actions: z.array(DeviceFixActionSchema).max(13).refine(value => new Set(value.map(action => action.id)).size === value.length),
}).strict()
export const DeviceCapabilityStateSchema = z.object({ state: z.enum(['ready', 'preparing', 'blocked', 'unknown', 'unsupported']),
  reasons: z.array(DeviceReasonCodeSchema).max(32), workspaceQualificationRequired: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'ready' && (value.reasons.length || value.workspaceQualificationRequired))
    ctx.addIssue({ code: 'custom', message: 'Ready cannot claim missing authority or workspace qualification.' })
})
export const DeviceReadinessSummarySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), label: z.literal('Ready'), remainingSteps: z.literal(0), primaryAction: z.null() }).strict(),
  z.object({ state: z.literal('needs-steps'), label: z.string().regex(/^Needs [1-9][0-9]? steps?$/),
    remainingSteps: DeviceSafeIntegerSchema.min(1).max(32), primaryAction: DeviceFixActionSchema,
  }).strict().superRefine((value, ctx) => {
    if (value.label !== `Needs ${value.remainingSteps} ${value.remainingSteps === 1 ? 'step' : 'steps'}`)
      ctx.addIssue({ code: 'custom', path: ['label'], message: 'The one-line status must match its step count.' })
  }),
])
export const DeviceProvisioningStepIdSchema = z.enum(['verify-release', 'install-runtime', 'restore-toolchain',
  'install-system-prerequisites', 'repair-user-service', 'prepare-ci-image', 'enable-storage-quota', 'capture-runtime',
  'drain-work', 'stop-jobs', 'apply-resource-policy', 'verify-resource-policy', 'verify-readiness', 'pair-device'])
export const DeviceApprovalRequirementSchema = z.enum(['none', 'local-admin', 'human', 'local-admin-and-human'])
export const DeviceProvisioningPlanStepSchema = z.object({ id: DeviceProvisioningStepIdSchema,
  executor: z.enum(['worker', 'local-admin', 'human']), approvalRequirement: DeviceApprovalRequirementSchema,
}).strict().superRefine((value, ctx) => {
  if (['install-system-prerequisites', 'enable-storage-quota'].includes(value.id) && value.executor !== 'local-admin'
    || value.executor === 'local-admin' && !['local-admin', 'local-admin-and-human'].includes(value.approvalRequirement)
    || value.executor === 'human' && !['human', 'local-admin-and-human'].includes(value.approvalRequirement))
    ctx.addIssue({ code: 'custom', message: 'System setup cannot bypass local administrator approval.' })
})
export const DeviceRepairPlanSchema = z.object({ planId: z.uuid(), target: DeviceProvisioningTargetSchema, planDigest: DeviceDigestSchema,
  expectedGeneration: DeviceSafeIntegerSchema, actionIds: z.array(DeviceFixActionIdSchema).min(1).max(13).refine(value => new Set(value).size === value.length),
  expiresAt: TimestampSchema, requiredActions: Actions, approvalRequirement: DeviceApprovalRequirementSchema, disruptive: z.boolean(),
  downloadBytes: DeviceSafeIntegerSchema, minimumFreeBytes: DeviceSafeIntegerSchema,
  steps: z.array(DeviceProvisioningPlanStepSchema).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.steps.map(step => step.id)).size !== value.steps.length)
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Plan steps must be unique.' })
  if (value.steps.some(step => step.executor === 'local-admin') && !['local-admin', 'local-admin-and-human'].includes(value.approvalRequirement)
    || value.steps.some(step => step.executor === 'human') && !['human', 'local-admin-and-human'].includes(value.approvalRequirement))
    ctx.addIssue({ code: 'custom', message: 'The plan must disclose its local/human approval requirement.' })
})
export const DeviceProvisioningOperationStateSchema = z.enum(['planned', 'awaiting-local-admin', 'awaiting-human-approval',
  'queued', 'running', 'verifying', 'succeeded', 'failed', 'recovery-required'])
export const DeviceProvisioningOperationSchema = z.object({ operationId: z.uuid(), target: DeviceProvisioningTargetSchema,
  commandId: DeviceCommandIdSchema, planId: z.uuid().nullable(), state: DeviceProvisioningOperationStateSchema,
  progress: z.object({ stepId: DeviceProvisioningStepIdSchema, completedBytes: DeviceSafeIntegerSchema,
    totalBytes: DeviceSafeIntegerSchema.nullable() }).strict().nullable(), reasonCode: DeviceReasonCodeSchema.nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, completedAt: TimestampSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.progress?.totalBytes !== null && value.progress?.totalBytes !== undefined && value.progress.completedBytes > value.progress.totalBytes)
    ctx.addIssue({ code: 'custom', path: ['progress'], message: 'Progress cannot exceed its declared total.' })
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt) || value.completedAt && Date.parse(value.completedAt) < Date.parse(value.createdAt))
    ctx.addIssue({ code: 'custom', message: 'Operation timestamps must retain their causal order.' })
  if (['succeeded', 'failed'].includes(value.state) !== (value.completedAt !== null))
    ctx.addIssue({ code: 'custom', message: 'Only a completed operation has a completion timestamp.' })
  if (['failed', 'recovery-required', 'awaiting-local-admin', 'awaiting-human-approval'].includes(value.state) && !value.reasonCode)
    ctx.addIssue({ code: 'custom', message: 'Blocked or failed preparation needs a sanitized reason.' })
})
/** Once per exact device/installation. Revocation fences new work, without rewriting old Job facts. */
export const DeviceRuntimeApprovalSchema = z.object({ schemaVersion: z.literal(1), approvalId: z.uuid(), target: DeviceProvisioningTargetSchema,
  revision: DeviceRevisionSchema, status: z.enum(['awaiting-approval', 'approved', 'revoked']),
  requestedByPrincipalId: z.string().min(1).max(200), requestedAt: TimestampSchema,
  approvedByPrincipalId: z.string().min(1).max(200).nullable(), approvedAt: TimestampSchema.nullable(),
  revokedByPrincipalId: z.string().min(1).max(200).nullable(), revokedAt: TimestampSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.approvedAt === null) !== (value.approvedByPrincipalId === null)
    || (value.revokedAt === null) !== (value.revokedByPrincipalId === null)
    || value.status === 'awaiting-approval' && (value.approvedAt !== null || value.revokedAt !== null)
    || value.status === 'approved' && (value.approvedAt === null || value.revokedAt !== null)
    || value.status === 'revoked' && value.revokedAt === null)
    ctx.addIssue({ code: 'custom', message: 'Runtime approval must retain the actual human decision/revocation.' })
  if (value.approvedAt && Date.parse(value.approvedAt) < Date.parse(value.requestedAt)
    || value.revokedAt && Date.parse(value.revokedAt) < Date.parse(value.approvedAt ?? value.requestedAt))
    ctx.addIssue({ code: 'custom', message: 'Runtime approval timestamps must retain their causal order.' })
})
export const DeviceReadinessSchema = z.object({ schemaVersion: z.literal(1), target: DeviceProvisioningTargetSchema,
  binding: DeviceSessionBindingSchema.nullable(), bootId: z.uuid().nullable(), generation: DeviceSafeIntegerSchema,
  observedAt: TimestampSchema.nullable(), expiresAt: TimestampSchema.nullable(), connection: z.enum(['online', 'offline', 'unknown', 'revoked']),
  summary: DeviceReadinessSummarySchema,
  capabilities: z.object({ jobs: DeviceCapabilityStateSchema, agents: DeviceCapabilityStateSchema, files: DeviceCapabilityStateSchema }).strict(),
  checks: z.array(DeviceReadinessCheckSchema).max(13), capacity: DeviceCapacitySchema.nullable(),
  resourcePolicy: DeviceResourcePolicySchema.nullable(), runtimeApproval: DeviceRuntimeApprovalSchema.nullable(),
  operations: z.array(DeviceProvisioningOperationSchema).max(32),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.checks.map(check => check.id)).size !== value.checks.length)
    ctx.addIssue({ code: 'custom', path: ['checks'], message: 'Check IDs must be unique.' })
  if ((value.observedAt === null) !== (value.expiresAt === null)
    || value.observedAt && value.expiresAt && (Date.parse(value.expiresAt) <= Date.parse(value.observedAt)
      || Date.parse(value.expiresAt) - Date.parse(value.observedAt) > DEVICE_READINESS_EXPIRY_SECONDS * 1000))
    ctx.addIssue({ code: 'custom', message: 'Readiness needs a bounded observation expiry.' })
  const host = value.target.hostRef, binding = value.binding
  if (host.kind === 'main' && binding !== null || binding && (host.kind !== 'device' || binding.mainId !== host.mainId
    || binding.deviceId !== host.deviceId || binding.workerInstallationId !== value.target.applicationInstallationId
    || binding.keyRevision !== value.target.keyRevision || binding.authorizationRevision !== value.target.authorizationRevision || binding.bootId !== value.bootId))
    ctx.addIssue({ code: 'custom', path: ['binding'], message: 'Observation must retain the exact current device/boot authority.' })
  for (const record of [value.capacity, value.resourcePolicy, value.runtimeApproval, ...value.operations]) {
    if (record && !sameDeviceProvisioningTarget(value.target, record.target))
      ctx.addIssue({ code: 'custom', message: 'Readiness must not combine records from other targets.' })
  }
  for (const capability of ['jobs', 'agents', 'files'] as const) {
    if (value.capabilities[capability].state !== 'ready') continue
    if (value.connection !== 'online' || !value.observedAt || !value.bootId || host.kind === 'device' && !binding
      || value.checks.some(check => check.requiredFor.includes(capability) && check.state !== 'ready'))
      ctx.addIssue({ code: 'custom', message: 'Ready needs current connection and all required checks.' })
    if (capability !== 'files' && (!value.capacity?.resourceSettingsSupported || value.capacity.generation !== value.resourcePolicy?.capacityGeneration
      || value.resourcePolicy?.applyState !== 'applied' || value.runtimeApproval?.status !== 'approved'
      || !['runtime', 'toolchain', 'cgroup-cpu', 'cgroup-memory', 'cgroup-pids', 'storage', 'resource-policy', 'execution-authorization', 'runtime-approval', 'workspace-roots',
        ...(capability === 'jobs' ? ['container-runtime', 'ci-image'] : ['harness-dependencies'])].every(id => value.checks.some(check => check.id === id && check.state === 'ready'))))
      ctx.addIssue({ code: 'custom', message: 'Execution readiness requires measured preparation, applied limits, and device approval.' })
  }
  if (value.summary.state === 'ready' && (value.connection !== 'online' || !value.observedAt || !value.bootId
    || value.checks.length === 0 || value.checks.some(check => check.state !== 'ready')
    || value.capabilities.jobs.state !== 'ready' || value.capabilities.agents.state !== 'ready'))
    ctx.addIssue({ code: 'custom', path: ['summary'], message: 'Ready summary cannot hide missing execution readiness.' })
  if (value.summary.state === 'needs-steps' && value.summary.primaryAction && !value.checks.some(check =>
    check.actions.some(action => JSON.stringify(action) === JSON.stringify(value.summary.primaryAction))))
    ctx.addIssue({ code: 'custom', path: ['summary', 'primaryAction'], message: 'The primary fix must be an advertised action.' })
})
export type DeviceReadiness = z.infer<typeof DeviceReadinessSchema>
export type DeviceFixAction = z.infer<typeof DeviceFixActionSchema>
export type DeviceRepairPlan = z.infer<typeof DeviceRepairPlanSchema>
export type DeviceProvisioningOperation = z.infer<typeof DeviceProvisioningOperationSchema>
export type DeviceRuntimeApproval = z.infer<typeof DeviceRuntimeApprovalSchema>
export const DeviceReadinessReadRequestSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const DeviceReadinessReadResultSchema = z.object({ readiness: DeviceReadinessSchema }).strict()
export const DeviceReadinessCheckRequestSchema = z.object({ target: DeviceProvisioningTargetSchema, commandId: DeviceCommandIdSchema,
  expectedGeneration: DeviceSafeIntegerSchema }).strict()
export const DeviceReadinessCheckResultSchema = z.object({ operation: DeviceProvisioningOperationSchema }).strict()
export const DeviceRepairPlanRequestSchema = z.object({ target: DeviceProvisioningTargetSchema,
  actionIds: DeviceRepairPlanSchema.shape.actionIds, expectedGeneration: DeviceSafeIntegerSchema }).strict()
export const DeviceRepairPlanResultSchema = z.object({ plan: DeviceRepairPlanSchema }).strict()
export const DeviceRepairStartRequestSchema = z.object({ target: DeviceProvisioningTargetSchema, commandId: DeviceCommandIdSchema,
  planId: z.uuid(), planDigest: DeviceDigestSchema, expectedGeneration: DeviceSafeIntegerSchema }).strict()
export const DeviceRepairStartResultSchema = z.object({ operation: DeviceProvisioningOperationSchema }).strict()
export const DeviceProvisioningOperationReadRequestSchema = z.object({ target: DeviceProvisioningTargetSchema, operationId: z.uuid() }).strict()
export const DeviceProvisioningOperationReadResultSchema = z.object({ operation: DeviceProvisioningOperationSchema }).strict()
export const DeviceRuntimeApprovalReadRequestSchema = DeviceReadinessReadRequestSchema
export const DeviceRuntimeApprovalReadResultSchema = z.object({ approval: DeviceRuntimeApprovalSchema.nullable() }).strict()
export const DeviceRuntimeApprovalRequestSchema = z.object({ target: DeviceProvisioningTargetSchema, commandId: DeviceCommandIdSchema,
  expectedRevision: DeviceSafeIntegerSchema }).strict()
/** Human browser only: this schema is deliberately not an Operator grant tool. */
export const DeviceRuntimeApprovalGrantSchema = DeviceRuntimeApprovalRequestSchema.safeExtend({ approvalId: z.uuid(), approved: z.literal(true) })
export const DeviceRuntimeApprovalRevokeSchema = DeviceRuntimeApprovalRequestSchema.safeExtend({ expectedRevision: DeviceRevisionSchema, approvalId: z.uuid() })
export const DeviceRuntimeApprovalCommandResultSchema = z.object({ approval: DeviceRuntimeApprovalSchema }).strict()

export const DEVICE_PAIRING_CODE_TTL_SECONDS = 900
export const DevicePairingCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const DevicePairingInstallCodeSchema = z.object({ schemaVersion: z.literal(1), pairingId: z.uuid(), mainId: z.uuid(),
  code: DevicePairingCodeSchema, issuedAt: TimestampSchema, expiresAt: TimestampSchema, singleUse: z.literal(true),
}).strict().superRefine((value, ctx) => {
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.issuedAt)
  if (ttl <= 0 || ttl > DEVICE_PAIRING_CODE_TTL_SECONDS * 1000)
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Install pairing codes expire within fifteen minutes.' })
})
export const DeviceProvisioningReleaseSchema = z.object({ releaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  installerUrl: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9/._~-]+$/).refine(value => {
    try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash } catch { return false }
  }), installerSha256: DeviceDigestSchema,
}).strict()
/** Fixed verified bootstrap syntax. The short-lived code is not a long-lived enrollment credential. Never audit/log it. */
export function devicePairingInstallCommand(releaseInput: z.infer<typeof DeviceProvisioningReleaseSchema>, codeInput: string): string {
  const release = DeviceProvisioningReleaseSchema.parse(releaseInput), code = DevicePairingCodeSchema.parse(codeInput)
  return `curl -fsSLo graphql-companion-install.sh '${release.installerUrl}' && echo '${release.installerSha256}  graphql-companion-install.sh' | sha256sum -c - && sh graphql-companion-install.sh --pairing-code '${code}'`
}
export const DevicePairingInstallCreateSchema = z.object({ commandId: DeviceCommandIdSchema }).strict()
export const DevicePairingInstallCreateResultSchema = z.object({ pairing: DevicePairingInstallCodeSchema,
  release: DeviceProvisioningReleaseSchema, installCommand: z.string().min(1).max(2048),
}).strict().superRefine((value, ctx) => {
  if (DeviceProvisioningReleaseSchema.safeParse(value.release).success && DevicePairingCodeSchema.safeParse(value.pairing.code).success
    && value.installCommand !== devicePairingInstallCommand(value.release, value.pairing.code))
    ctx.addIssue({ code: 'custom', path: ['installCommand'], message: 'The install command must verify the exact approved release and use this pairing code.' })
})
export const DevicePairingInstallRedeemSchema = z.object({ pairingId: z.uuid(), code: DevicePairingCodeSchema,
  identity: WorkerIdentityRequestSchema, releaseId: DeviceProvisioningReleaseSchema.shape.releaseId,
  installerSha256: DeviceDigestSchema,
}).strict()
/** Return private pairing credentials through the existing approved enrollment mechanism, outside public readiness/audit. */
export const DevicePairingInstallRedeemResultSchema = z.object({ target: DeviceProvisioningTargetSchema,
  pairingId: z.uuid(), consumedAt: TimestampSchema }).strict()

/** Trusted observations contain measured checks/capacity, never caller capability-ready flags or runtime approval. */
const WireBinding = { version: z.literal(1), target: DeviceProvisioningTargetSchema, binding: DeviceSessionBindingSchema, bootId: z.uuid() }
export const DeviceProvisioningWireRequestSchema = z.discriminatedUnion('method', [
  z.object({ ...WireBinding, method: z.literal('observe'), generation: DeviceRevisionSchema, observedAt: TimestampSchema,
    checks: z.array(DeviceReadinessCheckSchema).max(13), capacity: DeviceCapacitySchema.nullable(),
    resourcePolicy: DeviceResourcePolicySchema.nullable() }).strict(),
  z.object({ ...WireBinding, method: z.literal('check'), commandId: DeviceCommandIdSchema, operationId: z.uuid(), expectedGeneration: DeviceSafeIntegerSchema }).strict(),
  z.object({ ...WireBinding, method: z.literal('repair-start'), commandId: DeviceCommandIdSchema, operationId: z.uuid(), plan: DeviceRepairPlanSchema }).strict(),
  z.object({ ...WireBinding, method: z.literal('operation-status'), operationId: z.uuid() }).strict(),
  z.object({ ...WireBinding, method: z.literal('resource-apply'), commandId: DeviceCommandIdSchema, operationId: z.uuid(), policy: DeviceResourcePolicySchema }).strict(),
  z.object({ ...WireBinding, method: z.literal('resource-ack'), operationId: z.uuid(), admission: DeviceResourceAdmissionSchema,
    capacityGeneration: DeviceRevisionSchema, effective: DeviceResourcePolicySchema.shape.desired, measuredAt: TimestampSchema,
    enforcementDigest: DeviceDigestSchema }).strict(),
]).superRefine((value, ctx) => {
  const host = value.target.hostRef, binding = value.binding
  if (host.kind !== 'device' || host.mainId !== binding.mainId || host.deviceId !== binding.deviceId
    || value.target.applicationInstallationId !== binding.workerInstallationId || value.target.keyRevision !== binding.keyRevision
    || value.target.authorizationRevision !== binding.authorizationRevision || value.bootId !== binding.bootId)
    ctx.addIssue({ code: 'custom', message: 'Wire request must retain its exact authenticated installation and boot.' })
  const records = value.method === 'observe' ? [value.capacity, value.resourcePolicy]
    : value.method === 'repair-start' ? [value.plan] : value.method === 'resource-apply' ? [value.policy] : []
  if (records.some(record => record && !sameDeviceProvisioningTarget(record.target, value.target)))
    ctx.addIssue({ code: 'custom', message: 'Wire request cannot apply another target record.' })
  if (value.method === 'observe' && new Set(value.checks.map(check => check.id)).size !== value.checks.length)
    ctx.addIssue({ code: 'custom', message: 'Observation check IDs must be unique.' })
})
export const DeviceProvisioningWireResultSchema = z.discriminatedUnion('method', [
  z.object({ ...WireBinding, method: z.enum(['observe', 'resource-ack']), accepted: z.literal(true), generation: DeviceRevisionSchema }).strict(),
  z.object({ ...WireBinding, method: z.enum(['check', 'repair-start', 'operation-status', 'resource-apply']), operation: DeviceProvisioningOperationSchema }).strict(),
]).superRefine((value, ctx) => {
  const host = value.target.hostRef, binding = value.binding
  if (host.kind !== 'device' || host.mainId !== binding.mainId || host.deviceId !== binding.deviceId
    || value.target.applicationInstallationId !== binding.workerInstallationId || value.target.keyRevision !== binding.keyRevision
    || value.target.authorizationRevision !== binding.authorizationRevision || value.bootId !== binding.bootId
    || 'operation' in value && !sameDeviceProvisioningTarget(value.operation.target, value.target))
    ctx.addIssue({ code: 'custom', message: 'Wire response must retain the exact request binding and target.' })
})
export type DeviceProvisioningWireRequest = z.infer<typeof DeviceProvisioningWireRequestSchema>
export type DeviceProvisioningWireResult = z.infer<typeof DeviceProvisioningWireResultSchema>

export type DeviceReadinessReadRequest = z.infer<typeof DeviceReadinessReadRequestSchema>
export type DeviceReadinessReadResult = z.infer<typeof DeviceReadinessReadResultSchema>
export type DeviceReadinessCheckRequest = z.infer<typeof DeviceReadinessCheckRequestSchema>
export type DeviceReadinessCheckResult = z.infer<typeof DeviceReadinessCheckResultSchema>
export type DeviceRepairPlanRequest = z.infer<typeof DeviceRepairPlanRequestSchema>
export type DeviceRepairPlanResult = z.infer<typeof DeviceRepairPlanResultSchema>
export type DeviceRepairStartRequest = z.infer<typeof DeviceRepairStartRequestSchema>
export type DeviceRepairStartResult = z.infer<typeof DeviceRepairStartResultSchema>
export type DeviceProvisioningOperationReadRequest = z.infer<typeof DeviceProvisioningOperationReadRequestSchema>
export type DeviceProvisioningOperationReadResult = z.infer<typeof DeviceProvisioningOperationReadResultSchema>
export type DeviceRuntimeApprovalReadRequest = z.infer<typeof DeviceRuntimeApprovalReadRequestSchema>
export type DeviceRuntimeApprovalReadResult = z.infer<typeof DeviceRuntimeApprovalReadResultSchema>
export type DeviceRuntimeApprovalRequest = z.infer<typeof DeviceRuntimeApprovalRequestSchema>
export type DeviceRuntimeApprovalGrant = z.infer<typeof DeviceRuntimeApprovalGrantSchema>
export type DeviceRuntimeApprovalRevoke = z.infer<typeof DeviceRuntimeApprovalRevokeSchema>
export type DeviceRuntimeApprovalCommandResult = z.infer<typeof DeviceRuntimeApprovalCommandResultSchema>
export type DevicePairingInstallCode = z.infer<typeof DevicePairingInstallCodeSchema>
export type DeviceProvisioningRelease = z.infer<typeof DeviceProvisioningReleaseSchema>
export type DevicePairingInstallCreate = z.infer<typeof DevicePairingInstallCreateSchema>
export type DevicePairingInstallCreateResult = z.infer<typeof DevicePairingInstallCreateResultSchema>
export type DevicePairingInstallRedeem = z.infer<typeof DevicePairingInstallRedeemSchema>
export type DevicePairingInstallRedeemResult = z.infer<typeof DevicePairingInstallRedeemResultSchema>
