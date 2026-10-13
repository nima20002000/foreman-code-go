import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { executionRows, readback, recoveryFixture } from './helpers/eng06DRecovery.js'
import { forms, parked } from './helpers/recoveryReadback.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('ENG06-D recovery readback over real HTTP and authenticated Operator MCP', () => {
  it.each(forms)('%s: graceful restart closes an ephemeral turn before releasing its Run owner', async (form) => {
    const f = await recoveryFixture(form, () => 'park')
    try {
      f.launch()
      const before = await parked(f)
      await f.restart()
      const pending = await readback(f)
      expect(pending.record).toEqual({ ...before.record, cleanupPending: true })
      expect(pending.details[0]!.execution).toEqual(before.details[0]!.execution)
      expect(pending.details[0]!.acceptedInput).toEqual(before.details[0]!.acceptedInput)
      expect(pending.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(pending.details[0]).not.toHaveProperty('reportedResult')
      expect(f.provider.counts).toMatchObject({ starts: 1, sessions: 1, cancels: 1, closes: 1, attaches: 0 })
      expect(f.provider.recoveryCalls).toEqual([])
      await f.settled()
      const after = await readback(f)
      expect(after.record).toMatchObject({ run: { executionState: 'completed', outcome: 'failed',
        result: { error: { code: 'EXECUTION_INTERRUPTED', retryable: false } } }, cleanupPending: false })
      expect(after.details[0]!.execution.executionId).toBe(before.details[0]!.execution.executionId)
      expect(after.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
      expect(f.provider.recoveryCalls).toEqual([])
      expect(f.provider.counts.starts).toBe(1)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: a non-detachable native lifetime closes at restart without a terminal or replay', async (form) => {
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
      const closure = await readWorkflowClosure(f.base.db.pool, abandoned.execution)
      expect(closure).toMatchObject({ execution: { id: original, runId: f.base.f.run.id },
        session: { nativeSessionId: abandoned.execution.nativeSessionId },
        durableGeneration: expect.stringMatching(/^[1-9][0-9]*$/) })
      expect(f.provider.recoveryCalls).toEqual([])
      expect(after.record.run.input).toEqual(before.record.run.input)
      expect(after.record.run.workflowVersionId).toBe(before.record.run.workflowVersionId)
      // Completed recovery remains stable under further reconciliation/readback.
      const submissions = f.provider.counts.starts
      await f.runtime.engine.reconcile((error) => f.errors.push(error))
      expect(await readback(f)).toEqual(after)
      expect(await readWorkflowClosure(f.base.db.pool, abandoned.execution)).toEqual(closure)
      expect(f.provider.counts.starts).toBe(submissions)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)
})
