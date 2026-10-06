import { execFile } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

const execute = promisify(execFile)

it('keeps an active database session and its rows when another checkout starts the shared test server', async () => {
  const fixture = await currentDatabase()
  const client = await fixture.pool.connect()
  try {
    await client.query('create table startup_survival (value text not null)')
    await client.query('insert into startup_survival values ($1)', ['retained test data'])
    const before = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    const scripts = join(fixture.directory, 'scripts')
    await mkdir(scripts, { mode: 0o700 })
    // A copied checkout changes Compose's absolute bind path while keeping the same owned server configuration.
    await copyFile(new URL('../../../compose.test.yaml', import.meta.url), join(fixture.directory, 'compose.test.yaml'))
    for (const name of ['test-db.mjs', 'test-postgres-init.sql']) {
      await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), join(scripts, name))
    }
    await execute(process.execPath, [join(scripts, 'test-db.mjs'), 'up'], {
      cwd: fixture.directory, timeout: 30_000,
    })
    expect((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid).toBe(before)
    expect((await client.query('select value from startup_survival')).rows)
      .toEqual([{ value: 'retained test data' }])
  } finally {
    client.release()
    await fixture.close()
  }
}, 60_000)
