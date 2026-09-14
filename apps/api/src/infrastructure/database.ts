import pg from 'pg'

export interface Database {
  readonly pool: pg.Pool
  ping(): Promise<void>
  close(): Promise<void>
}

export interface DatabaseOptions {
  connectionString: string
  maxConnections: number
  connectionTimeoutMs: number
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    application_name: 'graphql-api',
  })

  return {
    pool,
    async ping() {
      await pool.query('select 1')
    },
    async close() {
      await pool.end()
    },
  }
}
