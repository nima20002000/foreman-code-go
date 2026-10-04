import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { createFixtureDatabase, createFixtureSchema, dropFixtureDatabase, dropFixtureSchema } from './helpers/testResources.js'

it('rejects connections to the app PostgreSQL endpoint before connecting', async () => {
  const client = new pg.Client({ connectionString: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql' })
  await expect(client.connect()).rejects.toThrow('dedicated disposable test instance')
  await client.end()
})

it('requires database and schema markers for destructive cleanup and excludes public lookup', async () => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const schema = `isolation_${suffix}`
  const database = `isolation_test_${suffix}`
  const sentinel = `sentinel_${suffix}`
  let pool: pg.Pool | undefined
  let databaseCreated = false
  try {
    await createFixtureSchema(admin, schema)
    await admin.query(`create table public.${sentinel}(value text)`)
    await admin.query(`insert into public.${sentinel} values ('retained')`)
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${schema}` })
    await expect(pool.query(`select * from ${sentinel}`)).rejects.toMatchObject({ code: '42P01' })
    await admin.query(`comment on schema ${schema} is 'another-owner'`)
    await expect(dropFixtureSchema(admin, schema)).rejects.toThrow('ownership mismatch')
    expect((await admin.query(`select value from public.${sentinel}`)).rows).toEqual([{ value: 'retained' }])
    await admin.query(`comment on schema ${schema} is 'graphql-test:${process.env.GRAPHQL_TEST_OWNER}'`)
    await createFixtureDatabase(admin, database)
    databaseCreated = true
    await admin.query(`comment on database ${database} is 'another-owner'`)
    await expect(dropFixtureDatabase(admin, database)).rejects.toThrow('ownership mismatch')
    expect((await admin.query('select datname from pg_database where datname=$1', [database])).rows).toHaveLength(1)
    await admin.query(`comment on database ${database} is 'graphql-test:${process.env.GRAPHQL_TEST_OWNER}'`)
  } finally {
    await pool?.end()
    if (databaseCreated) await dropFixtureDatabase(admin, database)
    await dropFixtureSchema(admin, schema)
    await admin.query(`drop table if exists public.${sentinel}`)
    await admin.end()
  }
})

it('rejects a prepared acceptance API bound to a different database before starting work', async () => {
  const { default: Fastify } = await import('fastify')
  const { assertOwnedTestApi } = await import('./helpers/testResources.js')
  const schema = `api_isolation_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, max: 1 })
  let pool: pg.Pool | undefined
  const app = Fastify()
  app.get('/health/identity', () => ({ checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64),
    installationId: randomUUID() }))
  try {
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${schema}` })
    await pool.query('create table application_installation(singleton boolean, id uuid)')
    await pool.query('insert into application_installation values(true,$1)', [randomUUID()])
    const origin = new URL(await app.listen({ host: '127.0.0.1', port: 0 }))
    await expect(assertOwnedTestApi(origin, pool)).rejects.toThrow('does not own the disposable test database')
  } finally {
    await app.close()
    await pool?.end()
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
})
