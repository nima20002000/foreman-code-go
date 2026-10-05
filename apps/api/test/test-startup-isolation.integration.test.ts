import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import pg from 'pg'
import { createTestRoot, provisionTestResources, removeTestRoot } from '../../../scripts/test-resources.mjs'
import { stopGroup } from '../../../scripts/integration-process.mjs'
import { assertOwnedTestApi } from './helpers/testResources.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function ready(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Test API exited before readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch { /* Startup may not have opened the listener yet. */ }
    await delay(100)
  }
  throw new Error('Test API did not become ready')
}

it.each(['explicit env file', 'default .env'])('isolates real API startup from %s logs and authentication', async selector => {
  const resources = await provisionTestResources({ PATH: process.env.PATH })
  const state = resources.environment.FOREMAN_CODE_TEST_ROOT!
  const ambient = join(state, 'ambient-app')
  await mkdir(ambient, { mode: 0o700 })
  const log = join(ambient, 'api.log')
  const rotated = join(ambient, 'api.1.log')
  await writeFile(log, 'application log sentinel')
  await writeFile(rotated, 'application rotation sentinel')
  await utimes(rotated, new Date(0), new Date(0))
  const envFile = join(ambient, '.env')
  await writeFile(envFile, `LOG_FILE=${log}\nOPENAI_API_KEY=ambient-provider-sentinel\n`)
  const { testEnvironment } = await import('../../../scripts/test-resources.mjs')
  const environment = testEnvironment({ PATH: process.env.PATH,
    ...(selector === 'explicit env file' ? { FOREMAN_CODE_API_ENV_FILE: envFile } : {}) }, {
    directory: state, token: resources.environment.FOREMAN_CODE_TEST_OWNER!,
    name: new URL(resources.environment.TEST_DATABASE_URL!).pathname.slice(1),
    databaseUrl: resources.environment.TEST_DATABASE_URL!,
  })
  const observation = join(state, 'startup-environment.json')
  const observer = join(state, 'observe.mjs')
  await writeFile(observer, `import { renameSync, writeFileSync } from 'node:fs';
    setInterval(() => {
      writeFileSync(${JSON.stringify(observation + '.tmp')}, JSON.stringify({
        ambientKey: process.env.OPENAI_API_KEY === 'ambient-provider-sentinel',
        logFile: process.env.LOG_FILE ?? null
      }));
      renameSync(${JSON.stringify(observation + '.tmp')}, ${JSON.stringify(observation)});
    }, 20).unref();`)
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'),
    '--import', observer, join(root, 'apps/api/src/server.ts')], {
    cwd: ambient, env: { ...environment, HOST: '127.0.0.1', PORT: String(port) },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  try {
    await ready(child, port)
    const pool = new pg.Pool({ connectionString: environment.TEST_DATABASE_URL, max: 1 })
    try {
      const origin = new URL(`http://127.0.0.1:${port}`)
      await expect(assertOwnedTestApi(origin, pool)).rejects.toThrow('does not own the disposable test database')
      await assertOwnedTestApi(origin, pool, environment)
    }
    finally { await pool.end() }
    await delay(50)
    expect(JSON.parse(await readFile(observation, 'utf8'))).toEqual({ ambientKey: false, logFile: null })
    expect(await readFile(log, 'utf8')).toBe('application log sentinel')
    expect(await readFile(rotated, 'utf8')).toBe('application rotation sentinel')
    expect((await readdir(environment.LOG_DIR!)).length).toBeGreaterThan(0)
  } finally {
    await stopGroup(child.pid, { signal: 'SIGTERM' })
    await resources.close()
  }
}, 120_000)

it.each(['CODEX_HOME', 'FILE_STORAGE_ROOT', 'HARNESS_WORKSPACE_ROOT',
  'WORKSPACE_STORAGE_ROOT', 'FOREMAN_CODE_APP_MCP_DIRECTORY'])(
  'refuses prepared native acceptance when the real API uses an unowned %s', async variable => {
    const resources = await provisionTestResources({ PATH: process.env.PATH })
    const outside = createTestRoot()
    const sentinel = join(outside.directory, 'retained.txt')
    await writeFile(sentinel, 'outside application state')
    const port = await freePort()
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), join(root, 'apps/api/src/server.ts')], {
      cwd: root, env: { ...resources.environment, [variable]: outside.directory,
        HOST: '127.0.0.1', PORT: String(port) },
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.resume()
    child.stderr?.resume()
    const pool = new pg.Pool({ connectionString: resources.environment.TEST_DATABASE_URL, max: 1 })
    let restarted: ChildProcess | undefined
    try {
      const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(30_000) })
      expect(code).toBe(1)
      await expect(fetch(`http://127.0.0.1:${port}/health/ready`)).rejects.toThrow()
      expect((await pool.query("select count(*)::int as count from pg_tables where schemaname not in ('pg_catalog','information_schema')"))
        .rows[0].count).toBe(0)
      expect(await readFile(sentinel, 'utf8')).toBe('outside application state')
      await stopGroup(child.pid, { signal: 'SIGTERM' })
      restarted = spawn(process.execPath, ['--import', require.resolve('tsx'), join(root, 'apps/api/src/server.ts')], {
        cwd: root, env: { ...resources.environment, HOST: '127.0.0.1', PORT: String(port) },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      restarted.stdout?.resume()
      restarted.stderr?.resume()
      await ready(restarted, port)
      await assertOwnedTestApi(new URL(`http://127.0.0.1:${port}`), pool, resources.environment)
      expect((await pool.query('select count(*)::int as count from runs')).rows[0].count).toBe(0)
    } finally {
      await stopGroup(restarted?.pid, { signal: 'SIGTERM' })
      await stopGroup(child.pid, { signal: 'SIGTERM' })
      await pool.end()
      await resources.close()
      removeTestRoot(outside)
    }
  }, 120_000)

it('starts the local smoke API and web app and completes authenticated HTTP/MCP parity', async () => {
  const ports = [await freePort(), await freePort()]
  while (ports[0] === ports[1]) ports[1] = await freePort()
  const child = spawn(process.execPath, [join(root, 'scripts/acceptance/local.mjs'), '--smoke',
    '--api-port', String(ports[0]), '--web-port', String(ports[1])], {
    cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  try {
    const [code] = await once(child, 'exit')
    expect(code, output).toBe(0)
    expect(output).toContain('ENG07 ready:')
    expect(output).toContain('ENG07 parity passed:')
    expect(output).toContain('owned test database and task files removed')
  } finally { await stopGroup(child.pid, { signal: 'SIGTERM' }) }
}, 240_000)
