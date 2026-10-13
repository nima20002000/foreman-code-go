import pg from 'pg'
import { componentLogger } from './logger.js'
import { acquireDatabaseConnection } from './databaseReadRetry.js'
import { ignoreError } from '../modules/diagnostics/ignoredError.js'

type ConnectCallback = Parameters<pg.Pool['connect']>[0]

class ApplicationPool extends pg.Pool {
  override connect(): Promise<pg.PoolClient>
  override connect(callback: ConnectCallback): void
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const connection = acquireDatabaseConnection(() => super.connect())
    if (!callback) return connection
    void connection.then(
      client => callback(undefined, client, client.release.bind(client)),
      error => callback(error, undefined, () => {}),
    )
  }
}

export interface DatabaseOptions {
  connectionString: string
  maxConnections: number
  connectionTimeoutMs: number
  queryTimeoutMs?: number
  lockTimeoutMs?: number
  onError?: (error: Error) => void
}

/** Both application and checkpoint connections need the same failure policy. */
export function createPool(options: DatabaseOptions, applicationName: string): pg.Pool {
  const queryTimeoutMs = options.queryTimeoutMs ?? 1000
  const pool = new ApplicationPool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    connectionTimeoutMillis: Math.min(options.connectionTimeoutMs, 1000),
    // Retain established sessions while source copies occupy the filesystem
    // thread pool also used by SCRAM authentication on new connections.
    min: Math.min(options.maxConnections, 4),
    idleTimeoutMillis: 60_000,
    // The server owns the SQL deadline. Its reply (including durable commit
    // acknowledgment) needs bounded delivery time before the client gives up.
    query_timeout: Math.min(queryTimeoutMs + 1000, 2_147_483_647),
    statement_timeout: queryTimeoutMs,
    lock_timeout: options.lockTimeoutMs,
    application_name: applicationName,
  })
  pool.on('error', options.onError ?? ((error: Error) => {
    componentLogger('db').error({ err: error, pool: applicationName }, 'idle PostgreSQL connection failed')
  }))
  return pool
}

/**
 * Destroy an aborted/failed probe's connection rather than returning a still-busy
 * client to the pool. Acquisition is bounded by connectionTimeoutMillis. If an
 * abort happens while acquiring, wait for that lease and immediately discard it;
 * the HTTP probe coalesces callers until this cleanup finishes.
 */
export async function queryForReadiness(
  pool: pg.Pool,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const client = await pool.connect()
  const connection = (client as pg.PoolClient & {
    connection?: { stream?: { destroy(): void } }
  }).connection
  const processId = (client as pg.PoolClient & { processID?: number }).processID
  let failed = false
  let released = false
  let cancellation: Promise<void> | undefined
  const release = (destroy: boolean) => {
    if (released) return
    released = true
    client.release(destroy)
  }
  const onError = () => { failed = true }
  const onAbort = () => {
    failed = true
    if (cancellation || released) return
    if (!processId) {
      connection?.stream?.destroy()
      release(true)
      return
    }
    cancellation = cancelBackendQuery(pool.options, processId).catch(() => {
      // If the cancel connection cannot be established, force-close the
      // leased socket as a final local cleanup fallback.
      connection?.stream?.destroy()
    })
  }
  client.on('error', onError)
  try {
    signal?.throwIfAborted()
    signal?.addEventListener('abort', onAbort, { once: true })
    await client.query(text)
    signal?.throwIfAborted()
  } catch (error) {
    failed = true
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    client.removeListener('error', onError)
    if (cancellation) await cancellation
    release(failed)
  }
}

export async function cancelBackendQuery(options: pg.PoolConfig, processId: number): Promise<void> {
  const client = new pg.Client(options)
  try {
    await client.connect()
    await client.query('select pg_cancel_backend($1)', [processId])
  } finally {
    await client.end().catch(ignoreError('db', 'close cancellation client', { processId }))
  }
}
