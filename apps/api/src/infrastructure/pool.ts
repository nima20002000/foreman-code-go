import pg from 'pg'

export interface DatabaseOptions {
  connectionString: string
  maxConnections: number
  connectionTimeoutMs: number
  queryTimeoutMs?: number
  onError?: (error: Error) => void
}

/** Both application and checkpoint connections need the same failure policy. */
export function createPool(options: DatabaseOptions, applicationName: string): pg.Pool {
  const queryTimeoutMs = options.queryTimeoutMs ?? 1000
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    application_name: applicationName,
  })
  pool.on('error', options.onError ?? ((error: Error) => {
    console.error(`${applicationName}: idle PostgreSQL connection failed`, error)
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
  let cancellation: Promise<void> | undefined
  const onError = () => { failed = true }
  const onAbort = () => {
    failed = true
    if (!processId || cancellation) return
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
    client.release(failed)
  }
}

async function cancelBackendQuery(options: pg.PoolConfig, processId: number): Promise<void> {
  const client = new pg.Client(options)
  try {
    await client.connect()
    await client.query('select pg_cancel_backend($1)', [processId])
  } finally {
    await client.end().catch(() => undefined)
  }
}
