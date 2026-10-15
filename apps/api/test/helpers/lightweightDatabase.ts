import { randomUUID } from 'node:crypto'
import { inject } from 'vitest'
import { applyApplicationMigrations, migrations } from '../../src/infrastructure/migrations.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { createTestPool } from './testPool.mjs'

declare module 'vitest' {
  export interface ProvidedContext {
    lightDatabaseDirectory: string
  }
}

/** Sequential fixtures share one embedded PostgreSQL session, each in its own schema. */
export async function lightweightDatabase(options: { beforeMigration?: number } = {}) {
  const directory = inject('lightDatabaseDirectory')
  if (!directory) throw new Error('Lightweight database tests require vitest.light.config.mjs')
  const schema = `light_${randomUUID().replaceAll('-', '')}`
  const pool = createTestPool({
    host: directory,
    port: 5432,
    user: 'postgres',
    database: 'template1',
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 5_000,
  })
  const close = async () => {
    try {
      await pool.query(`drop schema "${schema}" cascade`)
    } finally {
      await pool.end()
    }
  }
  try {
    await pool.query(`create schema "${schema}"`)
    await pool.query(`set search_path to "${schema}"`)
    await pool.query('set statement_timeout = 10000')
    if (options.beforeMigration === undefined) {
      await applyApplicationMigrations(pool)
    } else {
      const index = migrations.findIndex(migration => migration.version === options.beforeMigration)
      if (index < 0) throw new Error('The requested migration is not registered')
      await withTransaction(pool, async client => {
        for (const migration of migrations.slice(0, index)) {
          await client.query(migration.sql)
          await client.query('insert into application_migrations(version) values($1)', [migration.version])
        }
      })
    }
  } catch (error) {
    await close()
    throw error
  }
  return { pool, schema, close }
}
