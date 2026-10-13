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
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect()
    let releaseError: Error | undefined
    try {
      await beginTransaction(client, options)
      const result = await perform(client)
      await commitTransaction(client)
      return result
    } catch (error) {
      releaseError = await rollbackAfterFailure(client)
      if (releaseError || attempt >= (options.conflictRetries ?? 0) || !isTransactionConflict(error)) throw error
    } finally { client.release(releaseError) }
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
  await beginTransaction(client, options)
  try {
    const result = await perform()
    await commitTransaction(client)
    return result
  } catch (error) {
    await rollbackAfterFailure(client)
    throw error
  }
}

/** A supplied client belongs to the caller's transaction, including its commit/rollback. */
export async function inTransaction<T>(
  pool: Pick<pg.Pool, 'connect'>,
  supplied: pg.ClientBase | undefined,
  perform: (client: pg.ClientBase) => Promise<T>,
): Promise<T> {
  return supplied ? perform(supplied) : withTransaction(pool, perform)
}
