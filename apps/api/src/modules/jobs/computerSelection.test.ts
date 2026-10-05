import { describe, expect, it, vi } from 'vitest'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import type { JobSql } from './repository.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { compatibleJobComputer, jobComputerCapacity, jobComputerCapacityDecision, jobEligibilityReason, orderBuildComputers } from './computerSelection.js'

const mainId = '11111111-1111-4111-8111-111111111111'
function capacityRows(profile: ReturnType<typeof verificationCapacityFixture>, computing: number, retained = 0): JobSql {
  const rows = Array.from({ length: computing + retained }, (_, index) => ({
    limits: profile.spec.resources.limits, compute_closed: index >= computing,
  }))
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length,
    command: 'SELECT', fields: [], oid: 0 })) } as unknown as JobSql
}

describe('reviewed verification admission capacity', () => {
  it('admits the fourth Main Job and leaves a fifth waiting', async () => {
    const profile = verificationCapacityFixture('main')
    const target = { mainId, hostRef: profile.root.selection.hostRef }
    expect(await jobComputerCapacityDecision(capacityRows(profile, 3), target, profile)).toEqual({ fits: true })
    expect(await jobComputerCapacityDecision(capacityRows(profile, 4), target, profile))
      .toEqual({ fits: false, reason: 'busy' })
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
function enrolled(priority: number, enabled = true, deviceId?: string) {
  const fixture = buildComputerFixture(mainId, 'workspace', deviceId)
  return { ...fixture.candidate, preference: { target: fixture.target, revision: 1,
    buildEnabled: enabled, buildPriority: priority } }
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
