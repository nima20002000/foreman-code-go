import type pg from 'pg'
import { currentSaveAdmissionFixture } from './helpers/currentSaveAdmission.js'
import { describe, expect, it, vi } from 'vitest'
import { assertMeaningfulSaveAdmitted } from '../src/modules/graph-drafts/saveAdmission.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from '../src/modules/run-graph/publicObligations.js'

/** Query-boundary unit tests, not substitutes for the opt-in PostgreSQL fixture. */
describe('NIM-2642 publication admission query', () => {
  const { f, row: settledRow, record } = currentSaveAdmissionFixture('save-admission')
  const input = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, stagedAgentIds: ['b', 'a', 'b'] }
  it.each([true, undefined, null])('fails closed on blocked/missing native evidence (%s)', async (native) => {
    const query = vi.fn(async () => ({ rows: [{ ...settledRow, native }], rowCount: 1 }))
    await expect(assertMeaningfulSaveAdmitted({ query } as unknown as Pick<pg.PoolClient, 'query'>, input))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it.each([
    { record: { ...record, executionSemanticsVersion: 2 } },
    { record: { ...record, workflowVersionId: 'another-version' } },
    { version_row: null },
    { configurations: [] },
    { version_row: { ...settledRow.version_row, record: { ...f.version, contentHash: `sha256:${'0'.repeat(64)}` } } },
  ])('rejects settled flags without a complete exact current snapshot (%j)', async (change) => {
    const query = vi.fn(async () => ({ rows: [{ ...settledRow, ...change }], rowCount: 1 }))
    await expect(assertMeaningfulSaveAdmitted({ query } as unknown as Pick<pg.PoolClient, 'query'>, input))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('uses one all-Run current-fact predicate with exact pins, not selected Run or lifetime activity', async () => {
    const query = vi.fn(async () => ({ rows: [settledRow], rowCount: 1 }))
    await expect(assertMeaningfulSaveAdmitted({ query } as unknown as Pick<pg.PoolClient, 'query'>, input)).resolves.toBeUndefined()
    const [sql, values] = query.mock.calls[0]! as unknown as [string, unknown[]]
    expect(values.slice(0, 3)).toEqual([f.scope.workspaceId, f.scope.workflowId, ['a', 'b']])
    expect(sql).toContain("r.record->'agentConfigurationVersionIds' ?| $3::text[]")
    expect(sql).toContain(PUBLIC_PENDING_INTERACTION_SQL)
    expect(sql).toContain(PUBLIC_UNSETTLED_REVIEW_SQL)
    expect(sql).toContain('run_cleanup_intents')
    expect(sql).toContain("r.execution_state<>'completed'")
    expect(sql).not.toMatch(/run_activity|harness_native_events|\b(insert|update|delete)\b/i)
    expect(sql).not.toContain('stop_requested_at') // accepted Stop is not settlement
    expect(sql).not.toMatch(/order by r\.id\s+limit/i) // the affected Run set is not truncated
  })
})
