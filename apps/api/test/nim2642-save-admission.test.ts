import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { RunOutcomeSchema } from '@foreman-code/contracts'
import { assertMeaningfulSaveAdmitted, readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from '../src/modules/run-graph/publicObligations.js'
import { currentSaveAdmissionFixture } from './helpers/currentSaveAdmission.js'
import { recoveryIdentity } from './helpers/eng06Recovery.testSupport.js'
import { saveNativeProtocolFixture, type SaveNativeProof } from './helpers/eng07SaveNativeSettlement.testSupport.js'

/** Query-boundary tests, not a PostgreSQL emulator. The lock and aggregate
 * reads have different result shapes. After those reads the REAL canonical
 * readers check the scripted execution/closure/entry/receipt evidence. Never
 * return the aggregate row for every query or mock a proof reader as true. */
function fixture(proof: SaveNativeProof = 'closed') {
  const current = currentSaveAdmissionFixture('save-admission')
  const native = saveNativeProtocolFixture(proof, { ...current.f, run: current.record })
  const row: Record<string, unknown> = { ...current.row }
  if (!native.db.state.execution.nativeSessionId) row.record = { ...current.record, outcome: 'canceled',
    result: { outcome: 'canceled', output: null } }
  const input = { workspaceId: current.f.scope.workspaceId, workflowId: current.f.scope.workflowId, stagedAgentIds: ['b', 'a', 'b'] }
  const scopeValues = [input.workspaceId, input.workflowId, ['a', 'b']]
  const result = <R extends pg.QueryResultRow>(rows: unknown[]): pg.QueryResult<R> => ({
    rows: structuredClone(rows) as R[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [],
  })
  const queryFailures: unknown[] = []
  let phase: 'initial' | 'locked' | 'facts' = 'initial'
  const sql: GraphSqlClient = { async query<R extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      expect(text).toMatch(/^select\b/i)
      expect(text).not.toMatch(/\b(insert|update|delete|begin|commit|rollback)\b/i)
      if (text.startsWith('select r.id from runs r where ')) {
        expect(text).toMatch(/order by r\.id for share of r$/)
        expect(values).toEqual(scopeValues)
        phase = 'locked'
        return result<R>([{ id: row.id }])
      }
      if (text.startsWith('select r.id,r.workspace_id,r.workflow_id,r.workflow_version_id,r.record,')) {
        expect(phase).toBe('locked')
        expect(values).toEqual([...scopeValues, RunOutcomeSchema.options.filter((outcome) => outcome !== 'pending')])
        phase = 'facts'
        return result<R>([row])
      }
      expect(phase, 'Canonical evidence must be read after locking and checking the affected Run set').toBe('facts')
      return await native.sql.query<R>(text, values)
    } catch (error) { queryFailures.push(error); throw error }
  } }
  const query = vi.spyOn(sql, 'query')
  return { ...current, row, native, input, query, client: sql as unknown as Pick<pg.PoolClient, 'query'>,
    async close() {
      try { expect(queryFailures).toEqual([]) } finally { await native.close() }
    } }
}
const deny = { code: 'WORKFLOW_RUNS_UNSETTLED' }

/** Preserve every original rejection. Query counts now include the parent lock;
 * native settlement is no longer represented solely by an aggregate boolean. */
describe('NIM-2642 publication admission query', () => {
  it.each([true, undefined, null])('fails closed on blocked/missing native evidence (%s)', async (native) => {
    const t = fixture()
    t.row.native = native
    try {
      await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).rejects.toMatchObject(deny)
      expect(t.query).toHaveBeenCalledTimes(2)
      expect(t.native.statements).toEqual([]) // Never override blocked/unknown aggregate evidence with a close.
    } finally { await t.close() }
  })

  it.each(['retired-semantics', 'version-pin', 'missing-version', 'missing-configurations', 'version-hash'] as const)(
    'rejects settled flags without a complete exact current snapshot (%s)', async (fault) => {
      const t = fixture()
      switch (fault) {
        case 'retired-semantics': t.row.record = { ...t.record, executionSemanticsVersion: 2 }; break
        case 'version-pin': t.row.record = { ...t.record, workflowVersionId: 'another-version' }; break
        case 'missing-version': t.row.version_row = null; break
        case 'missing-configurations': t.row.configurations = []; break
        case 'version-hash': t.row.version_row = { ...t.row.version_row as object,
          record: { ...t.f.version, contentHash: `sha256:${'0'.repeat(64)}` } }; break
      }
      try {
        await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).rejects.toMatchObject(deny)
        expect(t.query).toHaveBeenCalledTimes(2)
        expect(t.native.statements).toEqual([])
      } finally { await t.close() }
    })

  it('locks the complete affected set, retains the resource fences, then reads canonical proofs on the same client', async () => {
    const t = fixture()
    try {
      await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).resolves.toBeUndefined()
      const lock = t.query.mock.calls[0]![0], sql = t.query.mock.calls[1]![0]
      for (const statement of [lock, sql]) {
        expect(statement).toContain("r.record->'agentConfigurationVersionIds' ?| $3::text[]")
        expect(statement).toContain("affected_version.record->'agentConfigurationVersionIds' ?| $3::text[]")
        expect(statement).not.toMatch(/order by r\.id\s+limit/i)
      }
      expect(sql).toContain(PUBLIC_PENDING_INTERACTION_SQL)
      expect(sql).toContain(PUBLIC_UNSETTLED_REVIEW_SQL)
      expect(sql).toContain('run_cleanup_intents')
      expect(sql).toContain("r.execution_state<>'completed'")
      expect(sql).toContain('s.workflow_finalized_at is not null')
      expect(sql).toContain('b.revoked_at is null or p.id is null or p.revoked_at is null')
      expect(sql).toContain("e.record->>'agentConfigurationVersionId' is distinct from r.record->'agentConfigurationVersionIds'->>e.agent_id")
      expect(sql).not.toMatch(/run_activity|harness_native_events|\b(insert|update|delete)\b/i)
      expect(sql).not.toContain('stop_requested_at') // Stop acceptance is still not settlement.
      expect(t.query.mock.calls[2]![0]).toContain('o.record as occurrence_record')
      expect(t.query.mock.calls[2]![1]).toEqual([t.f.scope.runId, ''])
      expect(t.native.statements.some((text) => text.includes('order by generation desc limit 1'))).toBe(true)
    } finally { await t.close() }
  })

  for (const flag of ['terminal', 'cleanup', 'interactions', 'reviews'] as const) {
    it.each([flag === 'terminal' ? false : true, undefined, null])('%s cannot be bypassed by a valid native proof: ' + flag, async (value) => {
      const t = fixture()
      t.row[flag] = value
      try { await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).rejects.toMatchObject(deny) }
      finally { await t.close() }
    })
  }

  it.each(['closed', 'recovered', 'unbound-disposal', 'unbound-recovery', 'not-submitted'] as const)(
    'Save and the edit plan both accept exact %s evidence', async (proof) => {
      const t = fixture(proof)
      try {
        await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).resolves.toBeUndefined()
        expect(await readAffectedGraphRuns(t.client, t.input)).toEqual([
          expect.objectContaining({ pin: t.pin, settled: true, nativePending: false }),
        ])
        expect(t.native.statements.length).toBeGreaterThan(2)
        expect(t.native.db.state).toMatchObject({ inserts: 0, commits: 0, rollbacks: 0 })
      } finally { await t.close() }
    })

  it.each(['missing-seal', 'seal-attempt', 'missing-receipt', 'receipt-digest', 'receipt-scope', 'receipt-sequence'] as const)(
    'settled flags cannot hide %s from Save or the edit plan', async (fault) => {
      const t = fixture('not-submitted')
      switch (fault) {
        case 'missing-seal': t.native.state.entry = false; break
        case 'seal-attempt': t.native.entry.reservation.execution.attempt++; break
        case 'missing-receipt': t.native.state.receipt = false; break
        case 'receipt-digest': t.native.receipt.source_digest = `sha256:${'f'.repeat(64)}`; break
        case 'receipt-scope': t.native.receipt.workflow_version_id = 'another-version'; break
        case 'receipt-sequence': t.native.receipt.source_sequence = '4'; break
      }
      try {
        await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).rejects.toMatchObject(deny)
        expect(await readAffectedGraphRuns(t.client, t.input)).toEqual([
          expect.objectContaining({ pin: t.pin, settled: false, nativePending: true }),
        ])
        expect(t.native.statements.length).toBeGreaterThan(2)
      } finally { await t.close() }
    })

  it.each(['missing', 'identity', 'session', 'generation', 'prior-unclosed'] as const)(
    '%s recovered evidence stays blocked at both admission readers', async (fault) => {
      const t = fixture('recovered')
      switch (fault) {
        case 'missing': t.native.db.state.proof = undefined; break
        case 'identity': t.native.db.state.proof!.execution_identity = {
          ...recoveryIdentity(t.native.db.state.execution), attempt: 2 }; break
        case 'session': t.native.db.state.proof!.reference = { ...t.native.db.state.session, nativeSessionId: 'another-session' }; break
        case 'generation': t.native.db.state.proof!.generation = '70'; break
        case 'prior-unclosed': t.native.db.state.lifetime!.prior_unclosed = true; break
      }
      try {
        await expect(assertMeaningfulSaveAdmitted(t.client, t.input)).rejects.toMatchObject(deny)
        expect(await readAffectedGraphRuns(t.client, t.input)).toEqual([
          expect.objectContaining({ pin: t.pin, settled: false, nativePending: true }),
        ])
        expect(t.native.db.state).toMatchObject({ inserts: 0, commits: 0, rollbacks: 0 })
      } finally { await t.close() }
    })
})
