import type pg from 'pg'
import {
  GraphSequenceSchema, RUN_GRAPH_LIMITS, RunGraphBatchSchema, RunGraphCurrentStateSchema,
  RunGraphPageSchema, RunGraphReadRequestSchema, RunGraphEventsRequestSchema, RunGraphSnapshotSchema,
  RunGraphResetSchema, canonicalGraphJson, graphJsonBytes, sameGraphScope,
  type RunGraphScope, type RunGraphPage, type RunGraphReset, type RunGraphSnapshot,
  type RunGraphBatch, type RunGraphCurrentState, type RunGraphTopology,
} from '@foreman-code/contracts/wave25'
import { withExclusiveGraphConnection, type GraphTransactionSql } from './connection.js'
import { RunGraphError } from './errors.js'

export type AuthorizeRunGraphRead = (sql: GraphTransactionSql, scope: RunGraphScope) => Promise<void>
export type ReadCurrentRunGraph = (sql: GraphTransactionSql, scope: RunGraphScope) => Promise<{ topology: RunGraphTopology; state: RunGraphCurrentState }>
interface Head { head_sequence: string; retention_floor: string; protocol_version: number; history_coverage: 'from_admission' | 'from_snapshot' }

function readRequest(input: unknown): { protocolVersion: 1; scope: RunGraphScope } {
  if (typeof input !== 'object' || input === null || !('protocolVersion' in input) || input.protocolVersion !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
  const parsed = RunGraphReadRequestSchema.safeParse(input)
  if (!parsed.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  return parsed.data
}
async function authorizedHead(sql: GraphTransactionSql, scope: RunGraphScope, authorize: AuthorizeRunGraphRead): Promise<Head> {
  // No permissive default; both HTTP and Operator MCP must inject the same service policy.
  if (typeof authorize !== 'function') throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
  try { await authorize(sql, scope) } catch { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
  const result = await sql.query<Head>(
    `select h.head_sequence::text,h.retention_floor::text,h.protocol_version,h.history_coverage
     from runs r join workflow_versions v on v.id=r.workflow_version_id
     left join run_graph_heads h on h.run_id=r.id
     where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and r.workflow_version_id=$4
       and v.execution_semantics_version=$5`,
    [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId, scope.executionSemanticsVersion],
  )
  const row = result.rows[0]
  if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  if (row.head_sequence === null) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
  if (row.protocol_version !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
  return row
}
function reset(scope: RunGraphScope, requestedSequence: string, head: Head, reason: RunGraphReset['reason']): RunGraphReset {
  return RunGraphResetSchema.parse({
    kind: 'reset', protocolVersion: 1, scope, reason, requestedSequence,
    headSequence: head.head_sequence, retentionFloor: head.retention_floor, action: 'fetch_snapshot',
  })
}

/** Coherent primary-database cut. assemble may only query using this same read-only transaction. */
export async function readRunGraphSnapshot(
  pool: pg.Pool, input: unknown, authorize: AuthorizeRunGraphRead, assemble: ReadCurrentRunGraph,
): Promise<RunGraphSnapshot> {
  const request = readRequest(input)
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const head = await authorizedHead(sql, request.scope, authorize)
    const current = await assemble(sql, request.scope)
    if (graphJsonBytes(current) > RUN_GRAPH_LIMITS.snapshotBytes) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    const parsedState = RunGraphCurrentStateSchema.safeParse(current.state)
    if (!parsedState.success) throw new RunGraphError(parsedState.error.issues.some((issue) => issue.code === 'too_big') ? 'GRAPH_SNAPSHOT_TOO_LARGE' : 'GRAPH_INVARIANT_VIOLATION')
    const state = parsedState.data
    const result = {
      protocolVersion: 1 as const, scope: request.scope,
      asOfSequence: head.head_sequence, retentionFloor: head.retention_floor,
      historyCoverage: head.history_coverage, topology: current.topology, state,
    }
    if (graphJsonBytes(result) > RUN_GRAPH_LIMITS.snapshotBytes) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
    const parsed = RunGraphSnapshotSchema.safeParse(result)
    if (!parsed.success) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    return parsed.data
  }, true))
}

/** Constant-bounded metadata reads and COMPLETE publication payloads only; never Activity history. */
export async function readRunGraphPage(
  pool: pg.Pool, input: unknown, authorize: AuthorizeRunGraphRead,
): Promise<RunGraphPage | RunGraphReset> {
  if (typeof input !== 'object' || input === null || !('afterSequence' in input)) throw new RunGraphError('GRAPH_INVALID_CURSOR')
  const cursor = GraphSequenceSchema.safeParse(input.afterSequence)
  if (!cursor.success) throw new RunGraphError('GRAPH_INVALID_CURSOR')
  if (!('protocolVersion' in input) || input.protocolVersion !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
  const parsedRequest = RunGraphEventsRequestSchema.safeParse(input)
  if (!parsedRequest.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  const request = parsedRequest.data
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const head = await authorizedHead(sql, request.scope, authorize)
    const after = BigInt(cursor.data)
    if (after < BigInt(head.retention_floor)) return reset(request.scope, cursor.data, head, 'history_expired')
    if (after > BigInt(head.head_sequence)) return reset(request.scope, cursor.data, head, 'cursor_ahead')
    if (BigInt(head.head_sequence) - after > BigInt(RUN_GRAPH_LIMITS.catchupBatches)) return reset(request.scope, cursor.data, head, 'catchup_limit')
    const metadata = await sql.query<{ sequence: string; kind: 'events' | 'reset'; payload_bytes: number }>(
      `select b.sequence::text,b.kind,b.payload_bytes from run_graph_batches b
       where b.run_id=$1 and b.sequence>$2::bigint and b.sequence<=$3::bigint order by b.sequence limit $4`,
      [request.scope.runId, cursor.data, head.head_sequence, RUN_GRAPH_LIMITS.pageBatches],
    )
    const batches: RunGraphBatch[] = []
    const page = (through: string): RunGraphPage => ({
      kind: 'page', protocolVersion: 1, scope: request.scope,
      baseSequence: cursor.data, throughSequence: through, headSequence: head.head_sequence,
      retentionFloor: head.retention_floor, hasMore: BigInt(through) < BigInt(head.head_sequence), batches: [...batches],
    })
    let through = cursor.data
    // Reserve envelope/cursor growth, then fetch only the selected complete bodies in ONE query.
    let budget = RUN_GRAPH_LIMITS.pageBytes - graphJsonBytes(page(through)) - 128
    const selected: string[] = []
    for (const row of metadata.rows) {
      if (BigInt(row.sequence) !== BigInt(through) + 1n) return reset(request.scope, cursor.data, head, 'gap')
      if (row.kind === 'reset') return reset(request.scope, cursor.data, head, 'atomic_change_too_large')
      if (row.kind !== 'events' || row.payload_bytes < 1 || row.payload_bytes > RUN_GRAPH_LIMITS.batchBytes) return reset(request.scope, cursor.data, head, 'schema_changed')
      if (row.payload_bytes + 1 > budget) break
      selected.push(row.sequence)
      budget -= row.payload_bytes + 1
      through = row.sequence
    }
    if (selected.length) {
      const bodies = await sql.query<{ sequence: string; payload: string }>(
        'select b.sequence::text,b.payload from run_graph_batches b where b.run_id=$1 and b.sequence=any($2::bigint[]) order by b.sequence',
        [request.scope.runId, selected],
      )
      if (bodies.rows.length !== selected.length) return reset(request.scope, cursor.data, head, 'gap')
      let previous = cursor.data
      for (const row of bodies.rows) {
        let batch: RunGraphBatch
        try { batch = RunGraphBatchSchema.parse(JSON.parse(row.payload)) } catch {
          return reset(request.scope, cursor.data, head, 'schema_changed')
        }
        if (batch.sequence !== row.sequence || batch.previousSequence !== previous || !sameGraphScope(batch.scope, request.scope)) return reset(request.scope, cursor.data, head, 'gap')
        batches.push(batch)
        previous = batch.sequence
      }
    }
    if (through === cursor.data && after < BigInt(head.head_sequence)) return reset(request.scope, cursor.data, head, 'gap')
    const response = RunGraphPageSchema.parse(page(through))
    // Validate the exact wire representation as well as individual row metadata.
    canonicalGraphJson(response, RUN_GRAPH_LIMITS.pageBytes)
    return response
  }, true))
}
