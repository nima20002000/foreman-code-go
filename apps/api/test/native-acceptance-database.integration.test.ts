import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { completeTestResourceCleanup, dropFixtureDatabase, ownedTestDatabaseUrl,
  registerTestResourceCleanup } from '../../../scripts/test-resources.mjs'

it('acceptance bootstrap supplies an isolated database and removes it after success and failure', async () => {
  const script = new URL('../../../scripts/test-native-acceptance.mjs', import.meta.url).href
  const { withNativeAcceptanceDatabase } = await import(script)
  const configured = process.env.TEST_DATABASE_URL
  if (!configured) throw new Error('TEST_DATABASE_URL is required')
  const server = new URL(configured)
  server.pathname = '/postgres'
  const admin = new pg.Pool({ connectionString: server.toString(), max: 1 })
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-'))
  const ownedNames = new Set<string>()
  try {
    for (const exitCode of [0, 1]) {
      const record = await withNativeAcceptanceDatabase(configured, directory,
        async ({ databaseUrl }: { databaseUrl: string }) => {
          expect(databaseUrl).not.toBe(configured)
          expect(new URL(databaseUrl).hostname).toBe(new URL(configured).hostname)
          expect(new URL(databaseUrl).pathname.endsWith('_test')).toBe(true)
          const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
          try {
            expect((await pool.query('select current_schema() as name')).rows[0].name).toBe('native_acceptance')
            await pool.query('create table retained_result (value text)')
            await pool.query('insert into retained_result values ($1)', ['native bootstrap'])
            expect((await pool.query('select value from retained_result')).rows).toEqual([{ value: 'native bootstrap' }])
            return exitCode
          } finally {
            await pool.end()
          }
        })
      expect(record).toMatchObject({ created: true, removed: true, exitCode })
      expect(record.name).toMatch(/^foreman_code_native_[a-f0-9]{32}_test$/)
      expect(ownedNames.has(record.name)).toBe(false)
      ownedNames.add(record.name)
      expect((await admin.query('select 1 from pg_database where datname=$1', [record.name])).rowCount).toBe(0)
      expect(JSON.parse(await readFile(join(directory, record.name, 'database.json'), 'utf8'))).toEqual(record)
      expect((await admin.query('select 1 from pg_database where datname=$1',
        [decodeURIComponent(new URL(configured).pathname.slice(1))])).rowCount).toBe(1)
    }
    await expect(withNativeAcceptanceDatabase('postgresql://graphql_production:invalid@127.0.0.1:55440/graphql_production',
      directory, async () => { throw new Error('Unowned callback must not run') })).rejects.toThrow('owned test database')
    await expect(withNativeAcceptanceDatabase(configured, directory, async () => {
      throw new Error('Native launch failed')
    })).rejects.toThrow('Native launch failed')
    for (const name of await readdir(directory)) {
      const record = JSON.parse(await readFile(join(directory, name, 'database.json'), 'utf8')) as {
        created: boolean; removed: boolean
      }
      expect(record).toMatchObject({ created: true, removed: true })
      expect((await admin.query('select 1 from pg_database where datname=$1', [name])).rowCount).toBe(0)
    }
  } finally {
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it('retains the native bootstrap database until registered cleanup is confirmed', async () => {
  const script = new URL('../../../scripts/test-native-acceptance.mjs', import.meta.url).href
  const { withNativeAcceptanceDatabase } = await import(script)
  const invocation = { directory: process.env.GRAPHQL_TEST_ROOT!, token: process.env.GRAPHQL_TEST_OWNER! }
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-retained-'))
  let cleanupId: string | undefined
  let databaseName: string | undefined
  const parent = new pg.Pool({ connectionString: ownedTestDatabaseUrl(), max: 1 })
  try {
    const record = await withNativeAcceptanceDatabase(process.env.TEST_DATABASE_URL, directory,
      async () => {
        cleanupId = registerTestResourceCleanup(invocation, { kind: 'native-qualification' })
        return 0
      })
    databaseName = record.name
    expect(record).toMatchObject({ created: true, removed: false, exitCode: 1 })
    expect((await parent.query('select 1 from pg_database where datname=$1', [record.name])).rowCount).toBe(1)
    completeTestResourceCleanup(invocation, cleanupId!)
    cleanupId = undefined
    const folder = join(invocation.directory, '.graphql-test-cleanup')
    for (const file of await readdir(folder)) {
      const pending = JSON.parse(await readFile(join(folder, file), 'utf8')) as {
        id: string; kind: string; name?: string
      }
      if (pending.kind === 'native-acceptance-database' && pending.name === record.name) {
        await dropFixtureDatabase(parent, record.name)
        completeTestResourceCleanup(invocation, pending.id)
        databaseName = undefined
      }
    }
    expect((await parent.query('select 1 from pg_database where datname=$1', [record.name])).rowCount).toBe(0)
  } finally {
    if (cleanupId) completeTestResourceCleanup(invocation, cleanupId)
    if (databaseName) await dropFixtureDatabase(parent, databaseName)
    await parent.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
