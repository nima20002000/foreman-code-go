import type pg from 'pg'

import { createPool, queryForReadiness, type DatabaseOptions } from './pool.js'

export type { DatabaseOptions } from './pool.js'

export interface Database {
  readonly pool: pg.Pool
  ping(signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = createPool(options, 'graphql-api')
  return {
    pool,
    async ping(signal) {
      await queryForReadiness(pool, 'select 1', signal)
    },
    async close() {
      await pool.end()
    },
  }
}
