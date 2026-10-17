import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

const rootEntry = fileURLToPath(new URL('./ci-root-suite.mjs', import.meta.url))
const goCalls = fixture => fixture.calls().filter(call => call.tool === 'go' && call.args[0] !== 'env')

for (const scope of ['full', 'affected', '']) {
  test(`backend typecheck runs full Go build and vet with ${scope || 'omitted'} scope`, t => {
    const fixture = goCiFixture(t, { SCOPE: scope, SLICE: '19/30', SELECTED_FILES: 's:999' })
    const result = fixture.run('typecheck-api')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(goCalls(fixture).map(call => call.args), [['build', './...'], ['vet', './...']])
    assert.equal(fixture.calls().some(call => call.tool === 'corepack' || call.tool === 'git'), false)
    assert.equal(fixture.isolatedHomeExists(), false)
    assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'untouched')
  })
}

for (const [suite, command] of [['typecheck-api', 'build'], ['typecheck-api', 'vet'], ['build-api', 'build']]) {
  test(`${suite} preserves a failing Go ${command} status`, t => {
    const fixture = goCiFixture(t, { FAIL_GO_COMMAND: command })
    const result = fixture.run(suite)
    assert.equal(result.status, 9, result.stderr)
  })
}

test('root typecheck combines Go and retained TS including conformance without API checks', t => {
  const fixture = goCiFixture(t)
  const result = fixture.run('typecheck')
  assert.equal(result.status, 0, result.stderr)
  const packages = fixture.calls().filter(call => call.tool === 'corepack').map(call => call.args)
  assert.deepEqual(packages, [
    ['pnpm', '--filter', '@foreman-code/contracts', 'build'],
    ['pnpm', '-r', '--no-bail', '--filter', '@foreman-code/contracts', '--filter', '@foreman-code/web', 'typecheck'],
    ['pnpm', '--dir', 'conformance', 'typecheck'],
  ])
})

test('Go lint rejects formatting changes and preserves staticcheck failures', t => {
  const unformatted = goCiFixture(t, { UNFORMATTED_GO: './runtime/state.go' })
  const formatResult = unformatted.run('lint-api')
  assert.equal(formatResult.status, 1, formatResult.stderr)
  assert.match(formatResult.stderr, /need gofmt/)
  const failing = goCiFixture(t, { FAIL_STATICCHECK: '1' })
  const lintResult = failing.run('lint-api')
  assert.equal(lintResult.status, 6, lintResult.stderr)
  const passing = goCiFixture(t)
  assert.equal(passing.run('lint-api').status, 0)
  assert.deepEqual(passing.calls().filter(call => call.tool === 'staticcheck' && call.args[0] !== '-version')
    .map(call => call.args), [['./...'], ['-tags', 'integration', './...']])
})

test('Go unit publishes per-test results and durations without PostgreSQL or inherited application state', t => {
  const fixture = goCiFixture(t, { SLICE: '7/8', DATABASE_URL: 'postgresql://existing.invalid/app',
    FOREMAN_CODE_API_ENV_FILE: '/existing-installation/foreman.env', GRAPHQL_API_ENV_FILE: '/existing-installation/graphql.env',
    PGSERVICEFILE: '/existing-installation/pg-service.conf', PGPASSFILE: '/existing-installation/pg-password' })
  const result = fixture.run('unit-api')
  assert.equal(result.status, 0, result.stderr)
  const tests = goCalls(fixture).find(call => call.args[0] === 'test')
  assert.deepEqual(tests.args, ['test', '-json', '-count=1', './...'])
  assert.equal(tests.database, undefined)
  assert.equal(tests.environmentFile, undefined)
  assert.equal(tests.graphqlEnvironmentFile, undefined)
  assert.equal(tests.postgresServiceFile, undefined)
  assert.equal(tests.postgresPasswordFile, undefined)
  assert.equal(tests.home, join(fixture.state, 'home'))
  assert.equal(tests.gopath, join(fixture.cache, 'gopath'))
  assert.equal(tests.goflags, '-mod=readonly')
  assert.equal(fixture.calls().some(call => call.tool === 'docker'), false)
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
  assert.deepEqual(JSON.parse(readFileSync(fixture.environment.DURATIONS_OUTPUT, 'utf8')), { 'backend/runtime': 500 })
})

for (const mode of ['failed', 'zero']) {
  test(`Go unit is red for ${mode} tests even when no result output was requested`, t => {
    const fixture = goCiFixture(t, { GO_TEST_MODE: mode, TEST_RESULTS_OUTPUT: '' })
    const result = fixture.run('unit-api')
    assert.notEqual(result.status, null)
    assert.notEqual(result.status, 0)
    assert.equal(fixture.calls().some(call => call.tool === 'docker'), false)
    if (mode === 'zero') assert.match(result.stderr, /zero selected Go tests/)
  })
}

test('a missing backend module fails before running a frozen TS suite', t => {
  const fixture = goCiFixture(t)
  rmSync(join(fixture.directory, 'backend/go.mod'))
  const result = fixture.run('unit-api')
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /backend\/go.mod is missing/)
  assert.equal(fixture.calls().some(call => call.tool === 'corepack'), false)
})

test('retained unit parts run browser, contracts and recursive script tests with an isolated home', t => {
  for (const suite of ['unit-web', 'unit-web-heavy', 'unit-other']) {
    const fixture = goCiFixture(t)
    const result = fixture.run(suite)
    assert.equal(result.status, 0, result.stderr)
    const calls = fixture.calls().filter(call => call.tool === 'corepack')
    assert.ok(calls.length > 0)
    assert.ok(calls.every(call => call.home === join(fixture.state, 'home')))
    assert.equal(calls.some(call => call.args.includes('@foreman-code/api') || call.cwd.endsWith('/apps/worker')), false)
    assert.equal(fixture.calls().some(call => call.tool === 'docker'), false)
    if (suite === 'unit-other') assert.ok(calls.some(call => call.args.includes('scripts/**/*.test.mjs')))
    assert.equal(fixture.isolatedHomeExists(), false)
  }
})

for (const changed of ['no', 'yes', 'unknown']) {
  test(`integration always runs Go and requires the TS oracle when comparison is ${changed}`, t => {
    const fixture = goCiFixture(t, { CONFORMANCE_CHANGED: changed })
    const prepared = fixture.run('integration', 'prepare')
    assert.equal(prepared.status, 0, prepared.stderr)
    const result = fixture.run('integration')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(goCalls(fixture).find(call => call.args[0] === 'test').args,
      ['test', '-json', '-count=1', '-tags', 'integration', './...'])
    const targets = fixture.calls().filter(call => call.args.includes('test:ci')).map(call => call.target)
    assert.deepEqual(targets, changed === 'no' ? ['go'] : ['go', 'ts'])
    assert.equal(fixture.results().summary.passed, changed === 'no' ? 2 : 3)
    assert.equal(existsSync(join(fixture.state, 'fixture-docker.json')), false)
    assert.equal(fixture.isolatedHomeExists(), false)
    if (changed === 'unknown') assert.match(result.stderr, /requiring the TS conformance target/)
  })
}

test('failed Go tests and missing Go conformance output still run and publish the TS oracle', t => {
  const fixture = goCiFixture(t, { GO_TEST_MODE: 'failed', CONFORMANCE_GO_MODE: 'missing', CONFORMANCE_CHANGED: 'yes' })
  assert.equal(fixture.run('integration', 'prepare').status, 0)
  const result = fixture.run('integration')
  assert.notEqual(result.status, null)
  assert.notEqual(result.status, 0)
  assert.deepEqual(fixture.calls().filter(call => call.args.includes('test:ci')).map(call => call.target), ['go', 'ts'])
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 1, skipped: 0 })
})

test('host root integration ignores legacy TS file arguments and publishes the legacy result aliases', t => {
  const fixture = goCiFixture(t, { TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' })
  assert.equal(fixture.run('integration', 'prepare').status, 0)
  const output = join(fixture.directory, 'host-results.json')
  const durations = join(fixture.directory, 'host-durations.json')
  const result = spawnSync(process.execPath, [rootEntry, 'integration', '--', 'node', 'scripts/test-integration.mjs',
    '--files', 'apps/api/test/frozen.integration.test.ts'], { cwd: fixture.directory, encoding: 'utf8', timeout: 20_000,
    env: { ...fixture.environment, FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: output,
      FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT: durations } })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /frozen TypeScript file selection is ignored/)
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).summary.passed, 2)
  assert.ok(JSON.parse(readFileSync(durations, 'utf8'))['backend/runtime'] > 0)
})

for (const environment of [{ CI_HOST_RUNNER: '1' }, { FOREMAN_CODE_CI_HOST: '1' },
  { CI: 'true' }, { CI: '1' }, { FOREMAN_CODE_CI_LOCAL: '1' }]) {
  test(`the root suite uses Go checks for ${JSON.stringify(environment)}`, t => {
    const fixture = goCiFixture(t, { CI: '', CI_HOST_RUNNER: '0', FOREMAN_CODE_CI_HOST: '',
      FOREMAN_CODE_CI_LOCAL: '', ...environment })
    const result = spawnSync(process.execPath, [join(fixture.directory, 'scripts/ci-root-suite.mjs'),
      'typecheck', '--', 'node', 'unexpected-frozen-fallback.mjs'], { cwd: fixture.directory,
      env: fixture.environment, encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(goCalls(fixture).map(call => call.args), [['build', './...'], ['vet', './...']])
    assert.equal(fixture.calls().some(call => call.args.includes('@foreman-code/api')), false)
  })
}

test('preparation reuses the pinned cache and never starts a database for Go unit tests', t => {
  const fixture = goCiFixture(t)
  const result = fixture.run('unit-api', 'prepare')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fixture.calls().some(call => call.tool === 'docker' || call.tool === 'corepack'), false)
  assert.equal(fixture.run('unit-api').status, 0)
  assert.equal(fixture.isolatedHomeExists(), false)
})

test('failed integration preparation cleans its isolated home and does not run tests', t => {
  const fixture = goCiFixture(t, { FAIL_DATABASE_START: '1' })
  const result = fixture.run('integration', 'prepare')
  assert.equal(result.status, 1, result.stderr)
  assert.equal(fixture.isolatedHomeExists(), false)
  assert.equal(goCalls(fixture).some(call => call.args[0] === 'test'), false)
})

test('two host jobs keep separate disposable databases and clean up only their own server', t => {
  const first = goCiFixture(t, { FIXTURE_DATABASE_PORT: '55001' })
  const second = goCiFixture(t, { FIXTURE_DATABASE_PORT: '55002' })
  for (const fixture of [first, second]) {
    const result = fixture.run('integration', 'prepare')
    assert.equal(result.status, 0, result.stderr)
    const creation = fixture.calls().find(call => call.tool === 'docker' && call.args[0] === 'run')
    assert.equal(creation.args[creation.args.indexOf('--publish') + 1], '127.0.0.1::5432')
    assert.ok(creation.args.includes('--rm'))
  }
  const record = fixture => JSON.parse(readFileSync(join(fixture.state, 'go-database.json'), 'utf8'))
  assert.notEqual(record(first).owner, record(second).owner)
  assert.equal(new URL(record(first).url).port, '55001')
  assert.equal(new URL(record(second).url).port, '55002')
  assert.equal(first.run('integration').status, 0)
  assert.equal(existsSync(join(first.state, 'fixture-docker.json')), false)
  assert.equal(existsSync(join(second.state, 'fixture-docker.json')), true)
  assert.equal(second.run('integration').status, 0)
  assert.equal(existsSync(join(second.state, 'fixture-docker.json')), false)
})

for (const suite of ['typecheck-other', 'build-other']) {
  test(`${suite} reuses a ready contracts build and still executes retained checks`, t => {
    const fixture = goCiFixture(t, { FOREMAN_CODE_CI_CONTRACTS_CACHE: 'fixture-cache' })
    rmSync(join(fixture.directory, 'scripts/ci-contracts.mjs'))
    writeFileSync(join(fixture.directory, 'scripts/ci-contracts.mjs'), 'process.exit(0)\n')
    const result = fixture.run(suite)
    assert.equal(result.status, 0, result.stderr)
    const commands = fixture.calls().filter(call => call.tool === 'corepack').map(call => call.args)
    assert.equal(commands.some(args => args.length === 4 && args.at(-1) === 'build'), false)
    assert.ok(commands.some(args => args.includes('--no-bail') && args.includes('@foreman-code/web')))
  })
}

test('a stale contracts cache rebuilds and preserves the compiler failure', t => {
  const fixture = goCiFixture(t, { FOREMAN_CODE_CI_CONTRACTS_CACHE: 'fixture-cache', FAIL_PNPM_COMMAND: 'build' })
  const result = fixture.run('typecheck-other')
  assert.equal(result.status, 9, result.stderr)
  assert.deepEqual(fixture.calls().filter(call => call.tool === 'corepack').map(call => call.args),
    [['pnpm', '--filter', '@foreman-code/contracts', 'build']])
})

test('a failed Go archive checksum never installs or executes the downloaded content', t => {
  const fixture = goCiFixture(t)
  rmSync(join(fixture.cache, 'toolchains'), { recursive: true })
  const bin = join(fixture.directory, 'download-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(process.env.FIXTURE_DOWNLOAD, JSON.stringify(args))
fs.writeFileSync(args[args.indexOf('--output') + 1], 'invalid archive fixture')
`, { mode: 0o755 })
  const download = join(fixture.directory, 'download.json')
  const result = fixture.run('unit-api', 'prepare', { PATH: `${bin}:${fixture.environment.PATH}`, FIXTURE_DOWNLOAD: download })
  assert.notEqual(result.status, null)
  assert.notEqual(result.status, 0)
  const args = JSON.parse(readFileSync(download, 'utf8'))
  assert.match(args.at(-1), new RegExp(`^https://go\\.dev/dl/go${fixture.environment.FIXTURE_GO_VERSION.replaceAll('.', '\\.')}\\.linux-(amd64|arm64)\\.tar\\.gz$`))
  assert.equal(existsSync(join(fixture.cache, 'toolchains', `go${fixture.environment.FIXTURE_GO_VERSION}`)), false)
  assert.equal(fixture.calls().some(call => call.tool === 'go'), false)
  assert.equal(fixture.isolatedHomeExists(), false)
})

test('canceling a failed prerequisite reconciles PostgreSQL created by a late Docker response', t => {
  const fixture = goCiFixture(t, { FIXTURE_GO_VERSION: '0.0.0', FIXTURE_DATABASE_DELAY_MS: '500' })
  const bin = join(fixture.directory, 'cancel-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const deadline = Date.now() + 5000
const timer = setInterval(() => {
  if (existsSync(join(process.env.CI_STATE, 'fixture-docker-started')) || Date.now() > deadline) {
    clearInterval(timer)
    console.error('fixture tool download failed')
    process.exitCode = 8
  }
}, 10)
`, { mode: 0o755 })
  const environment = { PATH: `${bin}:${fixture.environment.PATH}` }
  const started = fixture.run('integration', 'start', environment)
  assert.equal(started.status, 0, started.stderr)
  const failed = fixture.run('integration', '', environment)
  assert.equal(failed.status, 1, failed.stderr)
  assert.match(failed.stderr + failed.stdout, /fixture tool download failed/)
  const docker = fixture.calls().filter(call => call.tool === 'docker')
  assert.equal(docker.filter(call => call.args[0] === 'run').length, 1)
  assert.equal(docker.filter(call => call.args[0] === 'rm').length, 1)
  assert.equal(existsSync(join(fixture.state, 'fixture-docker.json')), false)
  assert.equal(fixture.isolatedHomeExists(), false)
})
