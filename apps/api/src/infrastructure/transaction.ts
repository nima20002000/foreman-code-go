import type pg from 'pg'
import { componentLogger } from '../modules/diagnostics/logger.js'

/**
 * The one module that issues transaction-control statements. Everything else runs a transaction
 * through withTransaction, or, for a session that must span several transactions, the statement
 * primitives below.
 */

/** Minimal SQL port: a Pool, a client or a graph transaction all satisfy it. */
export interface SqlQuery {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>
}
/**
 * A session that can hold transaction-scoped locks: a checked-out client or a graph transaction.
 * A bare Pool never satisfies it, so lock-taking helpers cannot run each statement on a different connection.
 */
export type TransactionSql = SqlQuery & ({ release(err?: Error | boolean): void } | { readonly transaction: true })

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read'
  readOnly?: boolean
  /** Extra whole-transaction attempts after a serialization failure or deadlock. Only for replay-safe callbacks. */
  conflictRetries?: number
}

function beginStatement(options: TransactionOptions): string {
  return ['begin', options.isolation && `isolation level ${options.isolation}`, options.readOnly && 'read only']
    .filter(Boolean).join(' ')
}

export async function beginTransaction(client: pg.ClientBase, options: TransactionOptions = {}): Promise<void> {
  await client.query(beginStatement(options))
}

export async function commitTransaction(client: pg.ClientBase): Promise<void> {
  await client.query('commit')
}

export async function rollbackTransaction(client: pg.ClientBase): Promise<void> {
  await client.query('rollback')
}

/**
 * Rolls back after a failure without replacing the caller's error. Returns the rollback error, already logged,
 * when the session state is unknown: the caller must then discard the connection.
 */
export async function rollbackAfterFailure(client: pg.ClientBase): Promise<Error | undefined> {
  try {
    await client.query('rollback')
    return undefined
  } catch (rollbackError) {
    componentLogger('db').error({ operation: 'transaction rollback', err: rollbackError },
      'Transaction rollback failed; discarding its connection')
    return rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.')
  }
}

/** A transaction that holds its locks longer than this is reported with where its time went. */
const SLOW_TRANSACTION_MS = 1_000

/**
 * Times one transaction: statements versus the gaps between them, where the application awaited other work while
 * the transaction kept its locks. `origin` is created where the transaction was requested, so the report names
 * the caller even when the work runs from a queue.
 */
export class TransactionTiming {
  readonly #started = performance.now()
  #lastEnd = this.#started
  #queryMs = 0
  #queries = 0
  #largestGapMs = 0
  #running = 0
  constructor(private readonly origin: Error) {}

  track<T>(statement: Promise<T>): Promise<T> {
    const started = performance.now()
    if (this.#running === 0) this.#largestGapMs = Math.max(this.#largestGapMs, started - this.#lastEnd)
    this.#running += 1
    this.#queries += 1
    const settle = () => {
      this.#running -= 1
      this.#lastEnd = performance.now()
      this.#queryMs += this.#lastEnd - started
    }
    return statement.then(result => { settle(); return result }, (error: unknown) => { settle(); throw error })
  }

  finish(): void {
    const finished = performance.now(), totalMs = finished - this.#started
    if (totalMs <= SLOW_TRANSACTION_MS) return
    const queryMs = Math.min(this.#queryMs, totalMs)
    componentLogger('db').warn({ caller: transactionCaller(this.origin), totalMs: Math.round(totalMs),
      queryMs: Math.round(queryMs), betweenQueriesMs: Math.round(totalMs - queryMs), queries: this.#queries,
      largestGapMs: Math.round(Math.max(this.#largestGapMs, finished - this.#lastEnd)) }, 'Slow database transaction')
  }
}

/** The first application frames above the transaction helpers. */
function transactionCaller(origin: Error): string {
  return (origin.stack ?? '').split('\n').slice(1).map(line => line.trim().replace(/^at /, ''))
    .filter(line => !/infrastructure\/transaction\.|run-graph\/connection\.|node:internal|node_modules|<anonymous>/.test(line))
    .slice(0, 3).map(line => line.replace(/(?:file:\/\/)?\/\S*?\/(?=(?:src|dist|test)\/)/, '')).join(' < ')
}

/** Times every statement the transaction sends through its own client until the returned restore is called. */
function timeClientStatements(client: pg.ClientBase, timing: TransactionTiming): () => void {
  const own = Object.prototype.hasOwnProperty.call(client, 'query')
  const original = client.query
  const timed = (...args: unknown[]) => {
    const result: unknown = (original as unknown as (...values: unknown[]) => unknown).apply(client, args)
    return result instanceof Promise ? timing.track(result) : result
  }
  client.query = timed as unknown as typeof client.query
  return () => {
    if (own) client.query = original
    else delete (client as { query?: unknown }).query
  }
}

async function timedPerform<T>(client: pg.ClientBase, timing: TransactionTiming, perform: () => Promise<T>): Promise<T> {
  const restore = timeClientStatements(client, timing)
  try { return await perform() } finally { restore() }
}

function isTransactionConflict(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return code === '40001' || code === '40P01'
}

/**
 * Runs perform in one transaction on a fresh pooled connection: commit on success, rollback on any error
 * (the original error is rethrown), release always, and destroy the connection when rollback fails.
 */
export async function withTransaction<T>(
  pool: Pick<pg.Pool, 'connect'>,
  perform: (client: pg.PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const origin = new Error('transaction caller')
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect()
    const timing = new TransactionTiming(origin)
    let releaseError: Error | undefined
    try {
      await beginTransaction(client, options)
      const result = await timedPerform(client, timing, () => perform(client))
      await commitTransaction(client)
      return result
    } catch (error) {
      releaseError = await rollbackAfterFailure(client)
      if (releaseError || attempt >= (options.conflictRetries ?? 0) || !isTransactionConflict(error)) throw error
    } finally {
      client.release(releaseError)
      timing.finish()
    }
  }
}

/**
 * One transaction on a connection the caller owns, keeps and releases. A failed BEGIN is not rolled back;
 * any later error is (the original error is rethrown, a failed rollback is logged).
 */
export async function withClientTransaction<T>(
  client: pg.ClientBase,
  perform: () => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const timing = new TransactionTiming(new Error('transaction caller'))
  await beginTransaction(client, options)
  try {
    const result = await timedPerform(client, timing, perform)
    await commitTransaction(client)
    return result
  } catch (error) {
    await rollbackAfterFailure(client)
    throw error
  } finally { timing.finish() }
}

/** A supplied client belongs to the caller's transaction, including its commit/rollback. */
export async function inTransaction<T>(
  pool: Pick<pg.Pool, 'connect'>,
  supplied: pg.ClientBase | undefined,
  perform: (client: pg.ClientBase) => Promise<T>,
): Promise<T> {
  return supplied ? perform(supplied) : withTransaction(pool, perform)
}
