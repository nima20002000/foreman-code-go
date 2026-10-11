import { describe, expect, it } from 'vitest'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import {
  createApprovalRecoverySetup,
  loseGraphAcknowledgement,
  assertInterrupted,
  assertPredecessorsUnchanged,
} from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: delivered restart`, () => {
    it('retains proven delivery but does not consume a lost graph acknowledgement for a cold requester', async () => {
      const t = await setup(form), { pending, delivered } = await loseGraphAcknowledgement(t)
      const before = await readCurrentExecutions(t.runtime.runs, t.runId)
      await t.restart()
      const detached = await t.closureRows()
      await t.runtime.engine.resume(t.runId)
      await assertInterrupted(t, pending.executionId!)
      expect(await t.runtime.repository.get(pending.id)).toMatchObject({ deliveryState: 'delivered',
        nativeSessionId: delivered.nativeSessionId, selectedOptionId: delivered.selectedOptionId })
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      await assertPredecessorsUnchanged(t, before)
      expect(await t.closureRows()).toEqual(detached)
      const receipts = await t.recoveryRows()
      await t.runtime.engine.resumeInteraction(delivered)
      expect(await t.recoveryRows()).toEqual(receipts)
      await expect(t.runtime.service.respond(t.responder, approvalResponse(pending)))
        .rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      await t.settled('failed')
    }, 90000)
  })
}
