import { describe, expect, it } from 'vitest'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { createApprovalRecoverySetup, assertInterrupted } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: mid execution recovery`, () => {
    it('settles a dead mid-execution native lifetime after restart with EXECUTION_INTERRUPTED and no replay', async () => {
      const t = await setup(form, { approvals: false }), gate = t.faults.holdNextTurn()
      const started = t.runtime.engine.start(t.runId).then(() => undefined, (error: unknown) => error)
      try {
        const sessionId = await gate.entered
        const execution = (await readCurrentExecutions(t.runtime.runs, t.runId)).find((item) => item.nativeSessionId === sessionId)!
        expect(execution.state).toBe('running')
        await t.compare()
        t.faults.killOnRestart = true
        await t.restart(); await started
        expect(t.faults.deadSessions.has(sessionId)).toBe(true)
        const detached = await t.closureRows()
        await t.recoverUntilSettled(); await assertInterrupted(t, execution.id)
        expect(await t.closureRows()).toEqual(detached)
        expect(t.f.provider.counts).toMatchObject({ starts: 1, responses: 0, attaches: 0 })
      } finally { gate.release(); await started }
    }, 90000)
  })
}
