import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

/** A fresh database and directory for this workstream only. Neither the admin
 * database nor an existing application database is migrated or cleaned. */
export async function nim2691TaskDatabase<T>(work: (pool: pg.Pool, directory: string, connectionString: string) => Promise<T>): Promise<T> {
  assert.equal(process.env.NIM2691_POSTGRES, '1')
  const configured = process.env.NIM2691_ADMIN_DATABASE_URL
  assert.ok(configured, 'NIM2691_ADMIN_DATABASE_URL is required')
  const url = new URL(configured)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  const name = `nim2691_${randomBytes(12).toString('hex')}`
  const admin = new pg.Client({ connectionString: configured, connectionTimeoutMillis: 10000 })
  let pool: pg.Pool | undefined
  let directory: string | undefined
  let created = false
  try {
    await admin.connect()
    assert.equal((await admin.query<{ server_version_num: string }>('show server_version_num')).rows[0]?.server_version_num.startsWith('17'), true)
    await admin.query(`create database "${name}" template template0 encoding 'UTF8'`)
    created = true
    url.pathname = `/${name}`
    pool = new pg.Pool({ connectionString: url.toString(), max: 5 })
    directory = await mkdtemp(join(tmpdir(), 'nim2691-workspace-'))
    assert.equal((await pool.query<{ name: string }>('select current_database() as name')).rows[0]?.name, name)
    return await work(pool, directory, url.toString())
  } finally {
    try { if (pool) await pool.end() }
    finally {
      try { if (created) await admin.query(`drop database "${name}"`) }
      finally {
        await admin.end()
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    }
  }
}
