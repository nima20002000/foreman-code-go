import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './helpers/retryBudget.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import {
  executionRows, readback, recoveryFixture, assertOriginalFailure,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']
const cases = forms.flatMap(form =>
  (['graceful', 'crash'] as const).map(mode => ({ form, mode })))

describeRetryBudget('finite technical retry budget: restart', () => {
  it.each(cases)('$form: $mode restart retries the lost attempt but cannot reset the attempt limit', async ({ form, mode }) => {
    // Attempt 2 is lost to the restart; attempt 3 is the last one the policy allows.
    const f = await recoveryFixture(form, submission => submission.attempt === 2 ? 'durable_failure_gap' : 'retryable_failure')
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).map((row) => ({
        attempt: row.execution.attempt, state: row.execution.state,
      })).sort((a, b) => a.attempt - b.attempt), { timeout: 20000, interval: 50 })
        .toEqual([{ attempt: 1, state: 'completed' }, { attempt: 2, state: 'running' }])
      const before = await executionRows(f)
      const interruptedId = before.find((row) => row.execution.attempt === 2)!.execution.id
      await expect.poll(() => f.provider.atBarrier(interruptedId), { timeout: 20000, interval: 50 }).toBe(true)
      sameSlot(before)
      await f.restart({ mode })
      await f.settled()
      const after = await executionRows(f), view = await readback(f)
      expect(view.record.run).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect(view.record.cleanupPending).toBe(false)
      expect(attempts(after)).toEqual([1, 2, 3]); sameSlot(after)
      const first = after.find((row) => row.execution.attempt === 1)!
      expect(first.execution).toEqual(before.find((row) => row.execution.attempt === 1)!.execution)
      await assertOriginalFailure(f, first.execution.id, true)
      const interrupted = view.details.find((detail) => detail.execution.executionId === interruptedId)!
      expect(interrupted.execution).toMatchObject({ attempt: 2, state: 'completed' })
      expect(interrupted.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(interrupted.reportedResult).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: true } })
      const interruptedRow = after.find((row) => row.execution.attempt === 2)!
      expect(await readWorkflowClosure(f.base.db.pool, interruptedRow.execution)).toMatchObject({
        execution: { id: interruptedId, runId: f.base.f.run.id, attempt: 2 },
        durableGeneration: expect.stringMatching(/^[1-9][0-9]*$/),
      })
      const final = after.find((row) => row.execution.attempt === 3)!
      await assertOriginalFailure(f, final.execution.id, true)
      expect(final.result_json).toBeNull()
      // Further recovery ticks cannot reset the attempt counter or start a fourth attempt.
      for (let tick = 0; tick < 3; tick++) await f.runtime.engine.reconcile((error) => f.errors.push(error))
      expect(await readback(f)).toEqual(view)
      expect(f.provider.counts.starts).toBe(3); expect(f.provider.counts.sessions).toBe(3)
      expect(f.provider.counts.attaches).toBe(0)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
