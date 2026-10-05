import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import pg from 'pg'
import { applyApplicationMigrations, migrations } from '../../src/infrastructure/migrations.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

export const postgresEnabled = Boolean(process.env.TEST_DATABASE_URL)
/** The existing disposable loopback test gate, without importing retired
 * execution seeders. No DATABASE_URL fallback or live/shared data cleanup. */
export async function currentDatabase(options: { beforeMigration?: number; databaseUrl?: string } = {}) {
  const url = options.databaseUrl ?? process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  const schema = `eng04_b_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  await admin.query(`create schema ${schema}`)
  const pool = new pg.Pool({ connectionString: url, max: 10,
    options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000` })
  const directory = await privateFixtureDirectory('eng04-b-')
  try {
    if (options.beforeMigration === undefined) {
      await applyApplicationMigrations(pool)
    } else {
      const index = migrations.findIndex((migration) => migration.version === options.beforeMigration)
      if (index < 0) throw new Error('The requested migration is not registered')
      const client = await pool.connect()
      try {
        await client.query('begin')
        for (const migration of migrations.slice(0, index)) {
          await client.query(migration.sql)
          await client.query('insert into application_migrations(version) values($1)', [migration.version])
        }
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }
  } catch (error) {
    await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end()
    await rm(directory, { recursive: true, force: true }); throw error
  }
  return { pool, schema, directory, async close() {
    await pool.end()
    try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() }
    await rm(directory, { recursive: true, force: true })
  } }
}
