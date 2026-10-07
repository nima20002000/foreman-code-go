import { describe, expect, it, vi } from 'vitest'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { JobDefinitionRecordSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildComputerTarget, type BuildComputerSettings } from '../settings/buildComputers.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import type { JobSql } from './repository.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { JobComputerSelection, compatibleJobComputer, jobComputerCapacity, jobComputerCapacityDecision, jobEligibilityReason, orderBuildComputers, orderForPlacement } from './computerSelection.js'

const mainId = '11111111-1111-4111-8111-111111111111'
function capacityRows(profile: ReturnType<typeof verificationCapacityFixture>, computing: number, retained = 0): JobSql {
  const rows = Array.from({ length: computing + retained }, (_, index) => ({
    limits: profile.spec.resources.limits, compute_closed: index >= computing,
  }))
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length,
    command: 'SELECT', fields: [], oid: 0 })) } as unknown as JobSql
}

describe('reviewed verification admission capacity', () => {
  it.each(['unqualified', 'qualifying'] as const)('waits for a %s profile instead of treating missing measurements as a zero maximum', async status => {
    const measured = verificationCapacityFixture('main')
    const profile = { ...measured, status, measurement: null }
    const { spec } = verificationFixture()
    const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 2, id: 'queued-verification',
      workspaceId: profile.workspaceId, name: 'Waiting verification', revision: 1, versionId: 'queued-version',
      createdAt: profile.createdAt, updatedAt: profile.updatedAt,
      spec: { ...spec, target: { kind: 'auto' }, policy: jobPolicyRequirementsRecord(spec.policy),
        limits: profile.spec.resources.limits } })
    const candidate = { spec, profile, ready: false, reasons: ['runtime_setup_required'],
      sourceReservation: { scopeId: 'approved-source', reservedBytes: 1024 * 1024 } }
    const preference = { target: buildComputerTarget(spec.target), revision: 1, buildEnabled: true, buildPriority: 100, buildRole: 'primary' as const, buildAllowancePercent: 100 }
    const settings = { preference: async () => preference } as unknown as BuildComputerSettings
    const workerExecution = { requireEnabled: vi.fn() } as unknown as WorkerExecutionPolicy
    const selection = new JobComputerSelection(settings,
      { candidates: async () => ({ candidates: [candidate], diagnosticCodes: [] }) }, workerExecution)
    const sql = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as JobSql
    expect(await selection.claim(sql, {} as ManagementPrincipal, definition,
      { executionId: 'queued-execution', attemptId: 'queued-attempt', operationId: 'queued-operation' }))
      .toMatchObject({ spec: null, exceedsMaximum: false, compatibleTargetCount: 1,
        reasons: ['runtime_setup_required'], selectedHost: null })
    expect(workerExecution.requireEnabled).not.toHaveBeenCalled()
  })
  it('admits the fourth Main Job and leaves a fifth waiting', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(await jobComputerCapacityDecision(capacityRows(profile, 3), target, profile)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 4), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
  })
  it('leaves a Job waiting once the owner build allowance of the computer is used', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    const full = jobComputerCapacity(profile), job = profile.spec.resources.limits
    const percent = Math.max(10, Math.ceil(100 * job.memoryBytes / full.memoryBytes))
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0), target, profile, undefined, percent)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 1), target, profile, undefined, percent))
      .toEqual({ fits: false, reason: 'busy' })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 1), target, profile)).toEqual({ fits: true })
  })
  it('accounts for the provisioned independent byte and inode quotas, including closed retained owners', async () => {
    const profile = verificationCapacityFixture('main')
    const fingerprint = profile.measurement!.fingerprint
    fingerprint.quotaPool!.slots = fingerprint.quotaPool!.slots.slice(0, 4)
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(jobComputerCapacity(profile).diskBytes).toBe(profile.spec.resources.limits.diskBytes * 4)
    expect(await jobComputerCapacityDecision(capacityRows(profile, 2, 2), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
    const inodes = profile.spec.resources.mutableInodes
    const sql = { query: async () => ({ rows: [{ limits: profile.spec.resources.limits,
      compute_closed: false, inodes: inodes * 4 }], rowCount: 1 }) } as unknown as JobSql
    expect(await jobComputerCapacityDecision(sql, target, profile)).toEqual({ fits: false, reason: 'busy' })
  })
  it('requires fresh laptop memory and includes the incoming claim in the headroom calculation', async () => {
    const profile = verificationCapacityFixture('device')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    const sql = capacityRows(profile, 1)
    expect(await jobComputerCapacityDecision(sql, target, profile, async () => null))
      .toEqual({ fits: false, reason: 'memory_unavailable' })
    expect(await jobComputerCapacityDecision(sql, target, profile, async () => 8 * 2 ** 30 - 1))
      .toEqual({ fits: false, reason: 'memory_headroom_required' })
    expect(await jobComputerCapacityDecision(sql, target, profile, async () => 8 * 2 ** 30)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 2), target, profile, async () => 14 * 2 ** 30))
      .toEqual({ fits: false, reason: 'busy' })
  })
  it('releases closed compute but retains storage and the independently measured concurrency cap', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0, 3), target, profile)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 0, 7), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
    const measuredOne = verificationCapacityFixture('main', 1)
    expect(await jobComputerCapacityDecision(capacityRows(measuredOne, 1), target, measuredOne))
      .toEqual({ fits: false, reason: 'busy' })
  })
})
function enrolled(priority: number, enabled = true, deviceId?: string, buildRole: 'primary' | 'backup' = 'primary') {
  const fixture = buildComputerFixture(mainId, 'workspace', deviceId)
  return { ...fixture.candidate, preference: { target: fixture.target, revision: 1,
    buildEnabled: enabled, buildPriority: priority, buildRole, buildAllowancePercent: 100 } }
}
describe('build computer ordering', () => {
  it.each([
    ['busy', 'busy'], ['qualification_expired', 'qualification_expired'],
    ['AUTH_REVOKED', 'authorization_revoked'], ['ACCESS_DENIED', 'authorization_revoked'],
    ['JOB_ROOT_PIN_CONFLICT', 'root_changed'], ['JOB_RUNTIME_UNQUALIFIED', 'runtime_unqualified'],
    ['BUILD_COMPUTER_DISABLED', 'disabled'], ['WORKER_EXECUTION_DISABLED', 'remote_execution_disabled'],
    ['unexpected_runtime_error', 'eligibility_check_failed'],
  ])('reports %s as %s without treating unknown eligibility failures as capacity', (code, reason) => {
    expect(jobEligibilityReason(code)).toBe(reason)
  })
  it('tries the calling Agent\'s own computer first, then the rest in build order', () => {
    const primary = enrolled(100, true, '11111111-1111-4111-8111-111111111112')
    const backup = enrolled(90, true, '11111111-1111-4111-8111-111111111113', 'backup')
    const agentHost = enrolled(10, true, '11111111-1111-4111-8111-111111111114', 'backup')
    const prefer = { kind: 'prefer' as const, hostRef: agentHost.spec.target.hostRef }
    expect(orderForPlacement([primary, backup, agentHost], prefer)).toEqual([agentHost, primary, backup])
    expect(orderForPlacement([primary, backup, agentHost], { kind: 'auto' })).toEqual([primary, backup, agentHost])
    // A busy or offline own computer is skipped like any other; the job spills to the next computer.
    const offline = { ...agentHost, ready: false, reasons: ['offline'] }
    expect(orderForPlacement([primary, backup, offline], prefer)).toEqual([primary, backup])
  })
  it('skips a disabled high priority computer and prefers 100 to 50', () => {
    const disabled = enrolled(100, false)
    const lower = enrolled(50)
    const higher = enrolled(100)
    expect(orderBuildComputers([lower, disabled, higher])).toEqual([higher, lower])
  })
  it.each(['offline', 'busy', 'incompatible'])('skips a preferred %s computer', reason => {
    const higher = { ...enrolled(100), ready: false, reasons: [reason] }
    const lower = enrolled(50)
    expect(orderBuildComputers([higher, lower])).toEqual([lower])
  })
  it('breaks equal priorities by canonical computer identity regardless of input order', () => {
    const a = enrolled(50, true, '11111111-1111-4111-8111-111111111112')
    const b = enrolled(50, true, '11111111-1111-4111-8111-111111111113')
    expect(orderBuildComputers([b, a])).toEqual([a, b])
    expect(orderBuildComputers([a, b])).toEqual([a, b])
  })
  it('tries every primary before any backup, whatever their priorities', () => {
    const backup = enrolled(100, true, '11111111-1111-4111-8111-111111111114', 'backup')
    const primaryLow = enrolled(10, true, '11111111-1111-4111-8111-111111111115')
    const primaryHigh = enrolled(60, true, '11111111-1111-4111-8111-111111111116')
    expect(orderBuildComputers([backup, primaryLow, primaryHigh])).toEqual([primaryHigh, primaryLow, backup])
  })
  it('lends only the owner build allowance of CPU and memory', () => {
    const candidate = enrolled(50), full = jobComputerCapacity(candidate.profile)
    expect(jobComputerCapacity(candidate.profile, 50)).toEqual({ ...full, cpuLimit: full.cpuLimit / 2,
      memoryBytes: Math.floor(full.memoryBytes / 2) })
    expect(jobComputerCapacity(candidate.profile, 100)).toEqual(full)
  })
  it('keeps an empty pool empty and uses only measured runtime limits', () => {
    expect(orderBuildComputers([enrolled(100, false)])).toEqual([])
    const candidate = enrolled(50)
    expect(jobComputerCapacity(candidate.profile)).toEqual(candidate.profile.limits)
  })
  it('requires the same source, image, toolchain, security, outputs and resource limits', () => {
    const f = buildComputerFixture(mainId, 'workspace')
    expect(compatibleJobComputer(f.candidate, f.auto)).toBe(true)
    for (const changed of [
      { ...f.auto, source: { ...f.auto.source, manifestDigest: '2'.repeat(64) } },
      { ...f.auto, policy: { ...f.auto.policy, imageDigest: `sha256:${'2'.repeat(64)}` } },
      { ...f.auto, policy: { ...f.auto.policy, toolchainDigest: '2'.repeat(64) } },
      { ...f.auto, policy: { ...f.auto.policy, network: 'approved-dependency-fetch' as const } },
      { ...f.auto, limits: { ...f.auto.limits, memoryBytes: f.auto.limits.memoryBytes * 2 } },
      { ...f.auto, outputs: [{ path: 'dist/required.txt', required: true, mediaType: 'text/plain' as const }] },
    ]) expect(compatibleJobComputer(f.candidate, changed)).toBe(false)
  })
})
