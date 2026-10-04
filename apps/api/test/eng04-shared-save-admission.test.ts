import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { sharedFixture } from './eng04-shared-fixture.js'
import { assertMeaningfulSaveAdmitted, readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'

function fixture() {
  const t = sharedFixture()
  const record = WorkflowRunV3Schema.parse({ ...t.run, executionState: 'completed', outcome: 'succeeded',
    input: { note: 'PRIVATE_RUN_INPUT' }, result: { outcome: 'succeeded', output: { note: 'PRIVATE_RESULT_BODY' } }, finishedAt: t.f.createdAt })
  const row = { id: record.id, workspace_id: record.workspaceId, workflow_id: record.workflowId,
    workflow_version_id: record.workflowVersionId, record, terminal: true,
    cleanup: false, native: false, interactions: false, reviews: false,
    version_row: t.versionRow, configurations: t.configurations }
  const scope = { workspaceId: record.workspaceId, workflowId: record.workflowId, stagedAgentIds: ['agent-z', 'agent-a', 'agent-z'] }
  return { ...t, row, scope }
}
function sqlReturning(rows: unknown[]) {
  // The fixture Run has no executions, so the canonical native-settlement page is empty.
  const query = vi.fn().mockImplementation(async (text: string) => text.startsWith('select e.id,e.run_id,')
    ? { rows: [], rowCount: 0 } : { rows, rowCount: rows.length })
  return { query, client: { query } as unknown as pg.PoolClient }
}
/** The one read that computes every obligation flag; the first query only locks the affected parents. */
function admissionQuery(query: ReturnType<typeof vi.fn>): [string, unknown[]] {
  const call = query.mock.calls.find(([text]) => String(text).includes(' as terminal'))
  if (!call) throw new Error('admission query was not issued')
  return call as [string, unknown[]]
}

describe('ENG04 shared meaningful-save admission (SQL-shaped unit tests, not PostgreSQL)', () => {
  it('admits an exact terminal v3 snapshot only when every SQL resource flag is settled', async () => {
    const t = fixture(), sql = sqlReturning([t.row])
    await expect(assertMeaningfulSaveAdmitted(sql.client, t.scope)).resolves.toBeUndefined()
    // Lock the affected parents, read every flag once, then page the Run's native settlement proof.
    expect(sql.query).toHaveBeenCalledTimes(3)
    expect(sql.query.mock.calls[0]![0]).toContain('for share of r')
    const [query, values] = admissionQuery(sql.query)
    expect(values.slice(0, 3)).toEqual([t.scope.workspaceId, t.scope.workflowId, ['agent-a', 'agent-z']])
    expect(query).toContain('case when')
    expect(query).not.toMatch(/\blimit\s+\$|\boffset\b/i) // no affected-Run page shortcut
    const plan = await readAffectedGraphRuns(sql.client, t.scope)
    expect(plan[0]!.pin.executionSemanticsVersion).toBe(3)
    expect(plan[0]!.settled).toBe(true)
    expect(JSON.stringify(plan)).not.toMatch(/PRIVATE|synthetic-principal|identityHash|latestDeliverable|prompt|resultData/)
  })
  it('rejects retired execution tags even when legacy settlement flags appear complete', async () => {
    const t = fixture()
    for (const semantics of [undefined, 1, 2]) {
      const { executionSemanticsVersion, ...legacy } = t.row.record
      void executionSemanticsVersion
      const record = semantics === undefined ? legacy : { ...legacy, executionSemanticsVersion: semantics }
      const sql = sqlReturning([{ ...t.row, record, version_row: null, configurations: null }])
      await expect(assertMeaningfulSaveAdmitted(sql.client, t.scope)).rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    }
    await expect(assertMeaningfulSaveAdmitted(sqlReturning([]).client, t.scope)).resolves.toBeUndefined()
  })
  it.each(['cleanup', 'native', 'interactions', 'reviews'] as const)('blocks outstanding or missing %s evidence', async (flag) => {
    const t = fixture()
    for (const value of [true, null, undefined]) {
      await expect(assertMeaningfulSaveAdmitted(sqlReturning([{ ...t.row, [flag]: value }]).client, t.scope))
        .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    }
  })
  it('requires terminal Run shape and exact immutable version/configuration/location/approval pins', async () => {
    const t = fixture()
    for (const row of [
      { ...t.row, terminal: false }, { ...t.row, version_row: null }, { ...t.row, configurations: [] },
      { ...t.row, record: { ...t.row.record, finishedAt: undefined } },
      { ...t.row, record: { ...t.row.record, approval: undefined } },
      { ...t.row, record: { ...t.row.record, executionLocation: undefined } },
      { ...t.row, record: { ...t.row.record, authorizationPrincipalId: undefined } },
      { ...t.row, record: { ...t.row.record, agentConfigurationVersionIds: {} } },
      { ...t.row, version_row: { ...t.versionRow, workspace_id: 'other' } },
      { ...t.row, version_row: { ...t.versionRow, record: { ...t.version, contentHash: 'sha256:bad' } } },
      { ...t.row, configurations: t.configurations.map((record) => ({ ...record, agent_id: 'other' })) },
    ]) await expect(assertMeaningfulSaveAdmitted(sqlReturning([row]).client, t.scope))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
  })
  it.each([null, '3', 4, 99])('does not let version %s fall through as legacy', async (tag) => {
    const t = fixture()
    await expect(assertMeaningfulSaveAdmitted(sqlReturning([{ ...t.row, record: { ...t.row.record, executionSemanticsVersion: tag } }]).client, t.scope))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
  })
  it('keeps opaque rejection free of private Run/configuration/result detail', async () => {
    const t = fixture(), sql = sqlReturning([{ ...t.row, version_row: null }])
    let error: unknown
    try { await assertMeaningfulSaveAdmitted(sql.client, t.scope) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/PRIVATE|synthetic-principal|cfg-|run-eng04|latestDeliverable/)
    await expect(readAffectedGraphRuns(sql.client, t.scope)).rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
  })
  it('binds all v3 resource SQL to exact closure, finalization, parent and immutable receipt identities', async () => {
    const t = fixture(), sql = sqlReturning([])
    await assertMeaningfulSaveAdmitted(sql.client, t.scope)
    const text = admissionQuery(sql.query)[0]
    for (const predicate of [
      "r.record->'executionSemanticsVersion' is distinct from '3'::jsonb",
      // Exact current-generation closure, recovery, unbound-disposal and no-submission receipts are
      // checked by the canonical readers in saveNativeSettlement.ts; SQL keeps the session fence.
      "s.reference->>'nativeSessionId'=e.record->>'nativeSessionId'", 's.workflow_finalized_at is not null',
      'left join management_principals p', 'p.id is null or p.revoked_at is null',
      'canceled-interaction-',
      "g.state is distinct from 'resumed'", 'g.execution_id is distinct from i.execution_id',
      'g.graph_interrupt_id is distinct from', "f.effect_kind='graph.resume'", "s.source_kind='native_event'",
      's.source_id=i.id and s.source_revision=i.revision', 'from run_native_correlations c',
      "j.approval_native_evidence->'terminal'->>'nativeSettled' is distinct from 'true'",
    ]) expect(text).toContain(predicate)
    // These assertions pin SQL shape only. Real SQL null/join/transaction and
    // process-restart behavior remains in the native/migration integration matrix.
  })
})
