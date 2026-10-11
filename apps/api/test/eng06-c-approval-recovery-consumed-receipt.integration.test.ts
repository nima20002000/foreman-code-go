import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { createApprovalRecoverySetup, startWaiting, assertInterrupted } from './helpers/approvalRecovery.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: consumed receipt`, () => {
    it('preserves the consumed graph receipt without manufacturing a native ACK after restart', async () => {
      const t = await setup(form), pending = await startWaiting(t), gate = t.faults.holdWorkerAcknowledgement()
      const response = t.runtime.service.respond(t.responder, approvalResponse(pending))
        .then((value) => ({ value }), (error: unknown) => ({ error }))
      try {
        await gate.entered
        expect((await t.runtime.repository.get(pending.id))?.deliveryState).toBe('delivered')
        const consumed = await t.f.receipts()
        expect(consumed).toHaveLength(1)
        const resumeRows = await t.resumeRows(pending.id)
        expect(resumeRows).toEqual([{ state: 'resumed', approval_native_ack_id: null, approval_native_ack_record: null }])
        await t.assertNoNativeAcknowledgement(pending.id)
        await t.restart(); await response
        gate.release()
        await t.runtime.engine.resume(t.runId)
        await assertInterrupted(t, pending.executionId!)
        expect(await t.f.receipts()).toEqual(consumed)
        expect(await t.resumeRows(pending.id)).toEqual(resumeRows)
        await t.assertNoNativeAcknowledgement(pending.id)
        expect(t.f.provider.counts).toMatchObject({ starts: 2, responses: 1, attaches: 0 })
      } finally { gate.release(); await response }
    }, 90000)
  })
}
