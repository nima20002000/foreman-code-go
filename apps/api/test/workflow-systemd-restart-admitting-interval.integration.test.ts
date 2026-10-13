import { beforeAll, describe, expect, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  let recovered: Awaited<ReturnType<typeof assertInstalledWorkflowRestart>>
  beforeAll(async () => {
    recovered = await assertInstalledWorkflowRestart('admitting interval')
  }, 600_000)

  it('reattaches graph work and its admitting interval check, then closes their processes', () => {
    expect(recovered.run.executionState).toBe('running')
  })

  it('persists both original turn admissions before recovering the blocked interval session', () => {
    const active = recovered.executions.filter(execution => execution.state === 'running')
    expect(active).toHaveLength(2)
    for (const execution of active) {
      expect(recovered.activity.some(activity => activity.harnessExecutionId === execution.id
        && activity.payload.nativeEventType === 'turn.started')).toBe(true)
    }
  })
})
