import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  executionRows, fullRunInput, readback, recoveryFixture, toolValue, assertRecoveryReceipts, assertOriginalFailure,
  type Form, type RecoveryFixture,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['sequential', 'repeat']
const attempts = (rows: Awaited<ReturnType<typeof executionRows>>) => rows.map((row) => row.execution.attempt).sort((a, b) => a - b)
async function occurrences(f: RecoveryFixture, runId = f.base.f.run.id) {
  return (await f.base.db.pool.query<{ occurrence_index: number }>(
    'select occurrence_index from run_repeat_occurrences where run_id=$1 order by occurrence_index', [runId])).rows
}
function sameSlot(rows: Awaited<ReturnType<typeof executionRows>>) {
  expect(new Set(rows.map((row) => row.slot_id)).size).toBe(1)
  expect(new Set(rows.map((row) => row.input_json)).size).toBe(1)
  expect(new Set(rows.map((row) => row.input_digest)).size).toBe(1)
  expect(new Set(rows.map((row) => row.execution.id)).size).toBe(rows.length)
  for (const row of rows) {
    expect(row.execution.sessionContinuation).toBeUndefined()
    expect(row.execution.agentConfigurationVersionId).toBe(rows[0]!.execution.agentConfigurationVersionId)
    expect(row.execution.input).toEqual(rows[0]!.execution.input)
  }
}
afterEach(() => vi.restoreAllMocks())

// All work traverses the real V3 owner/repository/coordinator and original-source
// capture. Only external native transport is synthetic. The two-attempt ceiling
// is the current technical policy, NOT repeat.maxOccurrences or a full-Run retry.
describe.skipIf(!postgresEnabled)('ENG06-D finite technical retry budget', () => {
  it.each(forms)('%s: a retryable original failure exhausts at attempt two, including after restart', async (form) => {
    const f = await recoveryFixture(form, () => 'retryable_failure')
    try {
      f.launch(); await f.settled()
      const before = await readback(f), rows = await executionRows(f)
      expect(before.record.run).toMatchObject({ executionState: 'completed', outcome: 'failed', result: { outcome: 'failed' } })
      expect(before.record.cleanupPending).toBe(false)
      expect(rows).toHaveLength(2); expect(attempts(rows)).toEqual([1, 2]); sameSlot(rows)
      expect(rows.every((row) => row.execution.workflowNodeId === f.base.f.version.entryNodeId)).toBe(true)
      for (const row of rows) await assertOriginalFailure(f, row.execution.id, true)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.provider.counts.starts).toBe(2)
      const submitted = f.provider.submissions.map((item) => item.request.executionId)
      await f.restart()
      // Repeated recovery ticks cannot reset the technical counter, silently
      // create a new Run, or replace the saved business repeat policy.
      for (let tick = 0; tick < 3; tick++) await f.runtime.engine.reconcile((error) => f.errors.push(error))
      await f.settled()
      expect(await readback(f)).toEqual(before)
      expect(f.provider.submissions.map((item) => item.request.executionId)).toEqual(submitted)
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [f.base.f.scope.workflowId])).rows).toHaveLength(1)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: restart during the final technical attempt cannot reset its persisted retry budget', async (form) => {
    const f = await recoveryFixture(form, (submission) => submission.attempt === 1 ? 'retryable_failure' : 'durable_failure_gap')
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).map((row) => ({
        attempt: row.execution.attempt, state: row.execution.state,
      })).sort((a, b) => a.attempt - b.attempt), { timeout: 20000 })
        .toEqual([{ attempt: 1, state: 'completed' }, { attempt: 2, state: 'running' }])
      const before = await executionRows(f)
      const finalId = before.find((row) => row.execution.attempt === 2)!.execution.id
      await expect.poll(() => f.provider.atBarrier(finalId), { timeout: 20000 }).toBe(true)
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
      const interrupted = after.find((row) => row.execution.attempt === 2)!
      expect(interrupted.execution.result).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: false } })
      expect(interrupted.result_json).toBeNull()
      expect(f.provider.counts.attaches).toBe(0)
      await assertRecoveryReceipts(f, [finalId])
      expect(f.provider.counts.starts).toBe(2); expect(f.provider.counts.sessions).toBe(2)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
      expect(f.shutdownErrors).toEqual([])
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: each successful business occurrence has its own bounded technical attempts and frozen input', async (form) => {
    const f = await recoveryFixture(form, (submission) => submission.request.workflowNodeId.endsWith('-0') && submission.attempt === 1
      ? 'retryable_failure' : 'success')
    try {
      f.launch(); await f.settled()
      const view = await readback(f), rows = await executionRows(f), rounds = form === 'repeat' ? 3 : 1
      expect(view.record.run, JSON.stringify(f.diagnostics())).toMatchObject({ executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' } })
      expect(rows).toHaveLength(rounds * 3)
      const entry = rows.filter((row) => row.execution.workflowNodeId === f.base.f.version.entryNodeId)
      const slots = new Set(entry.map((row) => row.slot_id))
      expect(slots.size).toBe(rounds)
      for (const slot of slots) {
        const group = entry.filter((row) => row.slot_id === slot)
        expect(attempts(group)).toEqual([1, 2]); sameSlot(group)
        expect(group.find((row) => row.execution.attempt === 1)!.execution.result?.outcome).toBe('failed')
        expect(group.find((row) => row.execution.attempt === 2)!.execution.result?.outcome).toBe('succeeded')
      }
      const exits = rows.filter((row) => row.execution.workflowNodeId !== f.base.f.version.entryNodeId)
      expect(exits).toHaveLength(rounds)
      expect(exits.every((row) => row.execution.attempt === 1)).toBe(true)
      const persisted = await occurrences(f)
      expect(persisted.map((row) => Number(row.occurrence_index))).toEqual(form === 'repeat' ? [1, 2, 3] : [])
      if (form === 'repeat') {
        expect(f.base.f.version.definition.repeat!.blocks[0]!.maxOccurrences).toBe(3)
        expect(new Set(entry.map((row) => row.input.occurrence?.identity.occurrenceIndex))).toEqual(new Set([1, 2, 3]))
      } else {
        expect(f.base.f.version.definition).not.toHaveProperty('repeat')
        for (const row of rows) { expect(row.input.occurrence).toBeNull(); expect(row.input.entry).toBeNull() }
      }
      expect(f.provider.counts.starts).toBe(rows.length)
      expect(f.provider.counts.sessions).toBe(rows.length)
      // Failed attempts must never become downstream accepted predecessor inputs.
      for (const row of exits) {
        expect(row.input.predecessors).toHaveLength(1)
        expect(row.input.predecessors[0]!.execution.attempt).toBe(2)
        expect(row.input.predecessors[0]!.acceptedResult.outcome).toBe('succeeded')
      }
    } finally { await f.close() }
  }, 150000)

  it.each(forms)('%s: a non-retryable original failure cannot spend a technical retry', async (form) => {
    const f = await recoveryFixture(form, () => 'permanent_failure')
    try {
      f.launch(); await f.settled()
      const view = await readback(f), rows = await executionRows(f)
      expect(view.record.run.outcome).toBe('failed')
      expect(attempts(rows)).toEqual([1]); expect(f.provider.counts.starts).toBe(1)
      await assertOriginalFailure(f, rows[0]!.execution.id, false)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? 1 : 0)
    } finally { await f.close() }
  }, 90000)

  it.each(forms)('%s: the shared Run execution budget can stop retries before the per-slot ceiling', async (form) => {
    const rounds = form === 'repeat' ? 3 : 1, budget = rounds * 2
    const f = await recoveryFixture(form, (submission) => submission.request.workflowNodeId.endsWith('-1')
      && (submission.occurrenceIndex ?? 1) === rounds ? 'retryable_failure' : 'success', budget)
    try {
      f.launch(); await f.settled()
      const view = await readback(f), rows = await executionRows(f)
      expect(view.record.run.outcome).toBe('failed')
      expect(rows).toHaveLength(budget)
      expect(rows.every((row) => row.execution.attempt === 1)).toBe(true)
      const failed = rows.filter((row) => row.execution.result?.outcome === 'failed')
      expect(failed).toHaveLength(1)
      await assertOriginalFailure(f, failed[0]!.execution.id, true)
      expect(f.provider.counts.starts).toBe(budget)
      expect(await occurrences(f)).toHaveLength(form === 'repeat' ? rounds : 0)
      expect(f.base.f.version.definition.executionPolicy!.maxNodeExecutions).toBe(budget)
    } finally { await f.close() }
  }, 90000)

  describe.each(forms)('%s full-Run retry is a separate authorization and identity', (form) => {
    it.each(['http', 'mcp'] as const)('%s Start replay creates only one NEW Run with a fresh technical budget', async (via) => {
      const f = await recoveryFixture(form, () => 'retryable_failure')
      try {
        f.launch(); await f.settled()
        const old = await readback(f), oldRows = await executionRows(f)
        await f.restart()
        const input = await fullRunInput(f)
        const start = async () => {
          if (via === 'mcp') return RunStartV3ResultSchema.parse(toolValue(await f.transport.client.callTool({ name: 'run_start', arguments: input })))
          const response = await f.transport.app.inject({ method: 'POST',
            url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`,
            headers: { authorization: `Bearer ${f.base.writer.token}` }, payload: input })
          expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200)
          expect(response.statusCode, response.body).toBeLessThan(300)
          return RunStartV3ResultSchema.parse(response.json())
        }
        const accepted = await start(), replayed = await start()
        expect(accepted.accepted).toBe(true); expect(accepted.replayed).toBe(false)
        expect(accepted.run.id).not.toBe(old.record.run.id)
        expect(replayed.replayed).toBe(true); expect(replayed.run.id).toBe(accepted.run.id)
        expect(accepted.run.input).toEqual(old.record.run.input)
        expect(accepted.run.workflowVersionId).toBe(old.record.run.workflowVersionId)
        expect(accepted.run.agentConfigurationVersionIds).toEqual(old.record.run.agentConfigurationVersionIds)
        await f.settled(accepted.run.id)
        const fresh = await readback(f, accepted.run.id), newRows = await executionRows(f, accepted.run.id)
        expect(fresh.record.run.outcome).toBe('failed')
        expect(attempts(newRows), JSON.stringify({ rows: newRows.map((row) => row.execution), diagnostics: f.diagnostics() })).toEqual([1, 2]); sameSlot(newRows)
        for (const row of newRows) await assertOriginalFailure(f, row.execution.id, true)
        expect(newRows.every((row) => !oldRows.some((oldRow) => oldRow.execution.id === row.execution.id))).toBe(true)
        expect(await readback(f)).toEqual(old)
        expect(f.provider.counts.starts).toBe(4)
        expect(await occurrences(f, accepted.run.id)).toHaveLength(form === 'repeat' ? 1 : 0)
        if (form === 'repeat') expect(newRows[0]!.input.occurrence!.identity.occurrenceId)
          .not.toBe(oldRows[0]!.input.occurrence!.identity.occurrenceId)
        expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toHaveLength(2)
        expect(f.shutdownErrors).toEqual([])
      } finally { await f.close() }
    }, 90000)
  })
})
