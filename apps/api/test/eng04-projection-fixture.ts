import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type pg from 'pg'
import type { RepeatGraphScopeV3, RepeatGraphFactV3, RepeatGraphEffectV3 } from '@graphql/contracts/wave25'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

export const projectionScope: RepeatGraphScopeV3 = { workspaceId: 'ws', workflowId: 'wf', workflowVersionId: 'v3', runId: 'run', executionSemanticsVersion: 3 }
export const projectionDigest = `sha256:${'a'.repeat(64)}`
export function occurrenceFact(id = 'one'): RepeatGraphFactV3 {
  return { type: 'repeat.occurrence', occurrence: { contractVersion: 1,
    identity: { scope: projectionScope, blockId: `block-${id}`, occurrenceId: `occ-${id}`, occurrenceIndex: 1 },
    input: { bindingId: `binding-${id}`, inputDigest: projectionDigest, previous: null } } }
}
export function publicationInput(id = 'one') {
  const effect: RepeatGraphEffectV3 = { identity: { kind: 'input.bind', entityId: `effect-${id}` }, digest: projectionDigest,
    operation: 'occurrence.create', subjectId: `occ-${id}` }
  return { evidence: { sourceKind: 'input_binding' as const, sourceId: `source-${id}`, sourceRevision: '1' }, sourceDigest: projectionDigest, effect }
}
interface Source { source_kind: string; source_id: string; source_revision: string; source_digest: string; semantic_digest: string; first_sequence: string }
interface Effect { effect_kind: string; entity_id: string; effect_digest: string; semantic_digest: string; first_sequence: string }
interface Batch { sequence: string; kind: string; payload: string | null; payload_bytes: number; batch_id: string }
interface State { head: number; floor: number; domain: number; stopped: boolean; executionState: string; outcome: string;
  sources: Source[]; effects: Effect[]; batches: Batch[] }

/** Strict SQL-shaped transaction model. It is NOT PostgreSQL, an authenticated
 * owner, native execution, a real constraint/lock test or a production adapter.
 * Unknown SQL is an error. The actual transaction facade/publication/receipt
 * verifier/page reader execute against this model, without a fake receipt hook. */
export class ProjectionDatabase {
  state: State = { head: 0, floor: 0, domain: 0, stopped: false, executionState: 'running', outcome: 'pending', sources: [], effects: [], batches: [] }
  scope = { ...projectionScope } as { workspaceId: string; workflowId: string; workflowVersionId: string; runId: string; executionSemanticsVersion: number }
  initialized = true
  ownerLost = false
  ownerFence = '100'
  onInsertSource: (() => void) | undefined
  unknownCommit = false
  calls: string[] = []
  readonly owner = { runId: projectionScope.runId, assertOwned: () => { if (this.ownerLost) throw new Error('RUN_OWNERSHIP_LOST') },
    readOneShotFence: async (sql: GraphTransactionSql) => {
      const row = (await sql.query<{ owner_id: string; fence: string }>('select projection_test_owner_fence')).rows[0]
      assert.ok(row); return { ownerId: row.owner_id, fence: row.fence }
    } } as unknown as RunOwnership
  connect() {
    let transaction: State | null = null
    const client = new EventEmitter() as EventEmitter & { query: pg.ClientBase['query']; release: () => void }
    client.release = () => undefined
    client.query = (async (text: string, values: unknown[] = []) => {
      const q = text.replace(/\s+/g, ' ').trim(), s = transaction ?? this.state
      this.calls.push(q)
      const result = (rows: unknown[] = []) => ({ rows: structuredClone(rows), rowCount: rows.length, command: '', oid: 0, fields: [] })
      if (q.startsWith('begin ')) { assert.equal(transaction, null); transaction = structuredClone(this.state); return result() }
      if (q === 'commit') { assert.ok(transaction); this.state = transaction; transaction = null;
        if (this.unknownCommit) { this.unknownCommit = false; throw new Error('COMMIT reply lost') } return result() }
      if (q === 'rollback') { transaction = null; return result() }
      if (q === 'select projection_test_owner_fence') return result([{ owner_id: '42', fence: this.ownerFence }])
      if (q === 'update projection_test_domain set revision=revision+1') { s.domain++; return result() }
      if (q.startsWith('select effect_kind,entity_id,payload_digest from run_repeat_effects')) return result([])
      if (q.startsWith('select p.ordinal,')) {
        const expected = JSON.parse(String(values[2])) as Array<{ ordinal: number; source_kind: string; source_revision: string; source_id: string | null;
          source_digest: string | null; semantic_digest: string; effect_kind: string | null; entity_id: string | null }>
        return result(expected.map(p => {
          const source = s.sources.find(x => x.source_kind === p.source_kind && String(x.source_revision) === p.source_revision && x.semantic_digest === p.semantic_digest
            && (p.source_id === null || x.source_id === p.source_id) && (p.source_digest === null || x.source_digest === p.source_digest)
            && BigInt(x.first_sequence) > 0n && BigInt(x.first_sequence) <= BigInt(String(values[1])))
          const effect = s.effects.find(x => x.effect_kind === p.effect_kind && x.entity_id === p.entity_id)
          return { ordinal: p.ordinal, source_id: source?.source_id ?? null, source_digest: source?.source_digest ?? null,
            semantic_digest: source?.semantic_digest ?? null, first_sequence: source?.first_sequence ?? null,
            effect_digest: effect?.effect_digest ?? null, effect_semantic_digest: effect?.semantic_digest ?? null, effect_sequence: effect?.first_sequence ?? null }
        }))
      }
      if (q.includes('join run_graph_sources s')) {
        const source = s.sources.find(x => x.source_kind === values[1] && x.source_id === values[2] && String(x.source_revision) === values[3])
        const effect = s.effects.find(x => x.effect_kind === values[4] && x.entity_id === values[5])
        return result(source ? [{ workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId,
          workflow_version_id: this.scope.workflowVersionId, execution_semantics_version: this.scope.executionSemanticsVersion,
          protocol_version: 1, head_sequence: String(s.head), source_digest: source.source_digest,
          source_semantic_digest: source.semantic_digest, source_sequence: source.first_sequence,
          effect_digest: effect?.effect_digest ?? null, effect_semantic_digest: effect?.semantic_digest ?? null,
          effect_sequence: effect?.first_sequence ?? null }] : [])
      }
      if (q.startsWith('select r.workspace_id')) return result([{ workspace_id: this.scope.workspaceId, workflow_id: this.scope.workflowId,
        workflow_version_id: this.scope.workflowVersionId, execution_semantics_version: this.scope.executionSemanticsVersion }])
      if (q.startsWith('select h.head_sequence')) return result(values[0] !== this.scope.runId || values[1] !== this.scope.workspaceId
        || values[2] !== this.scope.workflowId || values[3] !== this.scope.workflowVersionId || this.scope.executionSemanticsVersion !== 3 ? [] : [{ head_sequence: this.initialized ? String(s.head) : null,
        retention_floor: String(s.floor), protocol_version: 1, history_coverage: 'from_admission' }])
      if (q.startsWith('select protocol_version from run_graph_heads')) return result(this.initialized ? [{ protocol_version: 1 }] : [])
      if (q.startsWith('select execution_state,')) return result([{ execution_state: s.executionState, stopped: s.stopped, outcome: s.outcome }])
      if (q.startsWith('select source_digest,semantic_digest')) return result(s.sources.filter(x => x.source_kind === values[1]
        && x.source_id === values[2] && String(x.source_revision) === values[3]))
      if (q.startsWith('select effect_digest,semantic_digest')) return result(s.effects.filter(x => x.effect_kind === values[1] && x.entity_id === values[2]))
      if (q.startsWith('update run_graph_heads')) return result([{ head_sequence: String(++s.head) }])
      if (q.startsWith('insert into run_graph_batches')) {
        s.batches.push({ sequence: String(values[1]), batch_id: String(values[2]), kind: String(values[3]),
          payload: values[4] as string | null, payload_bytes: typeof values[4] === 'string' ? Buffer.byteLength(values[4]) : 0 }); return result()
      }
      if (q.startsWith('insert into run_graph_sources')) {
        const rows = JSON.parse(String(values[1])) as Source[]
        for (const row of rows) { assert.ok(!s.sources.some(x => x.source_kind === row.source_kind && x.source_id === row.source_id
          && x.source_revision === row.source_revision)); s.sources.push(row) }
        this.onInsertSource?.(); return result()
      }
      if (q.startsWith('insert into run_graph_effects')) {
        for (const row of JSON.parse(String(values[2])) as Omit<Effect, 'first_sequence'>[]) {
          assert.ok(!s.effects.some(x => x.effect_kind === row.effect_kind && x.entity_id === row.entity_id))
          s.effects.push({ ...row, first_sequence: String(values[1]) })
        } return result()
      }
      if (q.startsWith('select b.sequence::text,b.kind,b.payload_bytes')) return result(s.batches
        .filter(x => BigInt(x.sequence) > BigInt(String(values[1])) && BigInt(x.sequence) <= BigInt(String(values[2])))
        .sort((a,b) => Number(a.sequence)-Number(b.sequence)).slice(0, Number(values[3])))
      if (q.startsWith('select b.sequence::text,b.payload')) return result(s.batches.filter(x => (values[1] as string[]).includes(x.sequence))
        .sort((a,b) => Number(a.sequence)-Number(b.sequence)))
      throw new Error(`Unmodelled SQL: ${q}`)
    }) as pg.ClientBase['query']
    return client
  }
  connection(): ExclusiveGraphConnection {
    return new ExclusiveGraphConnection(this.connect() as unknown as pg.ClientBase, () => this.owner.assertOwned())
  }
  pool(): pg.Pool { return { connect: async () => this.connect() } as unknown as pg.Pool }
}
