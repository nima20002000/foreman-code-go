import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, recoveryFixture, assertRecoveryReceipts } from './helpers/eng06DRecovery.js'
import { forms, parked } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: provider-only history behind a lost reply is not an accepted result after restart', async (form) => {
    const f = await recoveryFixture(form, () => 'durable_reply_gap')
    try {
      f.launch(); const before = await parked(f), original = before.details[0]!.execution.executionId
      // This is provider durability, NOT an application result/acceptance COMMIT.
      // d32a361 deliberately does not cold-attach to fetch that provider history.
      expect(f.provider.originalResult(original)?.outcome).toBe('succeeded')
      await f.restart()
      const during = await readback(f), counts = { ...f.provider.counts }
      // Restart durably fences reentry before original transport detachment.
      // It changes no model result, accepted input, task, session or Run fact;
      // recovery/settlement below, not provider history, clears this obligation.
      expect(during).toEqual({ ...before, record: { ...before.record, cleanupPending: true },
        page: { ...before.page, run: { ...before.page.run, cleanupPending: true } },
        details: before.details.map((detail) => ({ ...detail, run: { ...detail.run, cleanupPending: true } })) })
      expect((await f.base.db.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.base.f.run.id])).rows).toEqual([{ pending: true }])
      expect(f.provider.recoveryCalls).toEqual([])
      await f.settled()
      const after = await readback(f), recovered = after.details[0]!
      expect(after.record).toMatchObject({ run: { executionState: 'completed', outcome: 'failed',
        result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } },
      cleanupPending: false, stopRequested: false })
      expect(after.details).toHaveLength(1)
      expect(recovered.execution).toMatchObject({ executionId: original, attempt: 1, state: 'completed' })
      expect(recovered.reportedResult).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(recovered.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(recovered.acceptedInput).toEqual(before.details[0]!.acceptedInput)
      expect(f.provider.originalResult(original)?.outcome).toBe('succeeded')
      expect(f.provider.counts.starts).toBe(counts.starts)
      expect(f.provider.counts.sessions).toBe(counts.sessions)
      expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [original])
      expect(after.record.run.agentConfigurationVersionIds).toEqual(before.record.run.agentConfigurationVersionIds)
      expect(after.record.run.executionLocation).toEqual(before.record.run.executionLocation)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
