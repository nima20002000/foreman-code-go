import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'
import { RunSubagentService } from './service.js'

const scope = { workspaceId: 'workspace', runId: 'run' }
const principal = { id: 'principal' } as ManagementPrincipal

describe('background subagent recovery diagnostics', () => {
  it('reports a failed scheduled recovery, drains it safely, and permits a later retry', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('private native content'))
    const report = vi.fn()
    const service = new RunSubagentService({ connect } as unknown as pg.Pool, undefined, vi.fn(), report)
    service.scheduleRecovery(principal, scope)
    service.scheduleRecovery(principal, scope)
    await service.close()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledExactlyOnceWith({ ...scope, code: 'SUBAGENT_RECOVERY_FAILED' })
    service.scheduleRecovery(principal, scope)
    await service.close()
    expect(connect).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('does not leave an unhandled task when a diagnostic sink fails', async () => {
    const service = new RunSubagentService({ connect: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as pg.Pool,
      undefined, vi.fn(), () => { throw new Error('diagnostic sink unavailable') })
    service.scheduleRecovery(principal, scope)
    await expect(service.close()).resolves.toBeUndefined()
  })
})
