import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'
import { RunGraphError } from './errors.js'

export interface GraphSqlClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>
}
export interface GraphTransactionSql extends GraphSqlClient { readonly transaction: true }
const adoptedClients = new WeakSet<pg.ClientBase>()
const leases = new WeakMap<GraphSqlClient, { live: boolean; failed: boolean; committed: boolean; finalizers: (() => Promise<void>)[] }>()
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

const context = new AsyncLocalStorage<ExclusiveGraphConnection>()

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
  #closing = false
  constructor(client: pg.ClientBase, assertOwner: () => void) {
    if (adoptedClients.has(client)) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
    adoptedClients.add(client)
    this.#client = client
    this.#assertOwner = assertOwner
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new RunGraphError('GRAPH_TRANSACTION_CLOSED'))
    if (context.getStore() === this) return Promise.reject(new RunGraphError('GRAPH_TRANSACTION_NESTED'))
    const perform = async () => {
      if (this.#unusable) throw new RunGraphError('GRAPH_TRANSACTION_FAILED')
      this.#assertOwner()
      return context.run(this, work)
    }
    const result = this.#tail.then(perform, perform)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    return this.enqueue(() => {
      assertStatement(text)
      return this.#client.query<R>(text, values)
    })
  }
  transaction<T>(work: (sql: GraphTransactionSql) => Promise<T>, readOnly = false): Promise<T> {
    return this.enqueue(async () => {
      const state = { live: true, failed: false, committed: false, finalizers: [] as (() => Promise<void>)[] }
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
          const operation = this.#client.query<R>(text, values)
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
        await this.#client.query(readOnly ? 'begin isolation level repeatable read read only' : 'begin isolation level read committed')
        const result = await work(sql)
        for (const finalize of state.finalizers) { assertGraphTransaction(sql); await finalize() }
        if (pending) { state.failed = true; await pending.catch(() => undefined) }
        assertGraphTransaction(sql)
        this.#assertOwner()
        committing = true
        await this.#client.query('commit')
        state.committed = true
        return result
      } catch (error) {
        if (pending) await pending.catch(() => undefined)
        if (committing) this.#unusable = true // COMMIT outcome can be unknown: do not retry the callback.
        try { await this.#client.query('rollback') } catch { this.#unusable = true }
        throw error
      } finally { state.live = false }
    })
  }
  async close(): Promise<void> {
    this.#closing = true
    await this.#tail
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
