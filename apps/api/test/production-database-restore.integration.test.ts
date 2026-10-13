import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { expect, it } from 'vitest'
import { createTestPool } from './helpers/testPool.mjs'
import { createFixtureDatabase, dropFixtureDatabase, ownedTestDatabaseUrl } from './helpers/testResources.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

it.skipIf(!postgresEnabled)('restores application data and checkpoint schema after a committed migration failure', async () => {
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { backupDatabase, restoreDatabase } = await import(script)
  const url = new URL(ownedTestDatabaseUrl())
  const name = `graphql_fixture_${randomUUID().replaceAll('-', '')}`
  const admin = createTestPool({ connectionString: url.toString(), max: 1 })
  const directory = await privateFixtureDirectory('database-restore-')
  const archive = join(directory, 'database.dump')
  const environment = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) }
  let pool: ReturnType<typeof createTestPool> | undefined
  let nativeTools = true
  try {
    await access('/usr/lib/postgresql/17/bin/pg_dump')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    nativeTools = false
  }
  const run = (tool: string, args: string[], options: SpawnOptions) => new Promise<void>((resolve, reject) => {
    const command = nativeTools ? `/usr/lib/postgresql/17/bin/${tool}` : 'docker'
    const arguments_ = nativeTools ? args : ['run', '--rm', '-i', '--network', 'host',
      ...['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD'].flatMap(key => ['-e', key]), 'postgres:17-alpine', tool, ...args]
    const child = spawn(command, arguments_, { ...options, env: environment })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${tool} failed (${code})`)))
  })
  try {
    await createFixtureDatabase(admin, name)
    url.pathname = `/${name}`
    pool = createTestPool({ connectionString: url.toString(), max: 1 })
    await pool.query('create table saved_facts(id text primary key, value text not null)')
    await pool.query("insert into saved_facts values('original', 'saved version and run')")
    await pool.query('create schema checkpoints')
    await pool.query('create table checkpoints.saved(id text primary key)')
    await pool.query("insert into checkpoints.saved values('original checkpoint')")
    await backupDatabase({ archive, database: name, run })
    await pool.query('alter table saved_facts add column migrated boolean')
    await pool.query("update saved_facts set value='changed by migration'")
    await pool.query('create table checkpoints.partial_setup(id text primary key)')
    await pool.query('create schema migration_added')
    await pool.end()
    pool = undefined
    await restoreDatabase({ archive, run })
    pool = createTestPool({ connectionString: url.toString(), max: 1 })
    expect((await pool.query('select * from saved_facts')).rows)
      .toEqual([{ id: 'original', value: 'saved version and run' }])
    expect((await pool.query('select * from checkpoints.saved')).rows).toEqual([{ id: 'original checkpoint' }])
    expect((await pool.query("select to_regclass('checkpoints.partial_setup') as partial")).rows).toEqual([{ partial: null }])
    expect((await pool.query("select schema_name from information_schema.schemata where schema_name='migration_added'")).rows)
      .toEqual([])
  } finally {
    await pool?.end()
    try { await dropFixtureDatabase(admin, name) } finally { await admin.end() }
  }
}, 120_000)
