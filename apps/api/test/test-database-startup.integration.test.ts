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
    // The copied checkout must reuse the same server through either database provider.
    await copyFile(new URL('../../../compose.test.yaml', import.meta.url), join(fixture.directory, 'compose.test.yaml'))
    for (const name of ['test-db.mjs', 'test-postgres-init.sql']) {
      await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), join(scripts, name))
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await execute(process.execPath, [join(scripts, 'test-db.mjs'), 'up'], {
        cwd: fixture.directory, timeout: 30_000,
      })
    }
    expect((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid).toBe(before)
    expect((await client.query('select value from startup_survival')).rows)
      .toEqual([{ value: 'retained test data' }])
  } finally {
    client.release()
    await fixture.close()
  }
}, 60_000)

for (const action of ['stop', 'down']) {
  it(`refuses ${action} for PostgreSQL owned by the verification runtime`, async () => {
    await expect(execute(process.execPath, [new URL('../../../scripts/test-db.mjs', import.meta.url).pathname, action], {
      env: { ...process.env, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
        FOREMAN_CODE_CI_TEST_DATABASE: 'running', PATH: '/no-docker' }, timeout: 10_000,
    })).rejects.toMatchObject({ stderr: expect.stringContaining('runtime owns private PostgreSQL shutdown') })
  })
}

it('refuses private database startup without the runtime-owned running server', async () => {
  await expect(execute(process.execPath, [new URL('../../../scripts/test-db.mjs', import.meta.url).pathname, 'up'], {
    env: { ...process.env, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
      FOREMAN_CODE_CI_TEST_DATABASE: '', PATH: '/no-docker' }, timeout: 10_000,
  })).rejects.toMatchObject({ stderr: expect.stringContaining('must start its private PostgreSQL') })
})
