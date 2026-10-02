import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = `native_output_${randomUUID().replaceAll('-', '')}`
const operation = 'remote.native-artifact.output'

/** SQL receipt guards only; this does not manufacture a native artifact or qualify a host. */
describe.skipIf(!databaseUrl)('original native artifact output receipt SQL guards', () => {
  let admin: pg.Pool, pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !/test/i.test(url.pathname)) throw new Error('Owned loopback TEST_DATABASE_URL required.')
    admin = new pg.Pool({ connectionString: databaseUrl })
    await admin.query(`create schema ${schema}`)
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    await applyApplicationMigrations(pool)
    await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
      values ('owner-a','SQL fixture','operator',$1,'[]',clock_timestamp()+interval '1 hour'),
             ('owner-b','SQL fixture','operator',$2,'[]',clock_timestamp()+interval '1 hour')`, ['a'.repeat(64), 'b'.repeat(64)])
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) { try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() } }
  })
  const insert = (principal: string, command: string, target: string, result: unknown, op = operation) => pool.query(`
    insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
    values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`, [principal, op, command, target, 'c'.repeat(64), JSON.stringify(result)])
  it('keeps one original slot across retries and principals, with distinct Main namespaces', async () => {
    const target = JSON.stringify(['main-a', 'execution', 'attempt', 'output'])
    await insert('owner-a', 'first', target, { fixture: 'original' })
    await Promise.all([insert('owner-a', 'retry', target, { fixture: 'changed' }), insert('owner-b', 'foreign', target, { fixture: 'foreign' })])
    const stored = await pool.query('select principal_id,result from management_command_receipts where operation=$1 and target_key=$2', [operation, target])
    expect(stored.rows).toEqual([{ principal_id: 'owner-a', result: { fixture: 'original' } }])
    expect((await insert('owner-a', 'other-main', JSON.stringify(['main-b', 'execution', 'attempt', 'output']), { fixture: 'other namespace' })).rowCount).toBe(1)
    expect((await pool.query('select count(*)::int as count from application_migrations where version=285205')).rows[0].count).toBe(1)
  })
  it('rejects mutation, deletion and retrofitting an ordinary receipt into a native output', async () => {
    const target = JSON.stringify(['main-a', 'execution', 'attempt', 'immutable'])
    await insert('owner-a', 'immutable', target, { fixture: 'original' })
    await expect(pool.query('update management_command_receipts set result=$1 where operation=$2 and target_key=$3', ['{}', operation, target])).rejects.toThrow('immutable')
    await expect(pool.query('delete from management_command_receipts where operation=$1 and target_key=$2', [operation, target])).rejects.toThrow('immutable')
    await insert('owner-a', 'ordinary', 'ordinary', { fixture: 'ordinary' }, 'fixture.ordinary')
    await expect(pool.query("update management_command_receipts set operation=$1 where operation='fixture.ordinary'", [operation])).rejects.toThrow('original command insertion')
    expect((await pool.query("update management_command_receipts set result='{}' where operation='fixture.ordinary'")).rowCount).toBe(1)
  })
})
