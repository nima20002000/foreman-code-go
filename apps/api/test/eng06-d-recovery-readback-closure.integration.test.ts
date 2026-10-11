import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, recoveryFixture, assertRecoveryReceipts } from './helpers/eng06DRecovery.js'
import { forms, parked } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: missing physical closure evidence stays uncertain until an exact receipt becomes available', async (form) => {
    const f = await recoveryFixture(form, () => 'park')
    try {
      f.launch(); const before = await parked(f), id = before.details[0]!.execution.executionId
      await f.restart()
      f.provider.recoveryProofAvailable = false
      await expect(f.runtime.engine.start(f.base.f.run.id)).rejects.toThrow()
      const pending = await readback(f)
      expect(pending.record).toMatchObject({ run: { executionState: 'running', outcome: 'pending' }, cleanupPending: true })
      expect(pending.record.run).not.toHaveProperty('result')
      expect(pending.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
      expect((await f.base.db.pool.query('select generation from execution_native_recoveries where execution_id=$1', [id])).rows).toEqual([])
      expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.attaches).toBe(0)
      f.provider.recoveryProofAvailable = true
      await f.settled()
      const settled = await readback(f)
      expect(settled.record).toMatchObject({ run: { executionState: 'completed', outcome: 'failed',
        result: { error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } }, cleanupPending: false })
      await assertRecoveryReceipts(f, [id])
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
