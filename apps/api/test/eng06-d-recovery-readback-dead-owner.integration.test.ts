import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { executionRows, readback, recoveryFixture, assertRecoveryReceipts } from './helpers/eng06DRecovery.js'
import { forms, parked } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: a dead native owner without a durable terminal cannot leave the Run running forever', async (form) => {
    let first = true
    const f = await recoveryFixture(form, () => { if (first) { first = false; return 'park' } return 'success' })
    try {
      f.launch(); const before = await parked(f), original = before.details[0]!.execution.executionId
      await f.restart(); await f.settled()
      const after = await readback(f), rows = await executionRows(f), abandoned = rows.find((row) => row.execution.id === original)!
      expect(after.record.cleanupPending).toBe(false)
      expect(after.record.run.executionState).toBe('completed')
      expect(abandoned.execution.state).toBe('completed')
      expect(abandoned.execution.result).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(after.record.run).toMatchObject({ outcome: 'failed', result: { outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } })
      expect(abandoned.result_json).toBeNull()
      // Conservative interruption is not an original retryable native failure.
      // Neither a technical attempt nor a business occurrence is manufactured.
      expect(rows).toHaveLength(1)
      expect(rows[0]!.execution.attempt).toBe(1)
      expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [original])
      expect(after.record.run.input).toEqual(before.record.run.input)
      expect(after.record.run.workflowVersionId).toBe(before.record.run.workflowVersionId)
      // Completed recovery remains stable under further reconciliation/readback.
      const submissions = f.provider.counts.starts
      await f.runtime.engine.reconcile((error) => f.errors.push(error))
      expect(await readback(f)).toEqual(after)
      expect(f.provider.counts.starts).toBe(submissions)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
