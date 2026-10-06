import { stat } from 'node:fs/promises'
import pg from 'pg'
import { expect, it } from 'vitest'
import { workspaceMcpFixture } from './helpers/workspaceMcp.js'
import { closeTestResources } from './support/cleanup.js'

it('removes the owned schema and project directory after fixture setup fails', async () => {
  const failure = new Error('Fixture setup failed')
  let directory = ''
  let schema = ''
  await expect(workspaceMcpFixture({ async configure({ parentPath, pool }) {
    directory = parentPath
    schema = (await pool.query<{ name: string }>('select current_schema() as name')).rows[0]!.name
    throw failure
  } })).rejects.toBe(failure)
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  try {
    expect(directory).not.toBe('')
    expect(schema).not.toBe('')
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await admin.query('select 1 from pg_namespace where nspname=$1', [schema])).rowCount).toBe(0)
  } finally { await admin.end() }
}, 30_000)

it('removes the owned schema and project directory even when app closure fails', async () => {
  const failure = new Error('App closure failed')
  const f = await workspaceMcpFixture({ async configure({ app }) {
    app.addHook('onClose', async () => { throw failure })
  } })
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  let closed = false
  try {
    const schema = (await f.pool.query<{ name: string }>('select current_schema() as name')).rows[0]!.name
    const result: unknown = await f.close().then(() => undefined, error => error)
    closed = true
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(failure)
    await expect(stat(f.parentPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await admin.query('select 1 from pg_namespace where nspname=$1', [schema])).rowCount).toBe(0)
  } finally {
    await closeTestResources([
      ...(!closed ? [() => f.close()] : []),
      () => admin.end(),
    ])
  }
}, 30_000)
