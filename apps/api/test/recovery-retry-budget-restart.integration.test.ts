import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './helpers/retryBudget.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure, assertRecoveryReceipts,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']
const cases = forms.flatMap(form =>
  (['graceful', 'crash'] as const).map(mode => ({ form, mode })))

describeRetryBudget('finite technical retry budget: restart', () => {
  it.each(cases)('$form: $mode restart cannot reset the final attempt budget', async ({ form, mode }) => {
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
      await f.restart({ mode })
      const pending = await readback(f)
      expect(pending.record.cleanupPending).toBe(true)
      const pendingFinal = pending.details.find((detail) => detail.execution.executionId === finalId)!
      expect(pendingFinal.execution).toEqual(beforeView.details.find((detail) =>
        detail.execution.executionId === finalId)!.execution)
      expect(pendingFinal).not.toHaveProperty('reportedResult')
      expect(pendingFinal.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(f.provider.recoveryCalls).toEqual([])
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
      expect(final.execution.result).toEqual(finalDetail.reportedResult)
      expect(final.result_json).toBeNull()
      expect(f.provider.counts.attaches).toBe(0)
      if (mode === 'crash') {
        await assertRecoveryReceipts(f, [finalId], { detached: false })
      } else {
        expect(f.provider.recoveryCalls).toEqual([])
        expect(await readWorkflowClosure(f.base.db.pool, final.execution)).toMatchObject({
          execution: { id: finalId, runId: f.base.f.run.id, attempt: 2 },
          session: { nativeSessionId: final.execution.nativeSessionId },
          durableGeneration: expect.stringMatching(/^[1-9][0-9]*$/),
        })
      }
      expect(f.provider.counts.starts).toBe(2); expect(f.provider.counts.sessions).toBe(2)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
