import { DeviceReadinessReadResultSchema, DeviceReadinessSchema, DeviceFixActionSchema, DeviceFixActionIdSchema, DeviceRepairPlanSchema,
  DeviceProvisioningOperationSchema, DeviceRuntimeApprovalSchema, DevicePairingInstallCreateResultSchema,
  devicePairingInstallCommand, type DeviceReadiness } from './deviceProvisioning.js'
import type { z } from 'zod'
import { DEVICE_GIB, DeviceCapacitySchema, DeviceResourcePolicySchema, DeviceResourceReadResultSchema, DeviceResourceErrorSchema, type DeviceReasonCode } from './deviceResources.js'

// Deterministic contract fixtures, not measurements, credentials, or proof of a real prepared computer.
const id = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const installationId = '33333333-3333-4333-8333-333333333333'
const operationId = '44444444-4444-4444-8444-444444444444'
const digest = 'a'.repeat(64)
const observedAt = '2026-10-02T18:00:00.000Z', expiresAt = '2026-10-02T18:01:30.000Z'
export const deviceProvisioningTargetFixture = { hostRef: { kind: 'device' as const, mainId: id, deviceId },
  applicationInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 }
export const deviceProvisioningBindingFixture = { mainId: id, deviceId, workerInstallationId: installationId,
  keyRevision: 1, authorizationRevision: 1, bootId: id, connectionEpoch: operationId, connectionGeneration: 1 }
export const deviceResourceLimitsFixture = { cpuLimit: 8, memoryBytes: 16 * DEVICE_GIB, diskBytes: 64 * DEVICE_GIB, pidsLimit: 1024 }
export const deviceCapacityFixture = DeviceCapacitySchema.parse({ schemaVersion: 1, target: deviceProvisioningTargetFixture,
  generation: 1, observedAt, expiresAt, resourceSettingsSupported: true,
  onlineCpuCount: 16, allowedCpuCount: 16, ancestorCpuLimit: null, physicalMemoryBytes: 32 * DEVICE_GIB,
  ancestorMemoryBytes: null, hostMemoryReserveBytes: 4 * DEVICE_GIB, parentPidsLimit: 4096,
  storage: { volumeId: operationId, filesystem: 'ext4', mountIdentityDigest: digest, volumeCapacityBytes: 256 * DEVICE_GIB,
    usableBytes: 240 * DEVICE_GIB, hostFreeBytes: 512 * DEVICE_GIB, reservedHostBytes: 64 * DEVICE_GIB,
    projectUsageBytes: 4 * DEVICE_GIB, protectedHeadroomBytes: DEVICE_GIB, setupHeadroomBytes: 8 * DEVICE_GIB,
    imageExpandedBytes: 4 * DEVICE_GIB, consentCeilingBytes: 240 * DEVICE_GIB, growable: true,
    growthMode: 'extendable-volume', shrinkReclaimsHostSpace: false },
  minimum: { cpuLimit: 0.25, memoryBytes: 512 * 2 ** 20, diskBytes: 8 * DEVICE_GIB, pidsLimit: 64 },
  maximum: { cpuLimit: 16, memoryBytes: 28 * DEVICE_GIB, diskBytes: 240 * DEVICE_GIB, pidsLimit: 4096 },
})
export const deviceResourcePolicyFixture = DeviceResourcePolicySchema.parse({ schemaVersion: 1, target: deviceProvisioningTargetFixture,
  revision: 1, policyDigest: digest, desired: deviceResourceLimitsFixture, effective: deviceResourceLimitsFixture,
  effectiveRevision: 1, effectivePolicyDigest: digest, applyState: 'applied', applyMode: 'when-idle', capacityGeneration: 1,
  activeJobCount: 0, activeOperationCount: 0, updatedAt: observedAt, appliedAt: observedAt, errorCode: null })
export const deviceRuntimeApprovalFixture = DeviceRuntimeApprovalSchema.parse({ schemaVersion: 1, approvalId: operationId,
  target: deviceProvisioningTargetFixture, revision: 1, status: 'approved', requestedByPrincipalId: 'human-fixture', requestedAt: observedAt,
  approvedByPrincipalId: 'human-fixture', approvedAt: observedAt, revokedByPrincipalId: null, revokedAt: null })
const action = (id: z.infer<typeof DeviceFixActionIdSchema>,
  executor: 'worker' | 'human' | 'local-admin' = 'worker') => DeviceFixActionSchema.parse({ id, executor,
  requiredActions: executor === 'worker' && id !== 'apply-resource-policy' ? ['settings:update', 'devices:provision'] : ['settings:update'],
  approvalRequired: executor !== 'worker', disruptive: false, enabled: true, disabledReason: null })
export const deviceCheckActionFixture = action('check')
export const deviceRepairPlanFixture = DeviceRepairPlanSchema.parse({ planId: operationId, target: deviceProvisioningTargetFixture,
  planDigest: digest, expectedGeneration: 1, actionIds: ['prepare-ci-image'], expiresAt, requiredActions: ['settings:update', 'devices:provision'],
  approvalRequirement: 'none', disruptive: false, downloadBytes: DEVICE_GIB, minimumFreeBytes: 8 * DEVICE_GIB,
  steps: [{ id: 'prepare-ci-image', executor: 'worker', approvalRequirement: 'none' },
    { id: 'verify-readiness', executor: 'worker', approvalRequirement: 'none' }] })
export const deviceProvisioningOperationFixture = DeviceProvisioningOperationSchema.parse({ operationId, target: deviceProvisioningTargetFixture,
  commandId: 'fixture-command-1', planId: operationId, state: 'running',
  progress: { stepId: 'prepare-ci-image', completedBytes: 256 * 2 ** 20, totalBytes: DEVICE_GIB }, reasonCode: null,
  createdAt: observedAt, updatedAt: observedAt, completedAt: null })
const checkIds = ['runtime', 'toolchain', 'container-runtime', 'ci-image', 'cgroup-cpu', 'cgroup-memory', 'cgroup-pids',
  'storage', 'resource-policy', 'execution-authorization', 'runtime-approval', 'workspace-roots', 'harness-dependencies'] as const
const ready = DeviceReadinessSchema.parse({ schemaVersion: 1, target: deviceProvisioningTargetFixture,
  binding: deviceProvisioningBindingFixture, bootId: id, generation: 1, observedAt, expiresAt, connection: 'online',
  summary: { state: 'ready', label: 'Ready', remainingSteps: 0, primaryAction: null },
  capabilities: Object.fromEntries(['jobs', 'agents', 'files'].map(key => [key, { state: 'ready', reasons: [], workspaceQualificationRequired: false }])),
  checks: checkIds.map(id => ({ id, state: 'ready', requiredFor: id === 'harness-dependencies' ? ['agents']
    : ['ci-image', 'container-runtime'].includes(id) ? ['jobs'] : ['jobs', 'agents'], reasonCode: null, checkedAt: observedAt, evidenceDigest: digest, actions: [] })),
  capacity: deviceCapacityFixture, resourcePolicy: deviceResourcePolicyFixture, runtimeApproval: deviceRuntimeApprovalFixture, operations: [] })
function blocked(reason: DeviceReasonCode, changes: Partial<DeviceReadiness> = {}): DeviceReadiness {
  const fix = DeviceFixActionSchema.parse({ ...deviceCheckActionFixture,
    enabled: false, disabledReason: reason })
  const checks = (changes.checks?.length ? changes.checks : changes.checks ? ready.checks.map(check => ({ ...check,
    state: 'unknown' as const, reasonCode: reason, checkedAt: null, evidenceDigest: null })) : ready.checks)
    .map((check, index) => index === 0 ? { ...check, actions: [...check.actions.filter(action => action.id !== fix.id), fix] } : check)
  return DeviceReadinessSchema.parse({ ...ready, capabilities: { jobs: { state: 'blocked', reasons: [reason], workspaceQualificationRequired: false },
    agents: { state: 'blocked', reasons: [reason], workspaceQualificationRequired: false },
    files: { state: 'unknown', reasons: [reason], workspaceQualificationRequired: false } },
    ...changes, checks,
    summary: changes.summary ?? { state: 'needs-steps', label: 'Needs 1 step', remainingSteps: 1, primaryAction: fix } })
}
function missing(checkId: typeof checkIds[number], state: 'missing' | 'repairing' | 'blocked', reason: DeviceReasonCode,
  fix: ReturnType<typeof action>, changes: Partial<DeviceReadiness> = {}): DeviceReadiness {
  return blocked(reason, { ...changes, checks: ready.checks.map(check => check.id === checkId ? { ...check, state, reasonCode: reason, actions: [fix] } : check),
    summary: { state: 'needs-steps', label: 'Needs 1 step', remainingSteps: 1, primaryAction: fix } })
}
const pendingPolicy = DeviceResourcePolicySchema.parse({ ...deviceResourcePolicyFixture, revision: 2, policyDigest: 'b'.repeat(64),
  desired: { ...deviceResourceLimitsFixture, cpuLimit: 6 }, applyState: 'pending', activeJobCount: 2, activeOperationCount: 3 })
const applyNow = DeviceFixActionSchema.parse({ id: 'apply-resource-policy-now', executor: 'worker',
  requiredActions: ['settings:update', 'jobs:cancel'], approvalRequired: true, disruptive: true, enabled: true, disabledReason: null })
export const deviceProvisioningReadinessFixtures = {
  ready: DeviceReadinessReadResultSchema.parse({ readiness: ready }),
  pairedNoObservation: { readiness: blocked('not_yet_observed', { generation: 0, observedAt: null, expiresAt: null, bootId: null,
    binding: null, connection: 'unknown', checks: [], capacity: null, resourcePolicy: null, runtimeApproval: null }) },
  preparingImage: { readiness: missing('ci-image', 'repairing', 'image_preparing', action('prepare-ci-image'), { operations: [deviceProvisioningOperationFixture] }) },
  missingCpuController: { readiness: missing('cgroup-cpu', 'missing', 'cpu_delegation_missing', action('install-system-prerequisites', 'local-admin')) },
  localAdminRequired: { readiness: missing('container-runtime', 'missing', 'system_packages_missing', action('install-system-prerequisites', 'local-admin')) },
  runtimeApprovalRequired: { readiness: missing('runtime-approval', 'blocked', 'human_approval_required', action('approve-runtime', 'human'),
    { runtimeApproval: { ...deviceRuntimeApprovalFixture, status: 'awaiting-approval', approvedAt: null, approvedByPrincipalId: null } }) },
  workspaceApprovalRequired: { readiness: missing('execution-authorization', 'blocked', 'workspace_approval_required', action('approve-execution', 'human'),
    { capabilities: { ...ready.capabilities, jobs: { state: 'blocked', reasons: ['workspace_approval_required'], workspaceQualificationRequired: true },
      agents: { state: 'blocked', reasons: ['workspace_approval_required'], workspaceQualificationRequired: true } } }) },
  offline: { readiness: blocked('device_offline', { connection: 'offline', checks: ready.checks.map(check => ({ ...check, state: 'stale' })) }) },
  revoked: { readiness: blocked('device_revoked', { connection: 'revoked', binding: null }) },
  capacityChanged: { readiness: blocked('capacity_changed', { capacity: { ...deviceCapacityFixture, generation: 2 } }) },
  pendingDrain: { readiness: missing('resource-policy', 'blocked', 'policy_pending_drain', applyNow, { resourcePolicy: pendingPolicy }) },
  failedApplication: { readiness: missing('resource-policy', 'blocked', 'policy_application_failed', action('apply-resource-policy'),
    { resourcePolicy: { ...pendingPolicy, applyState: 'failed', errorCode: 'policy_application_failed' } }) },
  mixedApplication: { readiness: blocked('policy_recovery_required', { resourcePolicy: { ...pendingPolicy, applyState: 'recovery-required', errorCode: 'mixed_enforcement' } }) },
  revokedRuntimeApproval: { readiness: missing('runtime-approval', 'blocked', 'runtime_approval_revoked', action('approve-runtime', 'human'),
    { runtimeApproval: { ...deviceRuntimeApprovalFixture, revision: 2, status: 'revoked', revokedAt: observedAt, revokedByPrincipalId: 'human-fixture' } }) },
} satisfies Record<string, { readiness: DeviceReadiness }>
export const deviceProvisioningResourceFixtures = {
  applied: DeviceResourceReadResultSchema.parse({ policy: deviceResourcePolicyFixture, capacity: deviceCapacityFixture }),
  unconfigured: DeviceResourceReadResultSchema.parse({ policy: null, capacity: deviceCapacityFixture }),
  pending: DeviceResourceReadResultSchema.parse({ policy: pendingPolicy, capacity: deviceCapacityFixture }),
  unsupportedMain: DeviceResourceReadResultSchema.parse({ policy: null, capacity: null }),
}
const release = { releaseId: 'fixture-20261002', installerUrl: 'https://downloads.example.test/companion/install.sh', installerSha256: digest }
const pairing = { schemaVersion: 1, pairingId: operationId, mainId: id, code: 'A'.repeat(43),
  issuedAt: observedAt, expiresAt: '2026-10-02T18:15:00.000Z', singleUse: true }
export const devicePairingInstallFixture = DevicePairingInstallCreateResultSchema.parse({ pairing, release,
  installCommand: devicePairingInstallCommand(release, pairing.code) })
export const deviceProvisioningAccessFixtures = { readOnly: { actions: ['settings:read'], canCheck: false, canUpdate: false, canApplyNow: false },
  owner: { actions: ['settings:read', 'settings:update', 'devices:provision', 'jobs:cancel'], canCheck: true, canUpdate: true, canApplyNow: true } } as const

export const deviceProvisioningResourceUpdateFixture = { target: deviceProvisioningTargetFixture, commandId: 'fixture-resource-update-1',
  expectedRevision: 1, expectedCapacityGeneration: 1, limits: { ...deviceResourceLimitsFixture, cpuLimit: 6 }, applyMode: 'when-idle' as const }
export const deviceResourceErrorFixtures = {
  denied: { status: 403, body: DeviceResourceErrorSchema.parse({ error: { code: 'permission_denied', fieldIssues: [],
    currentRevision: null, currentCapacityGeneration: null, remedy: 'request_permission' } }) },
  revisionConflict: { status: 409, body: DeviceResourceErrorSchema.parse({ error: { code: 'revision_conflict', fieldIssues: [],
    currentRevision: 2, currentCapacityGeneration: 1, remedy: 'refresh' } }) },
  capacityConflict: { status: 409, body: DeviceResourceErrorSchema.parse({ error: { code: 'capacity_conflict', fieldIssues: [],
    currentRevision: 1, currentCapacityGeneration: 2, remedy: 'refresh' } }) },
  diskBelowUsage: { status: 422, body: DeviceResourceErrorSchema.parse({ error: { code: 'invalid_limits',
    fieldIssues: [{ field: 'diskBytes', code: 'below_retained_usage', remedy: 'free_managed_data' }],
    currentRevision: 1, currentCapacityGeneration: 1, remedy: 'review_limits' } }) },
} as const
