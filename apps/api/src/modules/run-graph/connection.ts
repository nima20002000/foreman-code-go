import { beginRuntimeTiming, runtimeTimingChannel, timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { RunGraphError } from './errors.js'
import { isDatabaseTimeout, retryDatabaseTimeout } from '../../infrastructure/databaseTimeout.js'

export interface GraphSqlClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>
}
export interface GraphTransactionSql extends GraphSqlClient { readonly transaction: true }
const adoptedClients = new WeakSet<pg.ClientBase>()
const leases = new WeakMap<GraphSqlClient, {
  live: boolean; failed: boolean; committed: boolean; readOnly: boolean; finalizers: (() => Promise<void>)[]
}>()
export function isReadOnlyGraphTransaction(sql: GraphSqlClient): boolean {
  return leases.get(sql)?.readOnly === true
}
export function didGraphTransactionCommit(sql: GraphTransactionSql): boolean {
  return leases.get(sql)?.committed === true
}

export function poisonGraphTransaction(sql: GraphTransactionSql): void {
  const state = leases.get(sql)
  if (state) state.failed = true
}

export function beforeGraphCommit(sql: GraphTransactionSql, finalize: () => Promise<void>): void {
  assertGraphTransaction(sql)
  leases.get(sql)!.finalizers.push(finalize)
}

interface CommitCheckBatch { key: object; verify: (expected: readonly unknown[]) => Promise<void>; expected: unknown[] }
const commitCheckBatches = new WeakMap<() => Promise<void>, CommitCheckBatch>()

/** Adjacent read-only checks share one live read, while every captured expectation
 * is verified. An intervening finalizer always starts a separate check batch. */
export function beforeGraphCommitChecks<T>(sql: GraphTransactionSql, key: object, expected: T,
  verify: (expected: readonly T[]) => Promise<void>): void {
  assertGraphTransaction(sql)
  const finalizers = leases.get(sql)!.finalizers
  const last = finalizers.at(-1)
  const batch = last && commitCheckBatches.get(last)
  if (batch?.key === key && batch.verify === verify) { batch.expected.push(expected); return }
  const next = { key, verify: verify as CommitCheckBatch['verify'], expected: [expected] }
  const finalize = () => next.verify(next.expected)
  commitCheckBatches.set(finalize, next)
  finalizers.push(finalize)
}

const context = new AsyncLocalStorage<ExclusiveGraphConnection>()

function queryTimingFields(text: string) {
  return {
    operation: text.trimStart().match(/^(select|insert|update|delete|with)\b/i)?.[1]?.toLowerCase() ?? 'other',
    ...(runtimeTimingChannel.hasSubscribers ? {
      statementId: createHash('sha256').update(text).digest('hex').slice(0, 16),
    } : {}),
  }
}

/** Runtime check as well as a TypeScript port: a plain Pool/Client cannot impersonate a transaction. */
export function assertGraphTransaction(sql: GraphSqlClient): asserts sql is GraphTransactionSql {
  const state = leases.get(sql)
  if (!state?.live) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
  if (state.failed) throw new RunGraphError('GRAPH_TRANSACTION_FAILED')
}

/**
 * The owner supplies EXCLUSIVE lifetime ownership of this connection. All other
 * callers MUST use this facade, not its original raw client. The facade queues
 * ordinary queries and whole transactions, rejects reentrant BEGIN and prevents
 * leaked transaction clients from being used after the callback has finished.
 * Construction does NOT acquire RunOwnership or confer workflow authority.
 */
export class ExclusiveGraphConnection implements GraphSqlClient {
  readonly #client: pg.ClientBase
  readonly #assertOwner: () => void
  #tail: Promise<void> = Promise.resolve()
  #unusable = false
  #unusableCause: unknown
  #closing = false
  constructor(client: pg.ClientBase, assertOwner: () => void,
    private readonly readPlans?: Map<string, string>) {
    if (adoptedClients.has(client)) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
    adoptedClients.add(client)
    this.#client = client
    this.#assertOwner = assertOwner
  }
  private readQuery<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    // Only dedicated physical sessions opt in. Plans are reused; rows and authority are read on every call.
    if (!this.readPlans || !values?.length || !/^\s*(select|with)\b/i.test(text)) {
      return this.#client.query<R>(text, values)
    }
    let name = this.readPlans.get(text)
    if (!name && this.readPlans.size < 128) {
      name = `foreman-read-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
      this.readPlans.set(text, name)
    }
    return name ? this.#client.query<R>({ name, text, values }) : this.#client.query<R>(text, values)
  }
  private enqueue<T>(work: () => Promise<T>, operation: string): Promise<T> {
    if (this.#closing) return Promise.reject(new RunGraphError('GRAPH_TRANSACTION_CLOSED'))
    if (context.getStore() === this) return Promise.reject(new RunGraphError('GRAPH_TRANSACTION_NESTED'))
    const queued = beginRuntimeTiming('db', 'connection.queue', { operation })
    const perform = async () => {
      queued()
      const finished = beginRuntimeTiming('db', `connection.${operation}`)
      try {
        if (this.#unusable) throw new RunGraphError('GRAPH_TRANSACTION_FAILED', { cause: this.#unusableCause })
        this.#assertOwner()
        return await context.run(this, work)
      } finally { finished() }
    }
    const result = this.#tail.then(perform, perform)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.enqueue(() => {
      assertStatement(text)
      return timeRuntimeOperation('db', 'sql.query', () => this.readQuery<R>(text, values),
        queryTimingFields(text))
    }, 'query')
  }
  transaction<T>(work: (sql: GraphTransactionSql) => Promise<T>, readOnly = false): Promise<T> {
    return this.enqueue(async () => {
      const state = {
        live: true, failed: false, committed: false, readOnly, finalizers: [] as (() => Promise<void>)[],
      }
      let pending: Promise<unknown> | undefined
      const sql: GraphTransactionSql = {
        transaction: true,
        query: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) => {
          try {
            assertGraphTransaction(sql)
            this.#assertOwner()
            assertStatement(text)
            if (pending) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
          } catch (error) { state.failed = true; return Promise.reject(error) }
          const operation = timeRuntimeOperation('db', 'sql.query', () => this.readQuery<R>(text, values),
            queryTimingFields(text))
          pending = operation
          // A caught SQL error must still prevent commit, including after SAVEPOINT misuse.
          return operation.then((result) => { pending = undefined; return result }, (error: unknown) => {
            state.failed = true; pending = undefined; throw error
          })
        },
      }
      leases.set(sql, state)
      const status = (this.#client as pg.ClientBase & { getTransactionStatus?: () => string | null }).getTransactionStatus?.()
      if (status && status !== 'I') { state.live = false; throw new RunGraphError('GRAPH_TRANSACTION_NESTED') }
      let committing = false
      try {
        await timeRuntimeOperation('db', 'sql.begin', () => this.#client.query(
          readOnly ? 'begin isolation level repeatable read read only' : 'begin isolation level read committed'))
        const result = await work(sql)
        for (const finalize of state.finalizers) { assertGraphTransaction(sql); await finalize() }
        if (pending) { state.failed = true; await pending.catch(() => { /* ignore: the rejection is handled by whoever consumes this promise; this only prevents an unhandled-rejection report */ }) }
        assertGraphTransaction(sql)
        this.#assertOwner()
        committing = true
        await timeRuntimeOperation('db', 'sql.commit', () => this.#client.query('commit'))
        state.committed = true
        return result
      } catch (error) {
        if (pending) await pending.catch(() => { /* ignore: the rejection is handled by whoever consumes this promise; this only prevents an unhandled-rejection report */ })
        if (committing && !isDatabaseTimeout(error)) {
          // COMMIT outcome can be unknown: do not retry the callback.
          this.#unusable = true
          this.#unusableCause = error
        }
        // A confirmed rollback restores the session after a query deadline. The
        // caller still receives the error and must reconcile an uncertain COMMIT.
        try {
          // Rollback only undoes this connection's uncommitted work, including after ownership loss.
          await retryDatabaseTimeout(() => timeRuntimeOperation('db', 'sql.rollback', () => this.#client.query('rollback')))
        }
        catch (rollbackError) {
          if (!this.#unusable) this.#unusableCause = rollbackError
          this.#unusable = true
        }
        throw error
      } finally { state.live = false }
    }, 'transaction')
  }
  async close(): Promise<void> {
    this.#closing = true
    await this.#tail
    this.readPlans?.clear()
    adoptedClients.delete(this.#client)
  }
  get unusable(): boolean { return this.#unusable }
}

// Defense against accidental transaction control. This is not a SQL sandbox:
// only trusted repository code may call this port; no user/model SQL is accepted.
function assertStatement(text: string): void {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim()
  if (/^(begin|start\s+transaction|commit|end|rollback|savepoint|release\s+savepoint|prepare\s+transaction)\b/i.test(plain)
    || /;\s*\S/.test(plain)) throw new RunGraphError('GRAPH_TRANSACTION_NESTED')
}

/** Fresh checked-out Pool lease. Never uses pool.query to simulate a transaction. */
export async function withExclusiveGraphConnection<T>(pool: pg.Pool, work: (connection: ExclusiveGraphConnection) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let lost = false
  const markLost = () => { lost = true }
  client.on('error', markLost)
  client.on('end', markLost)
  const connection = new ExclusiveGraphConnection(client, () => {
    if (lost) throw new RunGraphError('GRAPH_OWNER_LOST')
  })
  try { return await work(connection) } finally {
    await connection.close()
    client.removeListener('error', markLost)
    client.removeListener('end', markLost)
    client.release(lost || connection.unusable)
  }
}
