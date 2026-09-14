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
  let released = false
  let failed = false
  const onError = () => { failed = true }
  const onAbort = () => {
    failed = true
    if (!released) {
      released = true
      client.release(true)
    }
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
    if (!released) client.release(failed)
  }
}
