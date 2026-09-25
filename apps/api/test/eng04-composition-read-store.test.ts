import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { makeWave25Fixture, RepeatOccurrenceV1Schema, RepeatDecisionV1Schema } from '@graphql/contracts/wave25'
import { PostgresRepeatOccurrenceReadStore } from '../src/modules/repeats/postgresReadStore.js'

// PG-shaped statement results, NOT a live database or native execution claim.
function fixture(detail = false) {
  const f = makeWave25Fixture('eng04-composition-store')
  const digest = 'sha256:' + '0'.repeat(64)
  const input = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
    runId: f.scope.runId, workflowVersionId: f.scope.workflowVersionId, limit: 2, includeResultData: detail }
  function row(index: number) {
    const occurrence = RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
      identity: { scope: { ...f.scope, executionSemanticsVersion: 3 }, blockId: 'repair', occurrenceId: `occ-${index}`, occurrenceIndex: index },
      input: { bindingId: `input-${index}`, inputDigest: digest, previous: index === 1 ? null : {
        occurrenceId: `occ-${index - 1}`, occurrenceIndex: index - 1, decisionId: `decision-${index - 1}`, acceptedResultDigest: digest,
      } },
    })
    const full = RepeatDecisionV1Schema.parse({ contractVersion: 1, decisionId: `decision-${index}`, occurrence,
      exitExecution: { ...f.identities[1]!, executionId: `exit-${index}`, occurrence: occurrence.identity },
      acceptedResultDigest: digest, outcome: 'issues', reason: 'repeat',
      target: { kind: 'next_occurrence', entryNodeId: f.version.entryNodeId, occurrenceIndex: index + 1 }, decidedAt: f.createdAt,
      resultData: { latestDeliverable: 'private-deliverable', remainingFindings: ['private-finding'] },
    })
    const { resultData, ...metadata } = full
    void resultData
    return { cursor_valid: true, occurrence_id: occurrence.identity.occurrenceId, block_id: 'repair', occurrence_index: index,
      occurrence, decision: detail ? full : metadata, decision_id: full.decisionId, exit_execution_id: full.exitExecution.executionId,
      result_digest: digest, accepted_result_digest: digest as string | null }
  }
  const query = vi.fn().mockResolvedValue({ rows: [row(1), row(2), row(3)] })
  return { input, row, query, store: new PostgresRepeatOccurrenceReadStore({ query } as unknown as pg.Pool) }
}
const emptyRow = { cursor_valid: true, occurrence_id: null, block_id: null, occurrence_index: null,
  occurrence: null, decision: null, decision_id: null, exit_execution_id: null, result_digest: null, accepted_result_digest: null }

describe('ENG04 composition real SQL adapter contract', () => {
  it('binds every scope dimension, resolves the cursor in the same statement, and uses bounded lookahead', async () => {
    const t = fixture()
    const page = await t.store.list(t.input)
    expect(page.items.map((item) => item.occurrence.identity.occurrenceId)).toEqual(['occ-1', 'occ-2'])
    expect(page.nextCursor).toBe('occ-2')
    expect(t.query).toHaveBeenCalledTimes(1)
    const [sql, values] = t.query.mock.calls[0]!
    expect(values).toEqual([t.input.workspaceId, t.input.workflowId, t.input.runId, t.input.workflowVersionId, null, 3])
    expect(sql).toContain('with cursor_row as')
    expect(sql).toContain("d.record - 'resultData' as decision")
    expect(sql).toContain('r.execution_id=d.exit_execution_id')
    expect(sql).not.toContain('input_json')
    expect(sql).not.toContain('result_json')
    expect(JSON.stringify(page)).not.toContain('private-')
    t.query.mockResolvedValue({ rows: [t.row(3)] })
    expect((await t.store.list({ ...t.input, afterOccurrenceId: 'occ-2' })).nextCursor).toBeNull()
    expect(t.query.mock.calls[1]![1]).toEqual([t.input.workspaceId, t.input.workflowId, t.input.runId, t.input.workflowVersionId, 'occ-2', 3])
  })
  it('returns the complete persisted result only on the explicit detail path', async () => {
    const t = fixture(true)
    const page = await t.store.list(t.input)
    expect(page.items[0]!.decision).toHaveProperty('resultData.latestDeliverable', 'private-deliverable')
    expect(t.query.mock.calls[0]![0]).toContain('d.record as decision')
  })
  it('does not infer native start from an occurrence with no decision', async () => {
    const t = fixture(), row = t.row(1)
    t.query.mockResolvedValue({ rows: [{ ...row, decision: null, decision_id: null, exit_execution_id: null,
      result_digest: null, accepted_result_digest: null }] })
    expect((await t.store.list(t.input)).items).toEqual([{ occurrence: row.occurrence, decision: null }])
  })
  it('distinguishes a valid empty tail from a missing/foreign scoped cursor', async () => {
    const t = fixture()
    t.query.mockResolvedValue({ rows: [emptyRow] })
    expect(await t.store.list({ ...t.input, afterOccurrenceId: 'last' })).toEqual({ items: [], nextCursor: null })
    t.query.mockResolvedValue({ rows: [{ ...emptyRow, cursor_valid: false }] })
    await expect(t.store.list({ ...t.input, afterOccurrenceId: 'foreign' })).rejects.toMatchObject({ code: 'REPEAT_CURSOR_INVALID' })
  })
  it.each(['scope', 'physical-id', 'physical-index', 'decision-id', 'execution', 'result', 'missing-result', 'order', 'duplicate', 'cursor', 'binding'])('rejects %s corruption rather than manufacturing readback', async (kind) => {
    const t = fixture(), rows = [t.row(1), t.row(2)]
    const r = rows[0]!
    if (kind === 'scope') r.occurrence.identity.scope.runId = 'foreign-run'
    if (kind === 'physical-id') r.occurrence_id = 'different-id'
    if (kind === 'physical-index') r.occurrence_index = 4
    if (kind === 'decision-id') r.decision_id = 'other-decision'
    if (kind === 'execution') r.exit_execution_id = 'other-execution'
    if (kind === 'result') r.accepted_result_digest = 'sha256:' + '1'.repeat(64)
    if (kind === 'missing-result') r.accepted_result_digest = null
    if (kind === 'order') rows.reverse()
    if (kind === 'duplicate') rows[1] = r
    if (kind === 'binding') r.decision.occurrence.input.bindingId = 'different-input'
    t.query.mockResolvedValue({ rows })
    await expect(t.store.list({ ...t.input, ...(kind === 'cursor' ? { afterOccurrenceId: 'occ-1' } : {}) }))
      .rejects.toMatchObject({ code: 'REPEAT_READBACK_RECORD_INVALID' })
  })
  it.each([0, 101, -1, 1.5])('rejects limit %s before SQL', async (limit) => {
    const t = fixture()
    await expect(t.store.list({ ...t.input, limit })).rejects.toBeTruthy()
    expect(t.query).not.toHaveBeenCalled()
  })
  it('does not turn a missing table or DB failure into an empty successful page', async () => {
    const t = fixture(), failure = Object.assign(new Error('test missing table'), { code: '42P01' })
    t.query.mockRejectedValue(failure)
    await expect(t.store.list(t.input)).rejects.toBe(failure)
  })
})
