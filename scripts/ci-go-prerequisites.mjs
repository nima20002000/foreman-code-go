import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { writeJsonReport } from './ci-report-io.mjs'

// PostgreSQL 17.6 was released 2025-08-14. The image is a version tag, not an immutable digest.
const postgresImage = 'postgres:17.6-alpine'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = fileURLToPath(import.meta.url)
const databaseProfiles = {
  go: { name: 'go', user: 'foreman_ci', database: 'foreman_test', urlDatabase: 'foreman_test' },
  scripts: { name: 'scripts', user: 'graphql_test_admin', database: 'graphql_test_control', urlDatabase: 'postgres',
    password: 'graphql_test_disposable_only' },
}

function command(program, args, environment = process.env, input) {
  const result = spawnSync(program, args, { encoding: 'utf8', env: environment, input, timeout: 120_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${program} ${args[0]} failed`)
  return result.stdout.trim()
}

function nativeInputs() {
  if (process.env.CGO_ENABLED === '0') throw new Error('Go image codecs require CGO_ENABLED=1')
  try {
    return [command(process.env.CC || 'cc', ['--version']),
      command('pkg-config', ['--modversion', 'vips']), command('pkg-config', ['--cflags', 'vips'])]
  } catch (error) {
    throw new Error('Go CI requires a C compiler, pkg-config and libvips development files. '
      + 'Prepare the approved build image with build-essential, pkg-config and libvips-dev; '
      + 'CI does not install system packages on build computers.', { cause: error })
  }
}

function cacheKey() {
  const hash = createHash('sha256')
  for (const path of ['scripts/ci-go-versions.json', 'backend/go.mod', 'backend/go.sum']) {
    const file = join(repository, path)
    hash.update(`${path}\0`)
    hash.update(existsSync(file) ? readFileSync(file) : '<absent>')
    hash.update('\0')
  }
  for (const input of [process.platform, process.arch, ...nativeInputs()]) hash.update(`${input}\0`)
  return hash.digest('hex')
}

function databasePaths(profile) {
  if (!process.env.CI_STATE) throw new Error('CI_STATE must identify this run before preparing PostgreSQL')
  const state = resolve(process.env.CI_STATE)
  return { state, record: join(state, `${profile.name}-database.json`),
    cancelled: join(state, `${profile.name}-database-stop`), lock: join(state, `${profile.name}-database-cleanup.lock`) }
}

function databaseRecord(paths, profile) {
  const record = JSON.parse(readFileSync(paths.record, 'utf8'))
  if (!/^[0-9a-f-]{36}$/.test(record.owner) || record.name !== `foreman-${profile.name}-ci-${record.owner}`
    || record.profile !== profile.name || profile.name === 'scripts' && !/^[0-9a-f-]{36}$/.test(record.hostRunId)) {
    throw new Error('The PostgreSQL state does not identify this disposable CI container')
  }
  return record
}

function inspectDatabase(record, profile) {
  const result = spawnSync('docker', ['inspect', record.name], { encoding: 'utf8', timeout: 10_000 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (/No such (object|container)/i.test(result.stderr)) return undefined
    throw new Error(result.stderr.trim() || 'Unable to inspect the CI PostgreSQL container')
  }
  const [container] = JSON.parse(result.stdout)
  if (container.Config?.Labels?.[`foreman-code.${profile.name}-ci-database`] !== record.owner) {
    throw new Error('Refusing to use or remove a PostgreSQL container owned by another run')
  }
  return container
}

function removeDatabase(record, profile) {
  const container = inspectDatabase(record, profile)
  if (!container) return
  const result = spawnSync('docker', ['rm', '--force', '--volumes', container.Id],
    { encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0 && !/No such container/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || 'Unable to remove the CI PostgreSQL container')
  }
}

function removeDatabaseState(profile, finished) {
  const paths = databasePaths(profile)
  // Called only inside flock. Read again after acquiring it so concurrent cleanups cannot both remove a container.
  if (!existsSync(paths.record)) return
  let record
  try { record = databaseRecord(paths, profile) }
  catch (error) {
    if (error.code === 'ENOENT') return // A concurrent cleanup already removed this run's record.
    throw error
  }
  removeDatabase(record, profile)
  // A pending docker run may still create the container. Its starter retains the record until it reconciles that RPC.
  if (record.ready || finished) rmSync(paths.record, { force: true })
}

function reconcileDatabase(profile, finished = false) {
  const paths = databasePaths(profile)
  if (!existsSync(paths.record)) return
  command('flock', ['--exclusive', '--wait', '60', paths.lock,
    process.execPath, script, 'database-remove', profile.name, finished ? 'finished' : 'pending'])
}

function cancelDatabase(profile) {
  const paths = databasePaths(profile)
  // Write before taking the cleanup lock so a blocked starter can observe cancellation promptly.
  mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  writeFileSync(paths.cancelled, '', { mode: 0o600 })
}

function stopDatabase(profile) {
  cancelDatabase(profile)
  reconcileDatabase(profile)
}

function stopDatabases() {
  const errors = []
  // The host and provider fallback mark every pending starter before waiting for either cleanup lock.
  for (const operation of [cancelDatabase, reconcileDatabase]) {
    for (const profile of Object.values(databaseProfiles)) {
      try { operation(profile) }
      catch (error) { errors.push(error) }
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'CI PostgreSQL cleanup failed')
}

async function waitForDatabase(record, paths, profile) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (existsSync(paths.cancelled)) throw new Error('CI PostgreSQL startup was cancelled')
    const container = inspectDatabase(record, profile)
    if (!container || !container.State.Running) throw new Error('CI PostgreSQL exited before becoming ready')
    if (container.State.Health?.Status === 'healthy') return container
    if (container.State.Health?.Status === 'unhealthy') throw new Error('CI PostgreSQL failed its readiness check')
    await delay(500)
  }
  throw new Error('CI PostgreSQL did not become ready within 90 seconds')
}

function databaseUrl(record, container, profile) {
  const bindings = container.NetworkSettings?.Ports?.['5432/tcp'] ?? []
  const binding = bindings.find(value => value.HostIp === '127.0.0.1')
  if (!binding || !/^[1-9][0-9]*$/.test(binding.HostPort) || bindings.length !== 1) {
    throw new Error('CI PostgreSQL must publish one random port on loopback only')
  }
  return `postgresql://${profile.user}:${record.password}@127.0.0.1:${binding.HostPort}/${profile.urlDatabase}`
}

function databaseLimits() {
  const args = []
  for (const [variable, option] of [
    ['FOREMAN_CODE_CI_DATABASE_CPUS', '--cpus'], ['FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES', '--memory'],
  ]) {
    const value = process.env[variable]
    if (value === undefined || value === '') continue
    const limit = Number(value)
    if (!Number.isFinite(limit) || limit < 0 || option === '--memory' && !Number.isSafeInteger(limit)) {
      throw new Error(`${variable} must be a nonnegative resource limit`)
    }
    if (limit > 0) args.push(option, String(limit))
  }
  return args
}

function initializeScriptDatabase(record, profile) {
  if (profile.name !== 'scripts') return
  command('docker', ['exec', '--interactive', '--env', 'PGPASSWORD', record.name,
    'psql', '-h', '127.0.0.1', '-U', profile.user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
  { ...process.env, PGPASSWORD: record.password }, readFileSync(join(repository, 'scripts/test-postgres-init.sql'), 'utf8'))
}

function databaseHostRunId(profile, owner) {
  if (profile.name !== 'scripts') return undefined
  const value = process.env.FOREMAN_CODE_CI_HOST_RUN_ID || owner
  if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error('Invalid host CI disposable database owner')
  return value
}

async function startDatabase(profile) {
  const paths = databasePaths(profile)
  mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  if (existsSync(paths.record) || existsSync(paths.cancelled)) {
    throw new Error('CI_STATE already contains PostgreSQL state; use a fresh directory for this run')
  }
  try { command('flock', ['--version']) }
  catch (error) { throw new Error('CI PostgreSQL requires existing flock for serialized container cleanup.', { cause: error }) }
  const limits = databaseLimits()
  const owner = randomUUID()
  const record = { owner, profile: profile.name, name: `foreman-${profile.name}-ci-${owner}`,
    password: profile.password ?? randomBytes(24).toString('hex'),
    hostRunId: databaseHostRunId(profile, owner), ready: false }
  writeFileSync(paths.record, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  const environment = { ...process.env, POSTGRES_USER: profile.user, POSTGRES_DB: profile.database,
    POSTGRES_PASSWORD: record.password }
  try {
    command('docker', ['run', '--detach', '--rm', ...limits, '--name', record.name,
      '--label', `foreman-code.${profile.name}-ci-database=${owner}`, '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--env', 'POSTGRES_PASSWORD',
      '--health-cmd', `pg_isready -h 127.0.0.1 -U ${profile.user} -d ${profile.database}`,
      '--health-interval', '1s', '--health-timeout', '3s', '--health-retries', '60',
      postgresImage, 'postgres', '-c', 'max_connections=300', '-c', 'max_locks_per_transaction=512'], environment)
    const container = await waitForDatabase(record, paths, profile)
    initializeScriptDatabase(record, profile)
    record.url = databaseUrl(record, container, profile)
    record.ready = true
    writeJsonReport(paths.record, record)
    if (existsSync(paths.cancelled)) throw new Error('CI PostgreSQL startup was cancelled')
    process.stdout.write(`[ci-setup] Fresh ${profile.name} PostgreSQL is ready on an isolated loopback port\n`)
  } catch (error) {
    try { reconcileDatabase(profile, true) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PostgreSQL startup and cleanup failed') }
    throw error
  }
}

function databaseEnvironment(profile) {
  const paths = databasePaths(profile)
  const record = databaseRecord(paths, profile)
  if (!record.ready || existsSync(paths.cancelled)) throw new Error('The CI PostgreSQL server is not ready')
  const container = inspectDatabase(record, profile)
  if (!container?.State.Running) throw new Error('The CI PostgreSQL server is no longer running')
  const url = databaseUrl(record, container, profile)
  // This is generated disposable state, never an inherited application DATABASE_URL.
  const quoted = `'${url.replaceAll("'", "'\\''")}'`
  process.stdout.write('unset DATABASE_URL TEST_DATABASE_URL FOREMAN_CODE_DATABASE_URL FOREMAN_CODE_TEST_DATABASE_URL '
    + 'GRAPHQL_DATABASE_URL GRAPHQL_TEST_DATABASE_URL GRAPHQL_CI_TEST_ADMIN_URL GRAPHQL_CI_HOST_RUN_ID\n')
  const postgresVariables = Object.keys(process.env).filter(name => /^PG[A-Z_0-9]*$/.test(name))
  if (postgresVariables.length) process.stdout.write(`unset ${postgresVariables.join(' ')}\n`)
  if (profile.name === 'scripts') {
    process.stdout.write(`export FOREMAN_CODE_CI_HOST_RUN_ID='${record.hostRunId}'\n`)
    process.stdout.write(`export FOREMAN_CODE_CI_TEST_ADMIN_URL=${quoted}\n`)
    return
  }
  for (const variable of ['DATABASE_URL', 'TEST_DATABASE_URL', 'FOREMAN_CODE_CI_TEST_ADMIN_URL']) {
    process.stdout.write(`export ${variable}=${quoted}\n`)
  }
}

async function main() {
  switch (process.argv[2]) {
    case 'native':
      nativeInputs()
      process.stdout.write('[ci-setup] C compiler, pkg-config and libvips are available\n')
      return
    case 'cache-key': process.stdout.write(`${cacheKey()}\n`); return
    case 'database-start': await startDatabase(databaseProfiles.go); return
    case 'database-env': databaseEnvironment(databaseProfiles.go); return
    case 'database-stop': stopDatabase(databaseProfiles.go); return
    case 'scripts-database-start': await startDatabase(databaseProfiles.scripts); return
    case 'scripts-database-env': databaseEnvironment(databaseProfiles.scripts); return
    case 'scripts-database-stop': stopDatabase(databaseProfiles.scripts); return
    case 'databases-stop': stopDatabases(); return
    case 'database-remove': {
      const profile = databaseProfiles[process.argv[3]]
      if (!['go', 'scripts'].includes(process.argv[3]) || !['finished', 'pending'].includes(process.argv[4])) {
        throw new Error('Invalid PostgreSQL cleanup request')
      }
      removeDatabaseState(profile, process.argv[4] === 'finished')
      return
    }
    default: throw new Error('Usage: ci-go-prerequisites.mjs native|cache-key|[scripts-]database-start|[scripts-]database-env|[scripts-]database-stop|databases-stop')
  }
}

try { await main() }
catch (error) {
  console.error(error)
  process.exitCode = 1
}
