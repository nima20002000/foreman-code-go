import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, NativeSessionReferenceSchema,
  type HarnessExecution, type NativeSessionReference } from '@graphql/contracts'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { ClosedWorkflowSession } from './stoppedWorkflowFinalization.js'

/** Backend-only lifetime receipt. It is not a native action or Run authority.
 * Reserve BEFORE credential preflight (which can spawn OpenCode), create or
 * attach. Record ONLY after the captured manager confirms exact-session close.
 * No receipt is synthesized for pre-upgrade or uncertain native work. */
export interface WorkflowClosureStore {
  begin(execution: HarnessExecution): Promise<string>
  record(execution: HarnessExecution, session: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<ClosedWorkflowSession>
  recordDetached(execution: HarnessExecution, session: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<void>
  read(execution: HarnessExecution): Promise<ClosedWorkflowSession | undefined>
  /** Positive disposal of the ORIGINAL manager, including a failed create or
   * credential preflight that never returned a session identity. Not absence. */
  recordUnbound(execution: HarnessExecution, generation: string, assertCurrent: () => void): Promise<UnboundWorkflowClosure>
  readUnbound(execution: HarnessExecution): Promise<UnboundWorkflowClosure | undefined>
}

function conflict(): never {
  throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
    'Native closure does not match the current execution, session and manager lifetime.', 409)
}

// These values are immutable across a native lifetime. Native identity is bound
// separately because createSession has not returned when begin commits.
function executionIdentity(execution: HarnessExecution) {
  return { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt,
    ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
    ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}) }
}

export interface UnboundWorkflowClosure {
  execution: ReturnType<typeof executionIdentity>
  durableGeneration: string
}

interface ClosureRow {
  generation: string
  execution_identity: unknown
  expected_reference: unknown | null
  closed_reference: unknown | null
  closed: boolean
  detached: boolean
  detached_reference: unknown | null
  prior_unclosed: boolean
  closed_without_session: boolean
}

type Sql = GraphSqlClient
async function latest(sql: Sql, executionId: string): Promise<ClosureRow | undefined> {
  const result = await sql.query<ClosureRow>(`select generation::text,execution_identity,
    expected_reference,closed_reference,closed_at is not null as closed,detached_at is not null as detached,detached_reference,closed_without_session,
    exists(select 1 from execution_native_closures prior where prior.execution_id=c.execution_id
      and prior.generation<c.generation and prior.closed_at is null and prior.detached_at is null) as prior_unclosed
    from execution_native_closures c where execution_id=$1 order by generation desc limit 1`, [executionId])
  return result.rows[0]
}

async function exactLifetime(sql: Sql, executionId: string, generation: string): Promise<ClosureRow | undefined> {
  if (!/^[1-9][0-9]*$/.test(generation)) return conflict()
  return (await sql.query<ClosureRow>(`select generation::text,execution_identity,expected_reference,closed_reference,
    closed_at is not null as closed,detached_at is not null as detached,detached_reference,closed_without_session,
    exists(select 1 from execution_native_closures p where p.execution_id=c.execution_id
      and p.generation<c.generation and p.closed_at is null and p.detached_at is null) as prior_unclosed
    from execution_native_closures c where execution_id=$1 and generation=$2::bigint for update`,
  [executionId, generation])).rows[0]
}

/** The caller's execution is always checked against fresh durable identity.
 * A newer preflight invalidates an earlier close, even before native attach
 * obtains a writer lane. An unclosed older lifetime also remains outstanding.
 * A missing row/manager/process proves nothing. */
export async function readWorkflowClosure(sql: Sql, execution: HarnessExecution): Promise<ClosedWorkflowSession | undefined> {
  const result = await sql.query<ClosureRow & { record: unknown; reference: unknown }>(`select
    c.generation::text,c.execution_identity,c.expected_reference,c.closed_reference,
    c.closed_at is not null as closed,c.detached_at is not null as detached,c.detached_reference,c.closed_without_session,e.record,s.reference,
    exists(select 1 from execution_native_closures prior where prior.execution_id=e.id
      and prior.generation<c.generation and prior.closed_at is null and prior.detached_at is null) as prior_unclosed
    from harness_executions e join execution_native_sessions s on s.execution_id=e.id
    join lateral (select * from execution_native_closures where execution_id=e.id
      order by generation desc limit 1) c on true where e.id=$1 and e.run_id=$2`, [execution.id, execution.runId])
  const row = result.rows[0]
  if (!row || !row.closed || row.detached || row.closed_without_session || row.prior_unclosed !== false) return undefined
  const current = HarnessExecutionSchema.parse(row.record)
  const session = NativeSessionReferenceSchema.parse(row.reference)
  if (!isDeepStrictEqual(executionIdentity(current), executionIdentity(execution))
    || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
    || current.nativeSessionId !== session.nativeSessionId || execution.nativeSessionId !== session.nativeSessionId
    || !isDeepStrictEqual(row.closed_reference, session)
    || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
  return { execution: { ...executionIdentity(current), nativeSessionId: session.nativeSessionId },
    session, durableGeneration: row.generation }
}

/** No-session closure is accepted only from the exact reserved lifetime's
 * positive manager-dispose receipt. The absent binding is a consistency check,
 * never the source of this proof. It cannot accept success or authorize retry. */
export async function readUnboundWorkflowClosure(sql: Sql, execution: HarnessExecution): Promise<UnboundWorkflowClosure | undefined> {
  const row = await latest(sql, execution.id)
  if (!row || !row.closed || row.detached || !row.closed_without_session || row.prior_unclosed !== false) return undefined
  const current = (await sql.query<{ record: unknown; bound: boolean }>(`select e.record,
    exists(select 1 from execution_native_sessions s where s.execution_id=e.id) as bound
    from harness_executions e where e.id=$1 and e.run_id=$2`, [execution.id, execution.runId])).rows[0]
  if (!current) return conflict()
  const parsed = HarnessExecutionSchema.parse(current.record)
  if (execution.nativeSessionId || parsed.nativeSessionId || current.bound || row.expected_reference !== null
    || row.closed_reference !== null || !isDeepStrictEqual(executionIdentity(execution), executionIdentity(parsed))
    || !isDeepStrictEqual(row.execution_identity, executionIdentity(parsed))) return conflict()
  return { execution: executionIdentity(parsed), durableGeneration: row.generation }
}

/** Uses ordinary short SQL transactions for private lifecycle receipts only.
 * No native calls occur in SQL. Finalization remains a separate Run-owner duty.
 * Parent Run then execution locks serialize lifetime admission with Stop and
 * owner-fenced workflow finalization; old closure evidence is never overwritten.
 */
export class PostgresWorkflowClosureStore implements WorkflowClosureStore {
  constructor(private readonly pool: pg.Pool) {}

  private async transaction<T>(execution: HarnessExecution, work: (sql: Sql, current: HarnessExecution) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const parent = await client.query('select id from runs where id=$1 for update', [execution.runId])
      const row = await client.query<{ record: unknown }>(
        'select record from harness_executions where id=$1 and run_id=$2 for update', [execution.id, execution.runId])
      if (parent.rowCount !== 1 || row.rowCount !== 1) return conflict()
      const current = HarnessExecutionSchema.parse(row.rows[0]!.record)
      if (!isDeepStrictEqual(executionIdentity(current), executionIdentity(execution))) return conflict()
      const value = await work(client, current)
      await client.query('commit')
      return value
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async begin(execution: HarnessExecution): Promise<string> {
    return this.transaction(execution, async (sql, current) => {
      // This does not authorize native work. The existing continuation,
      // credentials, harness and writer-lane checks still run at their boundaries.
      const allowed = await sql.query(`select 1 from runs r where r.id=$1
        and r.execution_state in ('running','waiting') and r.record->>'executionState'=r.execution_state
        and r.record->>'outcome'='pending' and r.stop_requested_at is null
        and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)`, [execution.runId])
      if (allowed.rowCount !== 1) return conflict()
      const previous = await latest(sql, execution.id)
      if (previous && (!(previous.closed || previous.detached) || previous.prior_unclosed)) return conflict()
      const native = await sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])
      const reference = native.rows[0] ? NativeSessionReferenceSchema.parse(native.rows[0].reference) : null
      if (current.nativeSessionId && reference?.nativeSessionId !== current.nativeSessionId) return conflict()
      const result = await sql.query<{ generation: string }>(`insert into execution_native_closures
        (execution_id,execution_identity,expected_reference) values($1,$2::jsonb,$3::jsonb) returning generation::text`,
      [execution.id, JSON.stringify(executionIdentity(current)), reference === null ? null : JSON.stringify(reference)])
      return result.rows[0]!.generation
    })
  }

  async record(execution: HarnessExecution, reference: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<ClosedWorkflowSession> {
    assertCurrent()
    const session = NativeSessionReferenceSchema.parse(reference)
    return this.transaction(execution, async (sql, current) => {
      assertCurrent()
      const row = await exactLifetime(sql, execution.id, generation)
      if (!row || row.detached || row.generation !== generation || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
        || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
      const native = await sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])
      if (current.nativeSessionId !== session.nativeSessionId || !isDeepStrictEqual(native.rows[0]?.reference, session)) return conflict()
      if (row.closed) {
        if (!isDeepStrictEqual(row.closed_reference, session)) return conflict()
      } else {
        const updated = await sql.query(`update execution_native_closures
          set closed_reference=$3::jsonb,closed_at=clock_timestamp()
          where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null returning generation`,
        [execution.id, generation, JSON.stringify(session)])
        if (updated.rowCount !== 1) return conflict()
      }
      // This synchronous check is immediately before COMMIT, with the parent
      // and execution locks still held. A late attach/local replacement cannot
      // convert its predecessor's close into the successor's closure evidence.
      assertCurrent()
      return { execution: { ...executionIdentity(current), nativeSessionId: session.nativeSessionId },
        session, durableGeneration: generation }
    })
  }

  async recordDetached(execution: HarnessExecution, reference: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<void> {
    assertCurrent()
    const session = NativeSessionReferenceSchema.parse(reference)
    await this.transaction(execution, async (sql, current) => {
      assertCurrent()
      const row = await exactLifetime(sql, execution.id, generation)
      if (!row || row.closed || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
        || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
      const native = (await sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])).rows[0]
      if (current.nativeSessionId !== session.nativeSessionId || !isDeepStrictEqual(native?.reference, session)) return conflict()
      if (row.detached) {
        if (!isDeepStrictEqual(row.detached_reference, session)) return conflict()
      } else if ((await sql.query(`update execution_native_closures
        set detached_reference=$3::jsonb,detached_at=clock_timestamp()
        where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null returning generation`,
      [execution.id, generation, JSON.stringify(session)])).rowCount !== 1) return conflict()
      assertCurrent()
    })
  }

  async recordUnbound(execution: HarnessExecution, generation: string,
    assertCurrent: () => void): Promise<UnboundWorkflowClosure> {
    assertCurrent()
    return this.transaction(execution, async (sql, current) => {
      assertCurrent()
      const row = await exactLifetime(sql, execution.id, generation)
      if (!row || row.detached || row.generation !== generation
        || row.expected_reference !== null || current.nativeSessionId || execution.nativeSessionId
        || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))) return conflict()
      if ((await sql.query('select 1 from execution_native_sessions where execution_id=$1', [execution.id])).rowCount !== 0) return conflict()
      if (row.closed) {
        if (!row.closed_without_session || row.closed_reference !== null) return conflict()
      } else {
        const changed = await sql.query(`update execution_native_closures set closed_without_session=true,closed_at=clock_timestamp()
          where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null returning generation`, [execution.id, generation])
        if (changed.rowCount !== 1) return conflict()
      }
      assertCurrent()
      return { execution: executionIdentity(current), durableGeneration: generation }
    })
  }

  readUnbound(execution: HarnessExecution): Promise<UnboundWorkflowClosure | undefined> {
    return readUnboundWorkflowClosure(this.pool, execution)
  }

  read(execution: HarnessExecution): Promise<ClosedWorkflowSession | undefined> {
    return readWorkflowClosure(this.pool, execution)
  }
}
