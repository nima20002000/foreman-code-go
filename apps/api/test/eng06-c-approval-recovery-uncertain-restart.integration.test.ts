import { describe, expect, it } from 'vitest'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import {
  createApprovalRecoverySetup,
  startWaiting,
  assertInterrupted,
  assertPredecessorsUnchanged,
} from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: uncertain restart`, () => {
    it('keeps a sent-but-unacknowledged response uncertain after restart, then interrupts without cold attach or resend', async () => {
      const t = await setup(form), pending = await startWaiting(t)
      const before = await readCurrentExecutions(t.runtime.runs, t.runId)
      t.faults.hideResponseEvidence = true
      const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
      expect(response.interaction.deliveryState).toBe('uncertain')
      expect(await t.f.receipts()).toHaveLength(0)
      await t.compare(); await t.restart()
      const detached = await t.closureRows()
      t.faults.hideResponseEvidence = false
      // The provider has retained history, but the NEW coordinator must not
      // attach it. No persisted original delivery evidence exists in this fault.
      const observed = await t.runtime.service.reconcile(response.interaction)
      expect(observed).toMatchObject({ id: pending.id, deliveryState: 'uncertain' })
      expect(t.f.provider.counts.attaches).toBe(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      await t.recoverUntilSettled(); await assertInterrupted(t, pending.executionId!)
      expect(await t.closureRows()).toEqual(detached)
      await assertPredecessorsUnchanged(t, before)
      expect(await t.f.receipts()).toHaveLength(0)
      await t.assertNoNativeAcknowledgement(pending.id)
      expect(t.faults.responseWrites).toEqual([{ sessionId: pending.nativeSessionId,
        requestId: pending.nativeRequestId, optionId: approvalResponse(pending).optionId }])
      expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1 })
    }, 90000)
  })
}
