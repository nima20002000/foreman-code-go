import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { JobRuntimeProfiles } from '../jobs/runtimeProfiles.js'
import type { JobSql } from '../jobs/repository.js'
import { jobComputerCapacity, jobComputerCapacityDecision } from '../jobs/computerSelection.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { BuildComputerSettings, buildComputerTarget } from './buildComputers.js'
import { buildComputerReadiness } from './buildComputerReadiness.js'
import { WorkerExecutionPolicy } from './workerExecution.js'

function fixture(host: 'main' | 'device', memory: number | null = 14 * 2 ** 30, computing = 0) {
  const profile = verificationCapacityFixture(host)
  const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
    registration: profile.root.registration, mainInstallationId: profile.root.binding.mainId })
  const endpoint = { currentBinding: () => ({ workerInstallationId: target.applicationInstallationId,
    keyRevision: target.keyRevision, authorizationRevision: target.authorizationRevision }),
  captureRequest: () => ({}), clockReason: () => null } as unknown as DeviceEndpoint
  const sql = { query: async (text: string) => ({ rows: text.includes('select record from job_runtime_profiles')
    ? [{ record: profile }] : Array.from({ length: computing }, () => ({
      limits: profile.spec.resources.limits, compute_closed: false,
    })) }) } as unknown as JobSql
  const input = { endpoint: () => endpoint, localExecutor: true, workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
    profiles: { readiness: async () => ({ ready: true, reasons: [] }) } as unknown as JobRuntimeProfiles,
    availableMemory: async () => memory }
  return { input, sql, profile, target }
}

describe('build computer readiness', () => {
  it('reports an untrusted Worker clock before considering runtime or capacity', async () => {
    const f = fixture('device')
    f.input.endpoint().clockReason = () => 'Worker clock differs from Main by more than 2 minutes.'
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100)).toMatchObject({
      state: 'setup-required', reasons: ['Worker clock differs from Main by more than 2 minutes.'],
    })
  })
  it('derives settings readback from the persisted build allowance', async () => {
    const f = fixture('main')
    f.profile.measurement!.fingerprint.deviceLimits!.cpuLimit = 4
    const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
      expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['settings:read'], scope: {} }] }
    const query = async (text: string) => {
      if (text.includes('from management_principals')) return { rows: [{ ...principal,
        expires_at: new Date(principal.expiresAt), revoked_at: null }] }
      if (text.includes('from application_installation')) return { rows: [{ id: f.target.hostRef.mainId }] }
      if (text.includes('from build_computer_preferences')) return { rows: [{ target: f.target, revision: '1',
        build_enabled: true, build_priority: 50, build_allowance_percent: 10 }] }
      return f.sql.query(text)
    }
    const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
    const service = new BuildComputerSettings(pool, {} as PostgresCommandCoordinator, buildComputerReadiness(f.input))
    expect(await service.read(principal, { target: f.target })).toMatchObject({
      preference: { buildAllowancePercent: 10 }, state: 'setup-required',
      reasons: ['The build allowance is too small for this runtime. Increase the allowance.'],
    })
  })
  it('admits an idle qualified remote computer using its fresh available memory', async () => {
    const f = fixture('device')
    expect(await jobComputerCapacityDecision(f.sql, { mainId: f.target.hostRef.mainId,
      hostRef: f.target.hostRef }, f.profile, f.input.availableMemory)).toEqual({ fits: true })
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100))
      .toEqual({ state: 'ready', reasons: [], remoteExecutionEnabled: true })
  })
  it.each([
    [null, 'setup-required', 'Available memory could not be read.'],
    [0, 'busy', 'More available memory is required before another build can start.'],
  ] as const)('reports the memory admission failure for %s bytes', async (memory, state, reason) => {
    const f = fixture('device', memory)
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100))
      .toEqual({ state, reasons: [reason], remoteExecutionEnabled: true })
  })
  it('uses the saved allowance for occupied capacity just as scheduling does', async () => {
    const f = fixture('main', null, 1)
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 100)).toMatchObject({ state: 'ready' })
    const percent = Math.max(10, Math.ceil(100 * f.profile.spec.resources.limits.memoryBytes
      / jobComputerCapacity(f.profile).memoryBytes))
    expect(await jobComputerCapacityDecision(f.sql, { mainId: f.target.hostRef.mainId,
      hostRef: f.target.hostRef }, f.profile, f.input.availableMemory, percent)).toEqual({ fits: false, reason: 'busy' })
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, percent))
      .toMatchObject({ state: 'busy', reasons: ['Build capacity is reserved.'] })
  })
  it('reports an allowance too small for even one build as setup required', async () => {
    const f = fixture('main')
    f.profile.measurement!.fingerprint.deviceLimits!.cpuLimit = 4
    expect(await buildComputerReadiness(f.input)(f.sql, f.target, 10)).toMatchObject({
      state: 'setup-required', reasons: ['The build allowance is too small for this runtime. Increase the allowance.'],
    })
  })
})
