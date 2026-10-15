import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import pg from 'pg'
import { provisionTestResources } from '../../../scripts/test-resources.mjs'
import { stopGroup } from '../../../scripts/integration-process.mjs'
import { readUntil } from './helpers/observableCondition.js'
import { freePort, ready, require, root } from './helpers/testStartupIsolation.js'

it('keeps the API ready after PostgreSQL terminates idle application and checkpoint pool connections', async () => {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), join(root, 'apps/api/src/server.ts')], {
    cwd: root, env: { ...resources.environment, HOST: '127.0.0.1', PORT: String(port) },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const observeOutput = (chunk: Buffer) => {
    output += chunk.toString()
    process.stdout.write(chunk)
  }
  child.stdout?.on('data', observeOutput)
  child.stderr?.on('data', observeOutput)
  const admin = new pg.Pool({ connectionString: resources.environment.TEST_DATABASE_URL, max: 1 })
  try {
    try {
      await ready(child, port)
    } catch (error) {
      throw new Error(`API startup failed:\n${output}`, { cause: error })
    }
    for (const application of ['graphql-api', 'graphql-checkpoints']) {
      const backend = await readUntil(async () => {
        const result = await admin.query<{ pid: number }>(`select pid from pg_stat_activity
          where datname=current_database() and application_name=$1 and state='idle' limit 1`, [application])
        return result.rows[0]
      }, value => value !== undefined, { timeoutMs: 5_000, description: `an idle ${application} connection` })
      expect((await admin.query('select pg_terminate_backend($1) as terminated', [backend!.pid]))
        .rows[0].terminated).toBe(true)
      await readUntil(async () => output, value => value.includes('idle PostgreSQL connection failed')
        && value.includes(`"pool":"${application}"`),
      { timeoutMs: 5_000, description: `the handled ${application} connection loss` })
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(5_000) })
      expect(response.status).toBe(200)
    }
    expect(output).not.toContain('api stopped')
  } finally {
    await stopGroup(child.pid, { signal: 'SIGTERM' })
    await admin.end()
    await resources.close()
  }
}, 120_000)
