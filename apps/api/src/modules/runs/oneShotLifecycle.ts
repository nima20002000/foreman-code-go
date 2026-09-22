import type pg from 'pg'
import { WorkflowRunV2Schema, RunGraphScopeSchema, type GraphEffectAuthority, type GraphFact } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { graphSourceDigest, openRunGraphPublication, type RunGraphPublication } from '../run-graph/publication.js'
import { readOneShotRunState } from './oneShotPostgres.js'

/** SQL-only command authorization; management callers pass the same live policy
 * they use for commands, not a caller-provided boolean or native write lease. */
export type AuthorizeOneShotStop = (sql: GraphTransactionSql) => Promise<void>

export async function changeOneShotLifecycle(pool: pg.Pool, runId: string,
  change: { kind: 'stop'; authorize?: AuthorizeOneShotStop } | { kind: 'cleanup'; pending: boolean }): Promise<void> {
  await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const initial = await sql.query<{ record: unknown }>('select record from runs where id=$1', [runId])
    const discovery = WorkflowRunV2Schema.parse(initial.rows[0]?.record)
    const scope = RunGraphScopeSchema.parse({ workspaceId: discovery.workspaceId, workflowId: discovery.workflowId,
      runId, workflowVersionId: discovery.workflowVersionId, executionSemanticsVersion: 2 })
    const publication = await openRunGraphPublication(sql, scope)
    const found = await sql.query<{ record: unknown; stopped: boolean }>(
      'select record,stop_requested_at is not null as stopped from runs where id=$1', [runId])
    const run = WorkflowRunV2Schema.parse(found.rows[0]?.record)
    const stopped = found.rows[0]!.stopped
    if (change.kind === 'stop') {
      await change.authorize?.(sql)
      if (stopped || run.executionState === 'completed') return
      const effect = { identity: { kind: 'run.stop' as const, entityId: runId }, digest: graphSourceDigest({ runId, stop: true }) }
      const readAuthority = async (): Promise<GraphEffectAuthority> => {
        await change.authorize?.(sql)
        // This is the EXISTING authorized command transaction, not a second
        // execution owner. Stop serializes against execution by the parent lock.
        const current = await sql.query<{ owner: string; fence: string; record: unknown }>(
          'select pg_backend_pid()::text as owner,txid_current()::text as fence,record from runs where id=$1', [runId])
        const row = current.rows[0]
        if (!row) throw new DomainError('RUN_NOT_FOUND', 'The Run no longer exists.', 404)
        const actual = WorkflowRunV2Schema.parse(row.record)
        return { scope: { workspaceId: actual.workspaceId, workflowId: actual.workflowId, runId: actual.id,
          workflowVersionId: actual.workflowVersionId, executionSemanticsVersion: 2 },
        effect: effect.identity, effectDigest: effect.digest, ownerId: row.owner, fence: row.fence,
        connectionGeneration: null, ownership: 'held', access: 'effect', security: 'valid',
        effectClosed: actual.executionState === 'completed', submission: 'unknown' }
      }
      const authority = await readAuthority()
      const expected = { scope: authority.scope, effect: authority.effect, effectDigest: authority.effectDigest,
        ownerId: authority.ownerId, fence: authority.fence, connectionGeneration: null }
      const state = await readOneShotRunState(sql, runId, run, true)
      state.cleanupPending = true
      await publication.effect({ effect, sourceDigest: effect.digest,
        evidence: { sourceKind: 'run', sourceId: `stop-${effect.digest.slice(7)}`, sourceRevision: '0' },
        facts: [{ type: 'run.state', state }] }, { expected, readCurrentLocked: readAuthority }, async () => {
        await sql.query(`insert into run_cleanup_intents(run_id) values($1)
          on conflict(run_id) do update set pending=true,updated_at=now()`, [runId])
      })
      return
    }
    await publishOneShotCleanup(publication, change.pending)
  }))
}

/** Admission producer for an already authorized, validated Run in the caller's
 * G1 transaction. No rollout switch exists here; production admission stays OFF.
 * Isolated qualification fixtures call this together with their Run INSERT.
 */
export async function initializeOneShotPublication(sql: GraphTransactionSql, input: unknown): Promise<void> {
  const run = WorkflowRunV2Schema.parse(input)
  const scope = RunGraphScopeSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 2 })
  const publication = await openRunGraphPublication(sql, scope, { historyCoverage: 'from_admission' })
  const state = await readOneShotRunState(sql, run.id, run, false)
  await publication.source({ evidence: { sourceKind: 'run', sourceId: run.id, sourceRevision: '0' },
    sourceDigest: graphSourceDigest(run), facts: [{ type: 'run.state', state }] }, async () => undefined)
}

/** SQL-only cleanup producer for a caller already holding the frozen G1
 * publication. Shared lifecycle writers compose here, rather than handing a
 * raw PoolClient to a method that might independently BEGIN/COMMIT. */
export async function publishOneShotCleanup(publication: RunGraphPublication, pending: boolean): Promise<void> {
  const { sql, scope } = publication
  const runId = scope.runId
  if (scope.executionSemanticsVersion !== 2) throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'This producer only handles v2 Runs.', 409)
  const rows = await sql.query<{ record: unknown; stopped: boolean }>(
    'select record,stop_requested_at is not null as stopped from runs where id=$1', [runId])
  const run = WorkflowRunV2Schema.parse(rows.rows[0]?.record)
  const stopped = rows.rows[0]!.stopped
  const previous = await sql.query<{ pending: boolean; attempts: number }>(
    'select pending,attempts from run_cleanup_intents where run_id=$1 for update', [runId])
  if (previous.rows[0]?.pending === pending) return
  const state = await readOneShotRunState(sql, runId, run, stopped)
  state.cleanupPending = pending
  const head = await sql.query<{ revision: string }>(
    'select (head_sequence+1)::text as revision from run_graph_heads where run_id=$1', [runId])
  const facts: GraphFact[] = [{ type: 'run.state', state }]
  await publication.source({ evidence: { sourceKind: 'cleanup', sourceId: runId, sourceRevision: head.rows[0]!.revision },
    sourceDigest: graphSourceDigest({ before: previous.rows[0]?.pending ?? null, pending: pending }), facts }, async () => {
    await sql.query(`insert into run_cleanup_intents(run_id,pending) values($1,$2)
    on conflict(run_id) do update set pending=$2,attempts=run_cleanup_intents.attempts+1,
      last_error=case when $2 then 'Native cleanup remains unconfirmed.' else null end,updated_at=now()`, [runId, pending])
  })
}
