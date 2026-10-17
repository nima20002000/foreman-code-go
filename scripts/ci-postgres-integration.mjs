import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const candidate = '3bf269c3ce32c1216af44d1e28e973bdf50fdf4e'
const backendTree = 'e03677e397be49ccfe4cfbff79d047b3b6115c20'
const repository = process.cwd()
const parent = join(homedir(), '.cache', 'foreman-postgres-integration')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(realpathSync(parent), 'i-'))
const state = join(root, 'state')
mkdirSync(state, { mode: 0o700 })
const environment = { ...process.env, CI_STATE: state }
const log = value => console.log(`[go-integration] ${JSON.stringify(value)}`)
const metadata = { candidate, backendTree, originalGoExitStatus: null, databaseSetupExitStatus: null,
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

async function runGo(databaseUrl) {
  const stdout = openSync(join(root, 'go.jsonl'), 'w', 0o600)
  const stderr = openSync(join(root, 'go.stderr'), 'w', 0o600)
  const child = spawn('bash', ['-e', '-c',
    'source scripts/ci-go-toolchain.sh; ci_go_environment; ci_go_verify; cd backend; exec go test -json -count=1 -tags integration ./...'],
  { cwd: repository, env: { ...environment, FOREMAN_CODE_CI_TEST_ADMIN_URL: databaseUrl,
    DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, TMPDIR: root, TMP: root, TEMP: root },
  stdio: ['ignore', stdout, stderr] })
  const progress = setInterval(() => log({ status: 'running-real-Go-integration-tagged-module' }), 15_000)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (status, signal) => resolve({ status, signal }))
    })
  } finally { clearInterval(progress); closeSync(stdout); closeSync(stderr) }
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
  const original = await runGo(record.url)
  metadata.originalGoExitStatus = original.status
  metadata.originalGoSignal = original.signal
  metadata.finishedAt = new Date().toISOString()
  const raw = readFileSync(join(root, 'go.jsonl'), 'utf8')
  const stderr = readFileSync(join(root, 'go.stderr'), 'utf8')
  if ([raw, stderr].some(value => value.includes(record.password) || value.includes(record.url))) {
    throw new Error('Original Go output contains disposable credentials; bytes withheld without rewriting them.')
  }
  Object.assign(metadata, results(raw))
  const converted = join(root, 'go-report.json')
  const conversion = command(process.execPath, ['scripts/ci-go-test-results.mjs', '--module',
    'github.com/nima20002000/foreman-code-go/backend', '--input', join(root, 'go.jsonl'), '--output', converted])
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
