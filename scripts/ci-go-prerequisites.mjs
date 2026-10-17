import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { writeJsonReport } from './ci-report-io.mjs'

// PostgreSQL 17.6 was released 2025-08-14. The image is a version tag, not an immutable digest.
const postgresImage = 'postgres:17.6-alpine'
const ownerLabel = 'foreman-code.go-ci-database'
const databaseUser = 'foreman_ci'
const databaseName = 'foreman_test'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function command(program, args, environment = process.env) {
  const result = spawnSync(program, args, { encoding: 'utf8', env: environment, timeout: 120_000 })
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

function databasePaths() {
  if (!process.env.CI_STATE) throw new Error('CI_STATE must identify this run before preparing PostgreSQL')
  const state = resolve(process.env.CI_STATE)
  return { state, record: join(state, 'go-database.json'), cancelled: join(state, 'go-database-stop') }
}

function databaseRecord(paths) {
  const record = JSON.parse(readFileSync(paths.record, 'utf8'))
  if (!/^[0-9a-f-]{36}$/.test(record.owner) || record.name !== `foreman-go-ci-${record.owner}`) {
    throw new Error('The PostgreSQL state does not identify a disposable Go CI container')
  }
  return record
}

function inspectDatabase(record) {
  const result = spawnSync('docker', ['inspect', record.name], { encoding: 'utf8', timeout: 10_000 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (/No such (object|container)/i.test(result.stderr)) return undefined
    throw new Error(result.stderr.trim() || 'Unable to inspect the CI PostgreSQL container')
  }
  const [container] = JSON.parse(result.stdout)
  if (container.Config?.Labels?.[ownerLabel] !== record.owner) {
    throw new Error('Refusing to use or remove a PostgreSQL container owned by another run')
  }
  return container
}

function removeDatabase(record) {
  const container = inspectDatabase(record)
  if (!container) return
  const result = spawnSync('docker', ['rm', '--force', '--volumes', container.Id],
    { encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  if (result.status !== 0 && !/No such container/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || 'Unable to remove the CI PostgreSQL container')
  }
}

function stopDatabase() {
  const paths = databasePaths()
  // The starter checks this after docker run, so cancellation cannot race a late container creation.
  mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  writeFileSync(paths.cancelled, '', { mode: 0o600 })
  if (!existsSync(paths.record)) return
  let record
  try { record = databaseRecord(paths) }
  catch (error) {
    if (error.code === 'ENOENT') return // A concurrent cleanup already removed this run's record.
    throw error
  }
  removeDatabase(record)
  if (record.ready) rmSync(paths.record, { force: true })
}

async function waitForDatabase(record, paths) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (existsSync(paths.cancelled)) throw new Error('CI PostgreSQL startup was cancelled')
    const container = inspectDatabase(record)
    if (!container || !container.State.Running) throw new Error('CI PostgreSQL exited before becoming ready')
    if (container.State.Health?.Status === 'healthy') return container
    if (container.State.Health?.Status === 'unhealthy') throw new Error('CI PostgreSQL failed its readiness check')
    await delay(500)
  }
  throw new Error('CI PostgreSQL did not become ready within 90 seconds')
}

function databaseUrl(record, container) {
  const bindings = container.NetworkSettings?.Ports?.['5432/tcp'] ?? []
  const binding = bindings.find(value => value.HostIp === '127.0.0.1')
  if (!binding || !/^[1-9][0-9]*$/.test(binding.HostPort) || bindings.length !== 1) {
    throw new Error('CI PostgreSQL must publish one random port on loopback only')
  }
  return `postgresql://${databaseUser}:${record.password}@127.0.0.1:${binding.HostPort}/${databaseName}`
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

async function startDatabase() {
  const paths = databasePaths()
  mkdirSync(paths.state, { recursive: true, mode: 0o700 })
  if (existsSync(paths.record) || existsSync(paths.cancelled)) {
    throw new Error('CI_STATE already contains PostgreSQL state; use a fresh directory for this run')
  }
  const limits = databaseLimits()
  const owner = randomUUID()
  const record = { owner, name: `foreman-go-ci-${owner}`, password: randomBytes(24).toString('hex'), ready: false }
  writeFileSync(paths.record, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  const environment = { ...process.env, POSTGRES_USER: databaseUser, POSTGRES_DB: databaseName,
    POSTGRES_PASSWORD: record.password }
  try {
    command('docker', ['run', '--detach', '--rm', ...limits, '--name', record.name,
      '--label', `${ownerLabel}=${owner}`, '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--env', 'POSTGRES_PASSWORD',
      '--health-cmd', `pg_isready -h 127.0.0.1 -U ${databaseUser} -d ${databaseName}`,
      '--health-interval', '1s', '--health-timeout', '3s', '--health-retries', '60',
      postgresImage, 'postgres', '-c', 'max_connections=300', '-c', 'max_locks_per_transaction=512'], environment)
    const container = await waitForDatabase(record, paths)
    record.url = databaseUrl(record, container)
    record.ready = true
    writeJsonReport(paths.record, record)
    if (existsSync(paths.cancelled)) throw new Error('CI PostgreSQL startup was cancelled')
    process.stdout.write('[ci-setup] Fresh Go PostgreSQL is ready on an isolated loopback port\n')
  } catch (error) {
    try { removeDatabase(record) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'PostgreSQL startup and cleanup failed') }
    rmSync(paths.record, { force: true })
    throw error
  }
}

function databaseEnvironment() {
  const paths = databasePaths()
  const record = databaseRecord(paths)
  if (!record.ready || existsSync(paths.cancelled)) throw new Error('The CI PostgreSQL server is not ready')
  const container = inspectDatabase(record)
  if (!container?.State.Running) throw new Error('The CI PostgreSQL server is no longer running')
  const url = databaseUrl(record, container)
  // This is generated disposable state, never an inherited application DATABASE_URL.
  const quoted = `'${url.replaceAll("'", "'\\''")}'`
  process.stdout.write('unset GRAPHQL_DATABASE_URL GRAPHQL_TEST_DATABASE_URL GRAPHQL_CI_TEST_ADMIN_URL\n')
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
    case 'database-start': await startDatabase(); return
    case 'database-env': databaseEnvironment(); return
    case 'database-stop': stopDatabase(); return
    default: throw new Error('Usage: ci-go-prerequisites.mjs native|cache-key|database-start|database-env|database-stop')
  }
}

try { await main() }
catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`)
  if (error.cause) process.stderr.write(`Cause: ${error.cause.message}\n`)
  process.exitCode = 1
}
