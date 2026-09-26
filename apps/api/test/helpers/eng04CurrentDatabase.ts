import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'

export const postgresEnabled = process.env.RUN_WAVE25_POSTGRES_TESTS === '1'
/** The existing disposable loopback test gate, without importing retired
 * execution seeders. No DATABASE_URL fallback or live/shared data cleanup. */
export async function currentDatabase() {
  const url = process.env.WAVE25_TEST_DATABASE_URL
  if (!url) throw new Error('WAVE25_TEST_DATABASE_URL is required when RUN_WAVE25_POSTGRES_TESTS=1')
  const parsed = new URL(url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  const schema = `eng04_b_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: url, max: 1 })
  await admin.query(`create schema ${schema}`)
  const pool = new pg.Pool({ connectionString: url, max: 10,
    options: `-c search_path=${schema},public -c statement_timeout=10000 -c lock_timeout=5000` })
  const directory = await mkdtemp(join(tmpdir(), 'eng04-b-'))
  try { await applyApplicationMigrations(pool) } catch (error) {
    await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end()
    await rm(directory, { recursive: true, force: true }); throw error
  }
  return { pool, schema, directory, async close() {
    await pool.end()
    try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() }
    await rm(directory, { recursive: true, force: true })
  } }
}
