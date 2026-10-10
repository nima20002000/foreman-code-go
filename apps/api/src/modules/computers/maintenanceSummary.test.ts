import { describe, expect, it } from 'vitest'
import type { ComputerMaintenanceList, MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import { maintenanceReadResult } from './maintenanceSummary.js'

describe('maintenance summaries', () => {
  it('includes failures at the 24-hour boundary once and preserves offline computers', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const task = (id: string, finishedAt: string): MaintenanceTask => ({
      id, kind: 'update-system', state: 'failed', startedAt: finishedAt, finishedAt,
      summary: 'Update failed', outputTail: 'diagnostic output',
    })
    const latest = task('11111111-1111-4111-8111-111111111111', '2026-10-10T11:00:00Z')
    const boundary = task('22222222-2222-4222-8222-222222222222', '2026-10-09T12:00:00Z')
    const expired = task('33333333-3333-4333-8333-333333333333', '2026-10-09T11:59:59Z')
    const target = { hostRef: { kind: 'main' as const, mainId: 'main' },
      applicationInstallationId: 'main', keyRevision: null, authorizationRevision: null }
    const result: ComputerMaintenanceList = { computers: [
      { target, status: { harnesses: [], observedAt: new Date(now).toISOString(),
        system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null },
        tasks: [expired, boundary, latest] } },
      { target, status: null },
    ] }
    const compact = maintenanceReadResult(result, {}, now)
    expect(compact.computers[0]!.status!.tasks.map(task => task.id)).toEqual([latest.id, boundary.id])
    expect(compact.computers[1]!.status).toBeNull()
    expect(result.computers[0]!.status!.tasks).toEqual([expired, boundary, latest])
    expect(maintenanceReadResult(result, { detail: 'full' }, now)).toEqual(result)
  })
})
