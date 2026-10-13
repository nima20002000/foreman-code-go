import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './helpers/retryBudget.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure, assertRecoveryReceipts,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']
const cases = forms.flatMap(form =>
  (['cleanup', 'reattach'] as const).map(recovery => ({ form, recovery })))

describeRetryBudget('finite technical retry budget: restart', () => {
  it.each(cases)('$form: $recovery after restart cannot reset the final attempt budget', async ({ form, recovery }) => {
    const f = await recoveryFixture(form, submission => submission.attempt === 1 ? 'retryable_failure' : 'durable_failure_gap')
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).map((row) => ({
        attempt: row.execution.attempt, state: row.execution.state,
      })).sort((a, b) => a.attempt - b.attempt), { timeout: 20000, interval: 50 })
        .toEqual([{ attempt: 1, state: 'completed' }, { attempt: 2, state: 'running' }])
      const before = await executionRows(f)
      const finalId = before.find((row) => row.execution.attempt === 2)!.execution.id
      await expect.poll(() => f.provider.atBarrier(finalId), { timeout: 20000, interval: 50 }).toBe(true)
      const beforeView = await readback(f)
      expect(f.provider.originalResult(finalId)).toMatchObject({ outcome: 'failed', error: { retryable: true } })
      sameSlot(before)
      expect(before.find((row) => row.execution.attempt === 1)!.execution.result?.outcome).toBe('failed')
      expect(before.find((row) => row.execution.attempt === 2)!.execution.result).toBeUndefined()
      await f.restart()
      if (recovery === 'cleanup') {
        const owner = await f.runtime.runs.acquireOwnership(f.base.f.run.id, () => undefined)
        if (!owner) throw new Error('The restarted Run is already owned.')
        try {
          await f.runtime.runs.requestCleanup(f.base.f.run.id, owner)
        } finally {
          await owner.release()
        }
      }
      await f.settled()
      const after = await executionRows(f), view = await readback(f)
      expect(view.record.run).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect(view.record.cleanupPending).toBe(false)
      expect(view.page.items.map((item) => item.executionId).sort())
        .toEqual(beforeView.page.items.map((item) => item.executionId).sort())
      const finalDetail = view.details.find((detail) => detail.execution.executionId === finalId)!
      const beforeDetail = beforeView.details.find((detail) => detail.execution.executionId === finalId)!
      expect(finalDetail.execution).toMatchObject({ attempt: 2, state: 'completed' })
      expect(finalDetail.acceptedInput).toEqual(beforeDetail.acceptedInput)
      expect(finalDetail.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(finalDetail.reportedResult).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(f.provider.originalResult(finalId)).toMatchObject({ outcome: 'failed', error: { retryable: true } })
      await f.runtime.engine.reconcile((error) => f.errors.push(error))
      expect(await readback(f)).toEqual(view)
      expect(attempts(after)).toEqual([1, 2]); sameSlot(after)
      expect(after.map((row) => row.execution.id).sort()).toEqual(before.map((row) => row.execution.id).sort())
      const first = after.find((row) => row.execution.attempt === 1)!
      expect(first.execution).toEqual(before.find((row) => row.execution.attempt === 1)!.execution)
      await assertOriginalFailure(f, first.execution.id, true)
      const final = after.find((row) => row.execution.attempt === 2)!
      if (recovery === 'cleanup') {
        expect(final.execution.result).toMatchObject({ outcome: 'failed',
          error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      } else {
        await assertOriginalFailure(f, final.execution.id, true)
      }
      expect(final.result_json).toBeNull()
      if (recovery === 'cleanup') {
        expect(f.provider.counts.attaches).toBe(0)
        await assertRecoveryReceipts(f, [finalId])
      } else {
        expect(f.provider.counts.attaches).toBe(1)
        expect(f.provider.recoveryCalls).toEqual([])
      }
      expect(f.provider.counts.starts).toBe(2); expect(f.provider.counts.sessions).toBe(2)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
