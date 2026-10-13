import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ciPostgresCacheDirectory } from './ci-postgres-cache.mjs'

const action = process.argv[2]
if (!['up', 'down', 'stop'].includes(action)) throw new Error('Usage: test-db.mjs up|down|stop')
function reusePrivateDatabase() {
  if (action !== 'up') throw new Error('The verification runtime owns private PostgreSQL shutdown')
  if (process.env.FOREMAN_CODE_CI_TEST_DATABASE !== 'running') {
    throw new Error('The verification runtime must start its private PostgreSQL before database startup')
  }
  const result = spawnSync('/usr/lib/postgresql/17/bin/psql', [
    '-h', '127.0.0.1', '-p', '55439', '-U', 'graphql_test_admin', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-Atqc',
    "select current_setting('data_directory'), shobj_description(oid, 'pg_database')"
      + " from pg_database where datname in ('postgres', 'graphql_test_control') order by datname",
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8', PGPASSWORD: 'graphql_test_disposable_only' } })
  if (result.error) throw result.error
  const expected = '/job-scratch/postgres/data|graphql-disposable-test-server'
  if (result.status !== 0 || result.stdout.trim() !== `${expected}\n${expected}`) {
    throw new Error('Private PostgreSQL test server ownership verification failed')
  }
  process.stdout.write('Reusing the runtime-owned private PostgreSQL test server\n')
}

function composeDatabase(persistentCache) {
  const runId = process.env.FOREMAN_CODE_CI_HOST_RUN_ID
  if (runId !== undefined && !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid host CI database owner')
  const cacheKey = persistentCache && createHash('sha256').update(persistentCache).digest('hex').slice(0, 16)
  const project = cacheKey ? `foreman-ci-pg-${cacheKey}` : runId ? `foreman-ci-${runId}` : 'graphql-tests'
  const file = fileURLToPath(new URL('../compose.test.yaml', import.meta.url))
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith('COMPOSE_')) delete environment[key]
  if (runId) environment.FOREMAN_CODE_CI_DATABASE_PORT = '0'
  function docker(args, input) {
    const result = spawnSync('docker', args, { encoding: 'utf8', env: environment, input })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || `docker ${args[0]} failed`)
    return result.stdout.trim()
  }
  const containers = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).split('\n').filter(Boolean)
  let running = false
  for (const container of containers) {
    const [record] = JSON.parse(docker(['inspect', container]))
    if (record.Config.Labels['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Refusing to modify a container without the disposable test ownership label')
    }
    if (record.Config.Labels['com.docker.compose.service'] === 'postgres' && record.State.Running) running = true
  }
  const volume = `${project}_graphql-test-data`
  if (docker(['volume', 'ls', '-q']).split('\n').includes(volume)) {
    const [record] = JSON.parse(docker(['volume', 'inspect', volume]))
    if (record.Labels?.['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Refusing to modify a volume without the disposable test ownership label')
    }
  }
  const args = ['compose', '--project-name', project, '--file', file]
  // Snapshot checkouts have different bind-mount paths; replacing this shared server interrupts active tests.
  if (action === 'up') args.push('up', '-d', '--wait', persistentCache || running ? '--no-recreate' : '--force-recreate', 'postgres')
  else if (action === 'stop') args.push('stop', 'postgres')
  else args.push('down', '--volumes')
  process.stdout.write(`${docker(args)}\n`)
  if (action === 'up') {
    // Private checkouts are unreadable to the container user, so the idempotent init SQL goes through stdin.
    docker(['compose', '--project-name', project, '--file', file, 'exec', '-T', '-e', 'PGPASSWORD=graphql_test_disposable_only',
      'postgres', 'psql', '-h', '127.0.0.1', '-U', 'graphql_test_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
    readFileSync(fileURLToPath(new URL('./test-postgres-init.sql', import.meta.url)), 'utf8'))
  }
  if (runId && action === 'up') {
    if (!environment.TMPDIR) throw new Error('Host CI database requires its private run directory')
    const binding = docker(['compose', '--project-name', project, '--file', file, 'port', 'postgres', '5432'])
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1]
    if (!port) throw new Error('Host CI database has no private loopback port')
    writeFileSync(join(environment.TMPDIR, 'test-database-url'),
      `postgresql://graphql_test_admin:graphql_test_disposable_only@127.0.0.1:${port}/postgres`, { mode: 0o600 })
    if (persistentCache) {
      writeFileSync(join(environment.TMPDIR, 'test-database-template-cache'), persistentCache, { mode: 0o600 })
    }
  }
}

function hostDatabase() {
  const cache = ciPostgresCacheDirectory()
  const marker = process.env.TMPDIR && join(process.env.TMPDIR, 'test-database-template-cache')
  if (action !== 'up' && marker && existsSync(marker)) {
    process.stdout.write('Retaining the CI PostgreSQL server; job databases are cleaned by their owners\n')
    return
  }
  if (action === 'up' && marker) rmSync(marker, { force: true })
  if (!cache || action !== 'up') return composeDatabase()
  try {
    mkdirSync(cache, { recursive: true, mode: 0o700 })
    const directory = realpathSync(cache)
    if (process.env.FOREMAN_CODE_CI_POSTGRES_LOCKED === '1') return composeDatabase(directory)
    // Different jobs can reach a cold computer together; only one starts the shared server.
    const result = spawnSync('flock', ['-w', '90', join(directory, 'startup.lock'),
      process.execPath, fileURLToPath(import.meta.url), action], {
      env: { ...process.env, FOREMAN_CODE_CI_POSTGRES_LOCKED: '1' }, encoding: 'utf8',
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || 'Persistent PostgreSQL startup failed')
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
  } catch (error) {
    process.stderr.write(`[test-db] persistent server unavailable; using job server: ${error.message}\n`)
    composeDatabase()
  }
}

const started = performance.now()
if (process.env.FOREMAN_CODE_VERIFICATION_ENVIRONMENT === 'isolated-job-v1') reusePrivateDatabase()
else hostDatabase()
process.stdout.write(`[test-db] ${action} completed in ${Math.round(performance.now() - started)} ms\n`)
