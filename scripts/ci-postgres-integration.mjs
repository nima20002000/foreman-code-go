import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const candidate = 'e373f5425fba124b1abb048b76e18434c9e69d57'
const backendTree = '301bdc8f61641a210f5aabec168017d9e3885148'
const repository = process.cwd()
const parent = join(homedir(), '.cache', 'foreman-postgres-integration')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(realpathSync(parent), 'i-'))
const state = join(root, 'state')
mkdirSync(state, { mode: 0o700 })
const environment = { ...process.env, CI_STATE: state }
const log = value => console.log(`[go-integration] ${JSON.stringify(value)}`)
const metadata = { candidate, backendTree, checks: {}, ordinaryRun: {}, originalGoExitStatus: null, databaseSetupExitStatus: null,
  databaseCleanupExitStatus: null, databaseProvider: 'existing scripts/ci-go-prerequisites.mjs Docker PostgreSQL17.6' }
const integrationRoots = new Set([
  'TestCapturedBaselinePreservesStateAcrossStartupAndRestart',
  'TestStartupRejectsUnknownNonemptyDatabaseWithoutChangingIt',
  'TestStartupRejectsIncompleteOrAlteredApplicationHistory',
  'TestStartupRejectsMissingApplicationLedgerWithoutReplacingIt',
  'TestStartupAndReadinessRejectMissingCapturedCheckpointTable',
  'TestPostgresTransactionCommitsPersistedWrites', 'TestPostgresTransactionRollsBackAndReusesItsConnection',
  'TestPostgresTransactionCallerCancellationPreventsCommit', 'TestPostgresRollbackFailureDiscardsOnlyTheLostConnection',
  'TestPostgresCancelledStatementLeavesThePoolUsable', 'TestNumberedMigrationsApplyOnceAcrossStartupAndRestart',
  'TestNumberedMigrationsRejectChangedMissingOrUnknownHistory',
  'TestFailedNumberedMigrationRollsBackHistoryAndPersistedChanges',
  'TestPostgresCheckpointReadinessReportsFailureAndRecovery',
  'TestPostgresPoolExhaustionIsUnavailableAndRecoversOverHTTP', 'TestPostgresQueryFailuresUseThePublicHTTPEnvelope',
])

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024, env: environment, ...options })
  if (result.error) throw result.error
  return result
}

function provider(action) {
  return command(process.execPath, ['scripts/ci-go-prerequisites.mjs', action])
}

function artifact(path, bytes) {
  bytes = Buffer.from(bytes)
  const chunks = gzipSync(bytes).toString('base64').match(/.{1,6000}/g) ?? []
  console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'artifact', path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'gzip+base64', chunks: chunks.length })}`)
  for (let index = 0; index < chunks.length; index++) {
    console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'chunk', path, index, data: chunks[index] })}`)
  }
}

async function runGo({ name, arguments: args, databaseUrl }) {
  const stdout = openSync(join(root, `${name}.jsonl`), 'w', 0o600)
  const stderr = openSync(join(root, `${name}.stderr`), 'w', 0o600)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const childEnvironment = { ...environment, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: root, TMP: root, TEMP: root }
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'FOREMAN_CODE_CI_TEST_ADMIN_URL',
    'GRAPHQL_DATABASE_URL', 'GRAPHQL_TEST_DATABASE_URL', 'GRAPHQL_CI_TEST_ADMIN_URL']) delete childEnvironment[key]
  if (databaseUrl) Object.assign(childEnvironment, { FOREMAN_CODE_CI_TEST_ADMIN_URL: databaseUrl,
    DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl })
  const child = spawn('bash', ['-e', '-c',
    'source scripts/ci-go-toolchain.sh; ci_go_environment; ci_go_verify; if [ "$1" = staticcheck ]; then ci_staticcheck_verify; fi; cd backend; exec "$@"',
    'bash', ...args],
  { cwd: repository, env: childEnvironment,
  stdio: ['ignore', stdout, stderr] })
  const progress = setInterval(() => log({ status: 'running-Go-check', name }), 15_000)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (status, signal) => resolve({ status, signal }))
    })
  } finally { clearInterval(progress); closeSync(stdout); closeSync(stderr) }
}

async function runChecks() {
  const checks = [
    ['build', ['go', 'build', './...']], ['vet', ['go', 'vet', './...']], ['gofmt', ['gofmt', '-l', '.']],
    ['staticcheck', ['staticcheck', './...']], ['staticcheck-integration', ['staticcheck', '-tags', 'integration', './...']],
  ]
  for (const [name, args] of checks) {
    try {
      const outcome = await runGo({ name, arguments: args })
      const stdout = readFileSync(join(root, `${name}.jsonl`), 'utf8')
      const stderr = readFileSync(join(root, `${name}.stderr`), 'utf8')
      const invalidFormat = name === 'gofmt' && stdout.trim().length > 0
      metadata.checks[name] = { originalExitStatus: outcome.status, signal: outcome.signal, stdout, stderr, invalidFormat }
      if (outcome.status !== 0 || invalidFormat) process.exitCode = 1
      log({ check: name, originalExitStatus: outcome.status, invalidFormat })
    } catch (error) {
      metadata.checks[name] = { launcherFailure: error.message }
      process.exitCode = 1
      log({ check: name, launcherFailure: error.message })
    }
  }
  artifact('go-checks.json', `${JSON.stringify(metadata.checks, null, 2)}\n`)
}

async function runOrdinary() {
  try {
    const outcome = await runGo({ name: 'ordinary', arguments: ['go', 'test', '-json', '-count=1', './...'] })
    const raw = readFileSync(join(root, 'ordinary.jsonl'), 'utf8')
    metadata.ordinaryRun = { originalExitStatus: outcome.status, signal: outcome.signal, results: results(raw).ordinary }
    artifact('go-ordinary.jsonl', raw)
    artifact('go-ordinary.stderr.txt', readFileSync(join(root, 'ordinary.stderr')))
    log({ check: 'ordinary', ...metadata.ordinaryRun })
    if (outcome.status !== 0 || metadata.ordinaryRun.results.total === 0 || metadata.ordinaryRun.results.skipped > 0) process.exitCode = 1
  } catch (error) {
    metadata.ordinaryRun = { launcherFailure: error.message }
    process.exitCode = 1
    log({ check: 'ordinary', launcherFailure: error.message })
  }
}

function results(raw) {
  const named = new Map()
  for (const line of raw.split('\n').filter(Boolean)) {
    const event = JSON.parse(line)
    if (!event.Test || !['pass', 'fail', 'skip'].includes(event.Action)) continue
    named.set(`${event.Package}:${event.Test}`, { package: event.Package, name: event.Test,
      status: event.Action, integration: integrationRoots.has(event.Test.split('/')[0]) })
  }
  const summarize = values => ({ total: values.length, passed: values.filter(x => x.status === 'pass').length,
    failed: values.filter(x => x.status === 'fail').length, skipped: values.filter(x => x.status === 'skip').length })
  const values = [...named.values()]
  return { ordinary: summarize(values.filter(x => !x.integration)),
    integration: summarize(values.filter(x => x.integration)), namedIntegration: values.filter(x => x.integration) }
}

let record
try {
  if (!['true', '1'].includes(process.env.CI)) throw new Error('Run only through Foreman CI.')
  const actualTree = command('git', ['rev-parse', 'HEAD:backend']).stdout.trim()
  if (actualTree !== backendTree) throw new Error('Reviewed backend source tree changed.')
  metadata.executionMirrorCommit = command('git', ['rev-parse', 'HEAD']).stdout.trim()
  log({ status: 'verified-source', candidate, backendTree })
  await runChecks()
  await runOrdinary()
  const setup = provider('database-start')
  metadata.databaseSetupExitStatus = setup.status
  if (setup.status !== 0) {
    metadata.databaseFailure = 'Existing disposable database helper failed'
    if (/ENOENT/.test(setup.stderr)) metadata.databaseFailure = 'Docker command unavailable'
    else if (/Cannot connect|daemon is not running/.test(setup.stderr)) metadata.databaseFailure = 'Docker daemon unavailable'
    throw new Error(`${metadata.databaseFailure}; no Go tests ran.`)
  }
  const readiness = provider('database-env')
  if (readiness.status !== 0) throw new Error('Existing provider could not verify its owned server; no Go tests ran.')
  record = JSON.parse(readFileSync(join(state, 'go-database.json')))
  if (!record.ready || !/^[0-9a-f-]{36}$/.test(record.owner) || record.name !== `foreman-go-ci-${record.owner}`) {
    throw new Error('Existing provider ownership record is invalid.')
  }
  const address = new URL(record.url)
  if (address.hostname !== '127.0.0.1' || !address.port) throw new Error('Provider did not select a random loopback endpoint.')
  metadata.postgresVersion = command('docker', ['exec', record.name, 'postgres', '--version']).stdout.trim()
  metadata.databaseEndpoint = { host: address.hostname, port: Number(address.port), database: address.pathname.slice(1) }
  metadata.startedAt = new Date().toISOString()
  log({ status: 'fresh-provider-ready', postgresVersion: metadata.postgresVersion, endpoint: metadata.databaseEndpoint })
  const original = await runGo({ name: 'integration', arguments: ['go', 'test', '-json', '-count=1', '-tags', 'integration', './...'],
    databaseUrl: record.url })
  metadata.originalGoExitStatus = original.status
  metadata.originalGoSignal = original.signal
  metadata.finishedAt = new Date().toISOString()
  const raw = readFileSync(join(root, 'integration.jsonl'), 'utf8')
  const stderr = readFileSync(join(root, 'integration.stderr'), 'utf8')
  if ([raw, stderr].some(value => value.includes(record.password) || value.includes(record.url))) {
    throw new Error('Original Go output contains disposable credentials; bytes withheld without rewriting them.')
  }
  Object.assign(metadata, results(raw))
  const converted = join(root, 'go-report.json')
  const conversion = command(process.execPath, ['scripts/ci-go-test-results.mjs', '--module',
    'github.com/nima20002000/foreman-code-go/backend', '--input', join(root, 'integration.jsonl'), '--output', converted])
  metadata.conversionExitStatus = conversion.status
  if (process.env.TEST_RESULTS_OUTPUT && existsSync(converted)) {
    const publish = command(process.execPath, ['scripts/ci-test-results.mjs', process.env.TEST_RESULTS_OUTPUT, converted])
    metadata.resultPublicationExitStatus = publish.status
    if (publish.status !== 0) process.exitCode = 1
  }
  artifact('go-integration.jsonl', raw)
  artifact('go-integration.stderr.txt', stderr)
  if (existsSync(converted)) artifact('go-integration-report.json', readFileSync(converted))
  log({ status: 'actual-results', ordinary: metadata.ordinary, integration: metadata.integration,
    originalGoExitStatus: original.status, conversionExitStatus: conversion.status })
  if (original.status !== 0 || conversion.status !== 0 || metadata.integration.total === 0
    || metadata.integration.skipped > 0) process.exitCode = 1
} catch (error) {
  metadata.failure = error.message
  log({ status: 'failed', message: error.message })
  process.exitCode = 1
} finally {
  const cleanup = provider('database-stop')
  metadata.databaseCleanupExitStatus = cleanup.status
  metadata.databaseRecordRemoved = !existsSync(join(state, 'go-database.json'))
  if (cleanup.status !== 0 || !metadata.databaseRecordRemoved) process.exitCode = 1
  log({ status: 'provider-cleanup', exitStatus: cleanup.status, recordRemoved: metadata.databaseRecordRemoved })
  artifact('go-integration-provenance.json', `${JSON.stringify(metadata, null, 2)}\n`)
  console.log('FOREMAN_CAPTURE {"kind":"complete"}')
  if (cleanup.status === 0 && metadata.databaseRecordRemoved) rmSync(root, { recursive: true, force: true })
}
