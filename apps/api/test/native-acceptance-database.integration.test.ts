import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'

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

it('disposes only its owned database with leaked callers while retaining work failure', async () => {
  const script = new URL('../../../scripts/test-native-acceptance.mjs', import.meta.url).href
  const { withNativeAcceptanceDatabase } = await import(script)
  const configured = process.env.TEST_DATABASE_URL
  if (!configured) throw new Error('TEST_DATABASE_URL is required')
  const server = new URL(configured)
  server.pathname = '/postgres'
  const admin = new pg.Pool({ connectionString: server.toString(), max: 1 })
  const directory = await mkdtemp(join(tmpdir(), 'native-bootstrap-cleanup-'))
  try {
    for (const failed of [false, true]) {
      let ownedName = ''
      let client: pg.Client | undefined
      const disconnects: unknown[] = []
      const failure = new Error('Native verification failed')
      const work = withNativeAcceptanceDatabase(configured, directory,
        async ({ databaseUrl }: { databaseUrl: string }) => {
          ownedName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
          client = new pg.Client({ connectionString: databaseUrl })
          client.on('error', error => { disconnects.push(error) })
          await client.connect()
          await client.query('select 1')
          if (failed) throw failure
          return 0
        })
      try {
        if (failed) await expect(work).rejects.toBe(failure)
        else await expect(work).resolves.toMatchObject({ removed: true, exitCode: 1 })
        expect(ownedName).not.toBe(decodeURIComponent(new URL(configured).pathname.slice(1)))
        expect((await admin.query('select 1 from pg_database where datname=$1', [ownedName])).rowCount).toBe(0)
        await expect(client!.query('select 1')).rejects.toThrow()
        expect(disconnects.length).toBeGreaterThan(0)
      } finally { await client?.end() }
    }
    expect((await admin.query('select 1 from pg_database where datname=$1',
      [decodeURIComponent(new URL(configured).pathname.slice(1))])).rowCount).toBe(1)
  } finally {
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
