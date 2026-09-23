import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalGraphJson, graphJsonBytes, sameGraphScope, isOneShotGraphFact, GraphDigestSchema, GraphEvidenceSchema, GraphFactSchema,
  RUN_GRAPH_LIMITS, RunGraphEventContentSchema, RunGraphBatchSchema, RunGraphScopeSchema,
  GraphEffectSchema, GraphEffectFenceSchema, assertGraphEffectAuthority, RunGraphErrorCodeSchema,
  type GraphEffect, type GraphEffectFence, type GraphEffectAuthority, type GraphEffectIdentity,
  type GraphEvidence, type GraphFact, type RunGraphEvent, type RunGraphScope,
} from '@graphql/contracts/wave25'
import {
  assertGraphTransaction, beforeGraphCommit, didGraphTransactionCommit, poisonGraphTransaction,
  type ExclusiveGraphConnection, type GraphTransactionSql,
} from './connection.js'
import { RunGraphError } from './errors.js'

export function graphSourceDigest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
}
export interface GraphSourceChange {
  evidence: GraphEvidence
  /** Hash the immutable source fact INCLUDING private fields; never send those fields to the journal. */
  sourceDigest: string
  facts: readonly GraphFact[]
}
export interface GraphEffectGuard {
  expected: GraphEffectFence
  /** SQL-only: lock/read the EXISTING authority in the frozen lock order until COMMIT.
   * Return exact scope/subject/session binding, live owner/fence/generation and
   * qualified security. Cached snapshots or echoing expected is NOT an implementation.
   */
  readCurrentLocked(sql: GraphTransactionSql, scope: RunGraphScope, effect: GraphEffectIdentity): Promise<GraphEffectAuthority>
}
export interface GraphEffectChange extends GraphSourceChange { effect: GraphEffect }
interface StagedEffect { effect: GraphEffect; semanticDigest: string }
interface StagedSource {
  evidence: GraphEvidence; sourceDigest: string; semanticDigest: string; events: RunGraphEvent[]
  /** Aliases of already committed effects point at their original publication. */
  firstSequence?: string
}
export interface GraphPublicationReceipt {
  sequence: string | null
  batchId: string | null
  kind: 'none' | 'events' | 'reset'
}
const publications = new WeakMap<GraphTransactionSql, RunGraphPublication>()
const constructionKey = Symbol('RunGraphPublication')

/** All nested domain producers share this one transaction and ONE finalized batch. */
export class RunGraphPublication {
  readonly sql: GraphTransactionSql
  readonly scope: RunGraphScope
  readonly #sources = new Map<string, StagedSource>()
  readonly #effects = new Map<string, StagedEffect>()
  #bytes = 0
  #busy = false
  #finalized = false
  #receipt: GraphPublicationReceipt = { sequence: null, batchId: null, kind: 'none' }
  constructor(key: symbol, sql: GraphTransactionSql, scope: RunGraphScope) {
    if (key !== constructionKey) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
    this.sql = sql
    this.scope = Object.freeze({ ...scope })
    beforeGraphCommit(sql, () => this.finalize())
  }
  /** Source/projection bookkeeping; grants no authority for a workflow effect.
   * Exact duplicate sources do not call mutate; conflicts poison the transaction. */
  async source<T>(input: GraphSourceChange, mutate: (sql: GraphTransactionSql) => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
    return this.change(input, undefined, mutate)
  }
  /** Persisted workflow effects use BOTH source and stable effect deduplication.
   * This records database effects/intents, never performs a network/native write.
   */
  async effect<T>(input: GraphEffectChange, guard: GraphEffectGuard, mutate: (sql: GraphTransactionSql) => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
    return this.change(input, { effect: input.effect, guard }, mutate)
  }
  private async change<T>(input: GraphSourceChange, guarded: { effect: GraphEffect; guard: GraphEffectGuard } | undefined,
    mutate: (sql: GraphTransactionSql) => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
    let entered = false
    try {
      assertGraphTransaction(this.sql)
      if (this.#finalized) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
      if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
      this.#busy = true
      entered = true
      if (!guarded && Object.prototype.hasOwnProperty.call(input, 'effect')) throw new RunGraphError('GRAPH_INVALID_FACT')
      if (guarded && this.scope.executionSemanticsVersion !== 2) throw new RunGraphError('GRAPH_EFFECT_ACCESS_DENIED')
      const evidence = GraphEvidenceSchema.parse(input.evidence)
      const sourceDigest = GraphDigestSchema.parse(input.sourceDigest)
      // Bound before parsing/retaining large arrays. Facts may exceed a wire event,
      // in which case finalization writes a reset barrier, not a partial batch.
      canonicalGraphJson(input.facts, RUN_GRAPH_LIMITS.transactionBytes)
      if (!input.facts.length) throw new RunGraphError('GRAPH_INVALID_FACT')
      const facts = input.facts.map((fact) => GraphFactSchema.parse(fact))
      if (this.scope.executionSemanticsVersion === 2 && facts.some((fact) => !isOneShotGraphFact(fact))) throw new RunGraphError('GRAPH_INVALID_FACT')
      const events = facts.map((fact) => RunGraphEventContentSchema.parse({ eventId: randomUUID(), evidence, fact }))
      const effect = guarded ? GraphEffectSchema.parse(guarded.effect) : undefined
      const semanticDigest = graphSourceDigest(effect ? { effect, facts } : facts)
      const key = canonicalGraphJson(evidence)
      const staged = this.#sources.get(key)
      if (staged) {
        this.assertSame(staged, sourceDigest, semanticDigest)
        return { replayed: true }
      }
      const existing = await this.sql.query<{ source_digest: string; semantic_digest: string }>(
        `select source_digest,semantic_digest from run_graph_sources
         where run_id=$1 and source_kind=$2 and source_id=$3 and source_revision=$4::bigint`,
        [this.scope.runId, evidence.sourceKind, evidence.sourceId, evidence.sourceRevision],
      )
      if (existing.rows[0]) {
        this.assertSame({ sourceDigest: existing.rows[0].source_digest, semanticDigest: existing.rows[0].semantic_digest }, sourceDigest, semanticDigest)
        return { replayed: true }
      }
      const bytes = Buffer.byteLength(canonicalGraphJson({ evidence, sourceDigest, semanticDigest, events }, RUN_GRAPH_LIMITS.transactionBytes))
      if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources || this.#bytes + bytes > RUN_GRAPH_LIMITS.transactionBytes) throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
      if (effect) {
        const effectKey = canonicalGraphJson(effect.identity)
        const stagedEffect = this.#effects.get(effectKey)
        const saved = stagedEffect ? undefined : (await this.sql.query<{
          effect_digest: string; semantic_digest: string; first_sequence: string
        }>(`select effect_digest,semantic_digest,first_sequence::text from run_graph_effects
            where run_id=$1 and effect_kind=$2 and entity_id=$3`,
          [this.scope.runId, effect.identity.kind, effect.identity.entityId])).rows[0]
        if (stagedEffect || saved) {
          if ((stagedEffect?.effect.digest ?? saved!.effect_digest) !== effect.digest
            || (stagedEffect?.semanticDigest ?? saved!.semantic_digest) !== semanticDigest) throw new RunGraphError('GRAPH_EFFECT_CONFLICT')
          // A new observation of the same effect is an alias, NOT a second effect
          // or public cursor. Bind its source digest without replaying mutate.
          this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events: [],
            ...(saved ? { firstSequence: saved.first_sequence } : {}) })
          this.#bytes += bytes
          return { replayed: true }
        }
        if (!guarded?.guard || typeof guarded.guard.readCurrentLocked !== 'function') throw new RunGraphError('GRAPH_AUTHORITY_INVALID')
        const expected = GraphEffectFenceSchema.parse(guarded.guard.expected)
        if (!sameGraphScope(expected.scope, this.scope) || canonicalGraphJson(expected.effect) !== effectKey || expected.effectDigest !== effect.digest) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        // Parent Run already locked by openRunGraphPublication. Never use cleanup
        // as Stop or trust a caller-supplied terminal flag for this parent fence.
        const run = (await this.sql.query<{ execution_state: string; stopped: boolean }>(
          'select execution_state,stop_requested_at is not null as stopped from runs where id=$1', [this.scope.runId])).rows[0]
        if (!run) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        if (!['review.settle', 'run.stop'].includes(effect.identity.kind)) {
          if (run.stopped) throw new RunGraphError('GRAPH_STOP_CONFLICT')
          if (['completed', 'interrupted'].includes(run.execution_state)) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
        }
        assertGraphEffectAuthority(expected, await guarded.guard.readCurrentLocked(this.sql, this.scope, effect.identity))
        if (effect.identity.kind === 'run.stop') {
          if (effect.identity.entityId !== this.scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
          if (!facts.some((fact) => fact.type === 'run.state' && fact.state.stopRequested === true)) throw new RunGraphError('GRAPH_INVALID_FACT')
          await this.sql.query('update runs set stop_requested_at=coalesce(stop_requested_at,clock_timestamp()) where id=$1', [this.scope.runId])
        }
      }
      const value = await mutate(this.sql)
      assertGraphTransaction(this.sql)
      if (effect && facts.some((fact) => fact.type === 'run.state')) {
        const persisted = (await this.sql.query<{ execution_state: string; outcome: string; stopped: boolean }>(
          "select execution_state,record->>'outcome' as outcome,stop_requested_at is not null as stopped from runs where id=$1",
          [this.scope.runId])).rows[0]
        if (!persisted || facts.some((fact) => fact.type === 'run.state' && (
          fact.state.executionState !== persisted.execution_state || fact.state.outcome !== persisted.outcome
          || fact.state.stopRequested !== persisted.stopped))) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      }
      if (effect) this.#effects.set(canonicalGraphJson(effect.identity), { effect, semanticDigest })
      this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events })
      this.#bytes += bytes
      return { replayed: false, value }
    } catch (error) {
      poisonGraphTransaction(this.sql)
      if (error instanceof RunGraphError) throw error
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'PGR01') throw new RunGraphError('GRAPH_STOP_CONFLICT')
        if (error.code === 'PGR02') throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
      }
      const code = RunGraphErrorCodeSchema.safeParse(error instanceof Error ? error.message : undefined)
      if (code.success) throw new RunGraphError(code.data)
      if (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT') throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
      throw new RunGraphError('GRAPH_INVALID_FACT')
    } finally { if (entered) this.#busy = false }
  }
  private assertSame(existing: { sourceDigest: string; semanticDigest: string }, sourceDigest: string, semanticDigest: string) {
    if (existing.sourceDigest !== sourceDigest || existing.semanticDigest !== semanticDigest) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
  }
  /** Read only AFTER the owning connection's transaction promise resolves. */
  get receipt(): Readonly<GraphPublicationReceipt> {
    if (!didGraphTransactionCommit(this.sql)) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
    return { ...this.#receipt }
  }
  private async finalize(): Promise<void> {
    assertGraphTransaction(this.sql)
    if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
    if (this.#finalized) return
    this.#finalized = true
    if (!this.#sources.size) return
    const events = [...this.#sources.values()].flatMap((source) => source.events)
    const head = events.length ? await this.sql.query<{ head_sequence: string }>(
      `update run_graph_heads set head_sequence=head_sequence+1
       where run_id=$1 and head_sequence<9223372036854775807 returning head_sequence::text`, [this.scope.runId],
    ) : undefined
    const sequence = head?.rows[0]?.head_sequence
    if (events.length && !sequence) throw new RunGraphError('GRAPH_SEQUENCE_EXHAUSTED')
    let batchId: string | null = null
    let kind: GraphPublicationReceipt['kind'] = 'none'
    if (sequence) {
      batchId = randomUUID()
      const candidate = {
        protocolVersion: 1 as const, scope: this.scope, batchId,
        previousSequence: String(BigInt(sequence) - 1n), sequence, events,
      }
      const oversized = events.length > RUN_GRAPH_LIMITS.batchEvents
        || events.some((event) => graphJsonBytes(event) > RUN_GRAPH_LIMITS.eventBytes)
        || graphJsonBytes(candidate) > RUN_GRAPH_LIMITS.batchBytes
      kind = oversized ? 'reset' : 'events'
      const parsed = oversized ? undefined : RunGraphBatchSchema.safeParse(candidate)
      if (parsed && !parsed.success) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      // A size barrier preserves domain state and ALL source receipts. Invalid
      // semantic content is instead a rollback, never disguised as an oversized batch.
      await this.sql.query(
        `insert into run_graph_batches(run_id,sequence,batch_id,kind,payload,reset_reason)
         values($1,$2::bigint,$3::uuid,$4,$5,$6)`,
        [this.scope.runId, sequence, batchId, kind, parsed?.success ? canonicalGraphJson(parsed.data) : null,
          oversized ? 'atomic_change_too_large' : null],
      )
    }
    const receipts = [...this.#sources.values()].map((source) => ({
      first_sequence: source.firstSequence ?? sequence,
      source_kind: source.evidence.sourceKind, source_id: source.evidence.sourceId, source_revision: source.evidence.sourceRevision,
      source_digest: source.sourceDigest, semantic_digest: source.semanticDigest,
    }))
    await this.sql.query(
      `insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
       select $1,x.source_kind,x.source_id,x.source_revision,x.source_digest,x.semantic_digest,x.first_sequence
       from jsonb_to_recordset($2::jsonb) as x(source_kind text,source_id text,source_revision bigint,source_digest text,semantic_digest text,first_sequence bigint)`,
      [this.scope.runId, JSON.stringify(receipts)],
    )
    if (this.#effects.size) await this.sql.query(
      `insert into run_graph_effects(run_id,effect_kind,entity_id,effect_digest,semantic_digest,first_sequence)
       select $1,x.effect_kind,x.entity_id,x.effect_digest,x.semantic_digest,$2::bigint
       from jsonb_to_recordset($3::jsonb) as x(effect_kind text,entity_id text,effect_digest text,semantic_digest text)`,
      [this.scope.runId, sequence, JSON.stringify([...this.#effects.values()].map(({ effect, semanticDigest }) => ({
        effect_kind: effect.identity.kind, entity_id: effect.identity.entityId,
        effect_digest: effect.digest, semantic_digest: semanticDigest,
      })))],
    )
    this.#receipt = { sequence: sequence ?? null, batchId, kind }
  }
}

/**
 * Must be the FIRST Run/domain lock in a caller-owned exclusive transaction
 * (workspace admission/command receipt locks may precede it; never executions).
 * NO KEY UPDATE serializes Run mutation but permits the KEY SHARE acquired by
 * legacy Activity foreign keys after execution-first native appends. Never
 * upgrade the Run lock after taking the head/child locks.
 * No arbitrary ClientBase overload exists. The commit finalizer cannot be forgotten.
 */
export async function openRunGraphPublication(
  sql: GraphTransactionSql, input: RunGraphScope,
  initialize?: { historyCoverage: 'from_admission' | 'from_snapshot' },
): Promise<RunGraphPublication> {
  assertGraphTransaction(sql)
  try {
    const scope = RunGraphScopeSchema.parse(input)
    if (publications.has(sql)) throw new RunGraphError('GRAPH_TRANSACTION_NESTED')
    const found = await sql.query<{ workspace_id: string; workflow_id: string; workflow_version_id: string; execution_semantics_version: number }>(
      `select r.workspace_id,r.workflow_id,r.workflow_version_id,v.execution_semantics_version
       from runs r join workflow_versions v on v.id=r.workflow_version_id
       where r.id=$1 for no key update of r`, [scope.runId],
    )
    const run = found.rows[0]
    if (!run || run.workspace_id !== scope.workspaceId || run.workflow_id !== scope.workflowId
      || run.workflow_version_id !== scope.workflowVersionId || run.execution_semantics_version !== scope.executionSemanticsVersion) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    if (initialize) await sql.query(
      `insert into run_graph_heads(run_id,protocol_version,history_coverage) values($1,1,$2) on conflict(run_id) do nothing`,
      [scope.runId, initialize.historyCoverage],
    )
    const head = await sql.query<{ protocol_version: number }>('select protocol_version from run_graph_heads where run_id=$1 for update', [scope.runId])
    if (!head.rows[0]) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    if (head.rows[0].protocol_version !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
    const publication = new RunGraphPublication(constructionKey, sql, scope)
    publications.set(sql, publication)
    return publication
  } catch (error) { poisonGraphTransaction(sql); throw error }
}

export function assertRunGraphPublication(sql: GraphTransactionSql, scope: RunGraphScope): void {
  assertGraphTransaction(sql)
  const publication = publications.get(sql)
  if (!publication || !sameGraphScope(publication.scope, scope)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
}

export async function withRunGraphPublication<T>(
  connection: ExclusiveGraphConnection, scope: RunGraphScope,
  work: (publication: RunGraphPublication) => Promise<T>,
  initialize?: { historyCoverage: 'from_admission' | 'from_snapshot' },
): Promise<{ value: T; publication: Readonly<GraphPublicationReceipt> }> {
  let publication: RunGraphPublication | undefined
  const value = await connection.transaction(async (sql) => {
    publication = await openRunGraphPublication(sql, scope, initialize)
    return work(publication)
  })
  return { value, publication: publication!.receipt }
}
