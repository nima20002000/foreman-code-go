import { describe, expect, it } from 'vitest'
import { DEVICE_PROVISIONING_EXTENSION, DeviceReadinessSchema, DeviceReadinessReadResultSchema, DeviceRepairPlanRequestSchema,
  DeviceRepairStartRequestSchema, DeviceRepairPlanSchema, DeviceProvisioningOperationSchema, DeviceReadinessCheckRequestSchema,
  DeviceRuntimeApprovalSchema, DeviceRuntimeApprovalGrantSchema, DeviceRuntimeApprovalRevokeSchema,
  DevicePairingInstallCreateSchema, DevicePairingInstallCreateResultSchema, DevicePairingInstallCodeSchema,
  DevicePairingInstallRedeemSchema, DeviceProvisioningWireRequestSchema, DeviceFixActionSchema } from './deviceProvisioning.js'
import { DEFAULT_MANAGEMENT_ACTIONS, DEVICE_PROVISIONING_OPERATOR_TOOL_NAMES, DEVICE_PROVISIONING_OPERATOR_METADATA,
  DEVICE_PROVISIONING_OPERATOR_CONDITIONAL_REQUIREMENTS, ManagementActionSchema, OperatorToolNameSchema } from './management/index.js'
import { deviceProvisioningReadinessFixtures as fixtures, deviceProvisioningTargetFixture as target,
  deviceProvisioningBindingFixture as binding, deviceRepairPlanFixture as plan, deviceProvisioningOperationFixture as operation,
  deviceRuntimeApprovalFixture as approval, devicePairingInstallFixture as pairing } from './deviceProvisioningFixtures.js'

describe('strict sanitized provisioning readiness, plans and operations', () => {
  it('parses every full structured fixture using the HTTP wrapper', () => {
    for (const fixture of Object.values(fixtures)) expect(DeviceReadinessReadResultSchema.parse(fixture)).toEqual(fixture)
    expect(fixtures.ready.readiness.summary.label).toBe('Ready')
    expect(fixtures.pendingDrain.readiness.summary.primaryAction?.id).toBe('apply-resource-policy-now')
    expect(fixtures.offline.readiness.capabilities.jobs.state).toBe('blocked')
  })
  it.each([
    { checks: [...fixtures.ready.readiness.checks, fixtures.ready.readiness.checks[0]] },
    { binding: { ...binding, authorizationRevision: 2 } }, { bootId: target.hostRef.deviceId },
    { expiresAt: '2026-10-02T18:03:00.000Z' }, { connection: 'offline' }, { runtimeApproval: null },
    { resourcePolicy: null }, { checks: [] }, { credentials: 'secret' },
    { summary: { state: 'needs-steps', label: 'Needs 2 steps', remainingSteps: 1, primaryAction: null } },
  ])('rejects duplicate, stale, unapproved or fabricated ready facts %j', change => {
    expect(DeviceReadinessSchema.safeParse({ ...fixtures.ready.readiness, ...change }).success).toBe(false)
  })
  it('requires an advertised primary Fix even when currently unavailable', () => {
    const unknown = fixtures.pairedNoObservation.readiness
    expect(unknown.summary.primaryAction?.id).toBe('check')
    expect(unknown.summary.primaryAction?.enabled).toBe(false)
    expect(DeviceReadinessSchema.safeParse({ ...unknown, summary: { ...unknown.summary, primaryAction: null } }).success).toBe(false)
  })
  it('cannot hide a blocker behind the Ready summary or an unadvertised fix', () => {
    expect(DeviceReadinessSchema.safeParse({ ...fixtures.localAdminRequired.readiness, summary: fixtures.ready.readiness.summary }).success).toBe(false)
    expect(DeviceReadinessSchema.safeParse({ ...fixtures.pairedNoObservation.readiness,
      summary: fixtures.pendingDrain.readiness.summary }).success).toBe(false)
    expect(DeviceReadinessSchema.safeParse({ ...fixtures.offline.readiness, checks: fixtures.ready.readiness.checks.map(check => ({ ...check, reasonCode: '/private/token.log' })) }).success).toBe(false)
  })
  it('accepts only advertised repair actions, never caller shell steps, paths, or readiness proofs', () => {
    expect(DeviceRepairPlanSchema.parse(plan)).toEqual(plan)
    expect(DeviceRepairPlanRequestSchema.parse({ target, expectedGeneration: 1, actionIds: ['prepare-ci-image'] })).toBeTruthy()
    expect(DeviceRepairPlanRequestSchema.safeParse({ target, expectedGeneration: 1, actionIds: ['exec-shell'] }).success).toBe(false)
    expect(DeviceRepairPlanRequestSchema.safeParse({ target, expectedGeneration: 1, actionIds: ['check'], steps: plan.steps }).success).toBe(false)
    const start = { target, commandId: 'repair-command-1', planId: plan.planId, planDigest: plan.planDigest, expectedGeneration: 1 }
    expect(DeviceRepairStartRequestSchema.parse(start)).toEqual(start)
    expect(DeviceRepairStartRequestSchema.safeParse({ ...start, sudo: true }).success).toBe(false)
    expect(DeviceRepairPlanSchema.safeParse({ ...plan, steps: [{ id: 'exec-shell', command: 'anything' }] }).success).toBe(false)
    expect(DeviceReadinessCheckRequestSchema.safeParse({ target, commandId: 'command-check', expectedGeneration: 0, ready: true }).success).toBe(false)
  })
  it('requires truthful progress, state and timestamps', () => {
    expect(DeviceProvisioningOperationSchema.parse(operation)).toEqual(operation)
    expect(DeviceProvisioningOperationSchema.safeParse({ ...operation, progress: { ...operation.progress, completedBytes: Number.MAX_SAFE_INTEGER } }).success).toBe(false)
    expect(DeviceProvisioningOperationSchema.safeParse({ ...operation, state: 'succeeded' }).success).toBe(false)
    expect(DeviceProvisioningOperationSchema.safeParse({ ...operation, state: 'failed', completedAt: operation.updatedAt }).success).toBe(false)
    expect(DeviceProvisioningOperationSchema.safeParse({ ...operation, logs: 'arbitrary private stderr' }).success).toBe(false)
  })
  it('preserves local-admin/human authority and stop/apply permissions in action metadata', () => {
    const fix = fixtures.localAdminRequired.readiness.summary.primaryAction!
    expect(DeviceFixActionSchema.safeParse({ ...fix, executor: 'worker' }).success).toBe(false)
    const apply = fixtures.pendingDrain.readiness.summary.primaryAction!
    expect(DeviceFixActionSchema.safeParse({ ...apply, requiredActions: ['settings:update'] }).success).toBe(false)
    expect(DeviceFixActionSchema.safeParse({ ...apply, approvalRequired: false }).success).toBe(false)
  })
})
describe('single-use verified install/pair code and revocable device approval', () => {
  it('exposes a fixed verified command without install-time resource choices', () => {
    expect(DevicePairingInstallCreateResultSchema.parse(pairing)).toEqual(pairing)
    expect(pairing.installCommand).toContain('sha256sum -c - && sh')
    expect(DevicePairingInstallCreateSchema.safeParse({ commandId: 'install-command', limits: {} }).success).toBe(false)
    expect(DevicePairingInstallCreateResultSchema.safeParse({ ...pairing, installCommand: 'curl unverified | sh' }).success).toBe(false)
    expect(DevicePairingInstallCodeSchema.safeParse({ ...pairing.pairing, singleUse: false }).success).toBe(false)
    expect(DevicePairingInstallCodeSchema.safeParse({ ...pairing.pairing, expiresAt: '2026-10-02T18:16:00.000Z' }).success).toBe(false)
    expect(DevicePairingInstallCreateResultSchema.safeParse({ ...pairing, release: { ...pairing.release, installerUrl: "https://host/$(secret)" } }).success).toBe(false)
  })
  it('binds redemption to real worker identity and the release, without management/shell grants', () => {
    const redeem = { pairingId: pairing.pairing.pairingId, code: pairing.pairing.code,
      identity: { version: 1, kind: 'identity-request', workerInstallationId: target.applicationInstallationId,
        publicKey: 'fixture-public-key', publicKeyFingerprint: 'a'.repeat(64) },
      releaseId: pairing.release.releaseId, installerSha256: pairing.release.installerSha256 }
    expect(DevicePairingInstallRedeemSchema.parse(redeem)).toEqual(redeem)
    expect(DevicePairingInstallRedeemSchema.safeParse({ ...redeem, actions: ['settings:update'] }).success).toBe(false)
    expect(DevicePairingInstallRedeemSchema.safeParse({ ...redeem, runtimeApproved: true }).success).toBe(false)
  })
  it('retains one exact device approval, explicit human grant and revisioned revocation', () => {
    expect(DeviceRuntimeApprovalSchema.parse(approval)).toEqual(approval)
    expect(DeviceRuntimeApprovalSchema.parse(fixtures.revokedRuntimeApproval.readiness.runtimeApproval)).toBeTruthy()
    expect(DeviceRuntimeApprovalSchema.safeParse({ ...approval, status: 'revoked' }).success).toBe(false)
    expect(DeviceRuntimeApprovalSchema.safeParse({ ...approval, profileId: 'per-job-approval' }).success).toBe(false)
    const input = { target, commandId: 'approval-command', expectedRevision: 1, approvalId: approval.approvalId }
    expect(DeviceRuntimeApprovalGrantSchema.safeParse({ ...input, approved: false }).success).toBe(false)
    expect(DeviceRuntimeApprovalRevokeSchema.parse(input)).toEqual(input)
    expect(DeviceRuntimeApprovalRevokeSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false)
  })
})
describe('Operator and W07 parity contracts', () => {
  it('lists names/actions/global permissions for every tool and opts provisioning out of default grants', () => {
    expect(DEVICE_PROVISIONING_OPERATOR_METADATA.map(value => value.name)).toEqual([...DEVICE_PROVISIONING_OPERATOR_TOOL_NAMES])
    for (const tool of DEVICE_PROVISIONING_OPERATOR_METADATA) {
      expect(OperatorToolNameSchema.parse(tool.name)).toBe(tool.name)
      expect(tool.scope).toBe('global')
      expect(tool.action.length).toBeGreaterThan(0)
      for (const permission of tool.actions) expect(ManagementActionSchema.parse(permission)).toBe(permission)
    }
    expect(DEFAULT_MANAGEMENT_ACTIONS).not.toContain('devices:provision')
    expect(DEVICE_PROVISIONING_OPERATOR_TOOL_NAMES).not.toContain('device_runtime_approval_grant')
    expect(DEVICE_PROVISIONING_OPERATOR_CONDITIONAL_REQUIREMENTS[0].actions).toEqual(['jobs:cancel'])
  })
  it('binds wire observations to current identity and rejects ready/approval shortcuts', () => {
    expect(DEVICE_PROVISIONING_EXTENSION).toEqual({ namespace: 'device-provisioning-v1', version: 1, role: 'duplex', maxJsonBytes: 65536, maxBinaryBytes: 0 })
    const observe = { version: 1, method: 'observe', target, binding, bootId: binding.bootId, generation: 1,
      observedAt: fixtures.ready.readiness.observedAt, checks: fixtures.ready.readiness.checks, capacity: fixtures.ready.readiness.capacity,
      resourcePolicy: fixtures.ready.readiness.resourcePolicy }
    expect(DeviceProvisioningWireRequestSchema.parse(observe)).toEqual(observe)
    expect(DeviceProvisioningWireRequestSchema.safeParse({ ...observe, binding: { ...binding, workerInstallationId: target.hostRef.mainId } }).success).toBe(false)
    expect(DeviceProvisioningWireRequestSchema.safeParse({ ...observe, capabilities: fixtures.ready.readiness.capabilities }).success).toBe(false)
    expect(DeviceProvisioningWireRequestSchema.safeParse({ ...observe, runtimeApproval: approval }).success).toBe(false)
    expect(DeviceProvisioningWireRequestSchema.safeParse({ ...observe, capacity: { ...observe.capacity, target: { ...target, keyRevision: 2 } } }).success).toBe(false)
  })
})
