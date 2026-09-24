import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { assertMeaningfulSaveAdmitted } from '../src/modules/graph-drafts/saveAdmission.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from '../src/modules/run-graph/publicObligations.js'

/** Query-boundary unit tests, not substitutes for the opt-in PostgreSQL fixture. */
describe('NIM-2642 publication admission query', () => {
  const input = { workspaceId: 'workspace', workflowId: 'workflow', stagedAgentIds: ['b', 'a', 'b'] }
  it.each([true, undefined, null])('fails closed on blocked/missing evidence (%s)', async (blocked) => {
    const query = vi.fn(async () => ({ rows: blocked === undefined ? [] : [{ blocked }], rowCount: 1 }))
    await expect(assertMeaningfulSaveAdmitted({ query } as unknown as Pick<pg.PoolClient, 'query'>, input))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    expect(query).toHaveBeenCalledTimes(1)
  })
  it('uses one all-Run current-fact predicate with exact pins, not selected Run or lifetime activity', async () => {
    const query = vi.fn(async () => ({ rows: [{ blocked: false }], rowCount: 1 }))
    await expect(assertMeaningfulSaveAdmitted({ query } as unknown as Pick<pg.PoolClient, 'query'>, input)).resolves.toBeUndefined()
    const [sql, values] = query.mock.calls[0]! as unknown as [string, unknown[]]
    expect(values.slice(0, 3)).toEqual(['workspace', 'workflow', ['a', 'b']])
    expect(sql).toContain("r.record->'agentConfigurationVersionIds' ?| $3::text[]")
    expect(sql).toContain(PUBLIC_PENDING_INTERACTION_SQL)
    expect(sql).toContain(PUBLIC_UNSETTLED_REVIEW_SQL)
    expect(sql).toContain('run_cleanup_intents')
    expect(sql).toContain("r.execution_state<>'completed'")
    expect(sql).not.toMatch(/run_activity|harness_native_events|\b(insert|update|delete)\b/i)
    expect(sql).not.toMatch(/stop_requested_at|limit\s+1/i) // accepted Stop is not settlement; the set is not truncated
  })
})
