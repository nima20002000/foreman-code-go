import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildComputerPriorityMigration } from '../src/infrastructure/buildComputerPriorityMigration.js'
import { lightweightDatabase } from './helpers/lightweightDatabase.js'
import { migrations } from '../src/infrastructure/migrations.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

const mainA = '11111111-1111-4111-8111-111111111111'
const mainB = '22222222-2222-4222-8222-222222222222'

describe('build computer priority migration', () => {
  let database: Awaited<ReturnType<typeof lightweightDatabase>>
  beforeAll(async () => { database = await lightweightDatabase() })
  afterAll(async () => { await database?.close() })

  it('folds Primary/Backup into one priority order per Main and drops the role', async () => {
    const pool = database.pool
    const owner = (await pool.query<{ id: string }>('select id from management_principals limit 1')).rows[0]?.id
      ?? (await pool.query<{ id: string }>(`insert into management_principals (id,name,audience,token_hash,grants,expires_at)
        values ('migration-owner','Owner','operator','migration-owner-token','[]'::jsonb, now() + interval '1 day') returning id`)).rows[0]!.id
    // Recreate the pre-migration shape on the already-migrated schema.
    await pool.query(`alter table build_computer_preferences add column build_role text not null default 'primary'`)
    const rows = [
      ['a-primary-low', mainA, 10, 'primary'], ['a-backup-high', mainA, 100, 'backup'],
      ['a-primary-high', mainA, 60, 'primary'], ['b-primary', mainB, 30, 'primary'],
    ] as const
    for (const [key, mainId, priority, role] of rows) {
      await pool.query(`insert into build_computer_preferences (host_key,target,revision,build_enabled,build_priority,build_role,updated_by)
        values ($1,$2::jsonb,1,true,$3,$4,$5)`, [key, JSON.stringify({ hostRef: { kind: 'main', mainId } }), priority, role, owner])
    }
    await pool.query(buildComputerPriorityMigration.sql)
    const after = (await pool.query<{ host_key: string; build_priority: number; revision: string }>(
      'select host_key,build_priority,revision::text from build_computer_preferences order by host_key')).rows
    expect(Object.fromEntries(after.map(row => [row.host_key, row.build_priority]))).toEqual({
      // Main A keeps its old order: Primaries by priority, then the Backup.
      'a-primary-high': 100, 'a-primary-low': 99, 'a-backup-high': 98,
      // Main B had no Backup, so its priorities are untouched.
      'b-primary': 30,
    })
    expect(after.find(row => row.host_key === 'b-primary')?.revision).toBe('1')
    const columns = (await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='build_computer_preferences' and table_schema=current_schema()")).rows
    expect(columns.map(column => column.column_name)).not.toContain('build_role')
  })
})


it('applies every registered migration and preserves pg result types and transaction rollback', async () => {
  const database = await lightweightDatabase()
  try {
    const applied = await database.pool.query<{ version: number }>(
      'select version from application_migrations order by version',
    )
    expect(applied.rows.map(row => row.version))
      .toEqual(migrations.map(migration => migration.version).sort((a, b) => a - b))
    const value = { nested: ['kept', 1], enabled: true }
    const result = await database.pool.query(
      'select $1::jsonb as record, $2::text[] as names, $3::bigint as count, $4::bytea as bytes',
      [value, ['a', 'b'], '9007199254740993', Buffer.from([0, 255])],
    )
    expect(result.rows).toEqual([{
      record: value, names: ['a', 'b'], count: '9007199254740993', bytes: Buffer.from([0, 255]),
    }])
    await expect(withTransaction(database.pool, async client => {
      await client.query('insert into workspaces(id,record) values($1,$2::jsonb)', ['rolled-back', {}])
      throw new Error('cancel test write')
    })).rejects.toThrow('cancel test write')
    expect((await database.pool.query('select id from workspaces')).rows).toEqual([])
    expect(database.pool.options.max).toBe(1)
  } finally {
    await database.close()
  }
})
