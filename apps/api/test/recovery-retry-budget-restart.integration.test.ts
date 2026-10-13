import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './helpers/retryBudget.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure, assertRecoveryReceipts,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']
const cases = forms.flatMap(form =>
  (['retained', 'unavailable'] as const).map(history => ({ form, history })))

describeRetryBudget('finite technical retry budget: restart', () => {
  it.each(cases)('$form: restart with $history failure history cannot reset the final attempt budget', async ({ form, history }) => {
    const finalFault = history === 'retained' ? 'durable_failure_gap' : 'unavailable_failure_history'
    const f = await recoveryFixture(form, submission => submission.attempt === 1 ? 'retryable_failure' : finalFault)
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).map((row) => ({
        attempt: row.execution.attempt, state: row.execution.state,
      })).sort((a, b) => a.attempt - b.attempt), { timeout: 20000, interval: 50 })
        .toEqual([{ attempt: 1, state: 'completed' }, { attempt: 2, state: 'running' }])
      const before = await executionRows(f)
      const finalId = before.find((row) => row.execution.attempt === 2)!.execution.id
      await expect.poll(() => f.provider.atBarrier(finalId), { timeout: 20000, interval: 50 }).toBe(true)
      expect(f.provider.originalResult(finalId)).toMatchObject({ outcome: 'failed', error: { retryable: true } })
      sameSlot(before)
      expect(before.find((row) => row.execution.attempt === 1)!.execution.result?.outcome).toBe('failed')
      expect(before.find((row) => row.execution.attempt === 2)!.execution.result).toBeUndefined()
      await f.restart(); await f.settled()
      const after = await executionRows(f), view = await readback(f)
      expect(view.record.run).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect(attempts(after)).toEqual([1, 2]); sameSlot(after)
      expect(after.map((row) => row.execution.id).sort()).toEqual(before.map((row) => row.execution.id).sort())
      const first = after.find((row) => row.execution.attempt === 1)!
      expect(first.execution).toEqual(before.find((row) => row.execution.attempt === 1)!.execution)
      await assertOriginalFailure(f, first.execution.id, true)
      const final = after.find((row) => row.execution.attempt === 2)!
      if (history === 'unavailable') {
        expect(final.execution.result).toMatchObject({ outcome: 'failed',
          error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      } else {
        await assertOriginalFailure(f, final.execution.id, true)
      }
      expect(final.result_json).toBeNull()
      expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [finalId])
      expect(f.provider.counts.starts).toBe(2); expect(f.provider.counts.sessions).toBe(2)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
