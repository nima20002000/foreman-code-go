import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'
import { conformanceFixture } from './test-support/conformance-report-fixture.mjs'

const goCalls = fixture => fixture.calls().filter(call => call.tool === 'go' && call.args[0] !== 'env'
  && call.args.join(' ') !== 'telemetry off')
const conformanceCalls = fixture => fixture.calls().filter(call => call.tool === 'corepack'
  && call.args.includes('run') && call.args[call.args.indexOf('run') + 1] === 'conformance')
const conformanceLaunches = fixture => conformanceCalls(fixture).filter(call => !call.args.includes('--list'))
const conformanceReport = (fixture, name) => JSON.parse(readFileSync(join(fixture.state, 'conformance', name), 'utf8'))

test('explicit release mode runs full Go build and vet', t => {
    const fixture = goCiFixture(t, { SCOPE: 'full', SLICE: '19/30', SELECTED_FILES: 's:999' })
    const result = fixture.run('typecheck-api')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(goCalls(fixture).map(call => call.args), [['build', './...'], ['vet', './...']])
    assert.equal(fixture.calls().some(call => call.tool === 'corepack' || call.tool === 'git'), false)
    assert.equal(fixture.isolatedHomeExists(), false)
    assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'untouched')
})

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

test('retained lint includes conformance and still runs it after a package lint failure', t => {
  const passing = goCiFixture(t)
  const pass = passing.run('lint-other')
  assert.equal(pass.status, 0, pass.stderr)
  assert.ok(passing.calls().some(call => call.tool === 'corepack'
    && call.args.join(' ') === 'pnpm --dir conformance lint'))
  const failing = goCiFixture(t, { FAIL_PNPM_COMMAND: 'lint' })
  const failure = failing.run('lint-other')
  assert.equal(failure.status, 9, failure.stderr)
  assert.ok(failing.calls().some(call => call.tool === 'corepack'
    && call.args.join(' ') === 'pnpm --dir conformance lint'))
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
  assert.equal(tests.home, fixture.runtimeHome())
  assert.equal(tests.temporaryDirectory, join(fixture.runtimeRoot(), 'tmp'))
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

test('retained unit parts run browser, contracts, conformance and recursive script tests with an isolated home', t => {
  for (const suite of ['unit-web', 'unit-web-heavy', 'unit-other']) {
    const fixture = goCiFixture(t)
    if (suite === 'unit-other') {
      const prepared = fixture.run(suite, 'prepare')
      assert.equal(prepared.status, 0, prepared.stderr)
    }
    const result = fixture.run(suite)
    assert.equal(result.status, 0, result.stderr)
    const calls = fixture.calls().filter(call => call.tool === 'corepack')
    assert.ok(calls.length > 0)
    assert.ok(calls.every(call => call.home === fixture.runtimeHome()))
    assert.equal(calls.some(call => call.args.includes('@foreman-code/api') || call.cwd.endsWith('/apps/worker')), false)
    assert.equal(fixture.calls().some(call => call.tool === 'docker'), suite === 'unit-other')
    if (suite === 'unit-other') {
      const scripts = calls.find(call => call.args.includes('scripts/**/*.test.mjs'))
      assert.ok(scripts)
      const admin = new URL(scripts.adminDatabase)
      assert.equal(admin.hostname, '127.0.0.1')
      assert.equal(admin.username, 'graphql_test_admin')
      assert.equal(admin.password, 'graphql_test_disposable_only')
      assert.equal(admin.pathname, '/postgres')
      assert.match(scripts.hostRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.ok(calls.filter(call => call !== scripts).every(call => call.adminDatabase === undefined))
      assert.ok(calls.some(call => call.args.includes('--dir') && call.args.includes('conformance') && call.args.includes('test')))
      assert.deepEqual(fixture.results().summary, { passed: 3, failed: 0, skipped: 0 })
      assert.ok(fixture.results().files.some(file => file.file === 'conformance/src/reporting/report.test.ts'))
    }
    assert.equal(fixture.isolatedHomeExists(), false)
  }
})

test('a short private runtime executes CommonJS HOME tools and binds Unix sockets outside repository module scope', t => {
  const fixture = goCiFixture(t, { FIXTURE_VERIFY_RUNTIME_NODE: '1' })
  writeFileSync(join(fixture.directory, 'package.json'), JSON.stringify({ type: 'module' }))
  const result = fixture.run('typecheck-api')
  assert.equal(result.status, 0, result.stderr)
  const runtime = fixture.runtimeRoot()
  assert.match(runtime, /^\/tmp\/fci\.[A-Za-z0-9]{6}$/)
  const execution = JSON.parse(readFileSync(join(fixture.state, 'node-runtime.json'), 'utf8'))
  assert.equal(execution.commonjs, true)
  assert.equal(execution.rootMode, 0o700)
  assert.equal(execution.homeMode, 0o700)
  assert.equal(execution.socket, join(runtime, 'tmp', 's'.repeat(70)))
  const calls = fixture.calls()
  const probes = calls.filter(call => call.tool === 'go'
    && ['telemetry off', 'env GOVERSION'].includes(call.args.join(' ')))
  const operations = calls.filter(call => !probes.includes(call))
  assert.ok(operations.length > 0)
  assert.ok(operations.every(call => call.home === join(runtime, 'home')))
  assert.ok(probes.length > 0)
  for (const home of new Set(probes.map(probe => probe.home))) {
    assert.deepEqual(probes.filter(probe => probe.home === home).map(probe => probe.args.join(' ')),
      ['telemetry off', 'env GOVERSION'])
  }
  for (const probe of probes) {
    assert.equal(probe.home.startsWith(`${fixture.cache}/toolchain-probe.`), true)
    assert.equal(probe.configDirectory, join(probe.home, '..', 'config'))
    assert.equal(probe.temporaryDirectory, join(probe.home, '..', 'tmp'))
    assert.equal(existsSync(probe.home), false)
  }
  assert.equal(existsSync(runtime), false)
  assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'untouched')
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
    const targets = conformanceLaunches(fixture).map(call => call.target)
    assert.deepEqual(targets, changed === 'no' ? ['go'] : ['go', 'ts'])
    assert.deepEqual(conformanceCalls(fixture).filter(call => call.args.includes('--list')).map(call => call.target), targets)
    assert.deepEqual(goCalls(fixture).find(call => call.args[0] === 'build').args,
      ['build', '-o', join(fixture.state, 'bin/foreman'), './cmd/foreman'])
    const integration = goCalls(fixture).find(call => call.args[0] === 'test')
    assert.equal(new URL(integration.database).hostname, '127.0.0.1')
    for (const launch of conformanceLaunches(fixture)) {
      assert.equal(launch.database, undefined)
      assert.equal(launch.goBinary, join(fixture.state, 'bin/foreman'))
      assert.equal(launch.postgresBinaryDirectory, join(fixture.postgresCache, 'bin'))
      assert.equal(launch.conformanceResults, join(fixture.state, 'conformance', `${launch.target}.json`))
      const raw = conformanceReport(fixture, `${launch.target}.json`)
      assert.equal(raw.commitSha, fixture.environment.FIXTURE_COMMIT_SHA)
      assert.equal(raw.commitSource, 'git')
      assert.equal(raw.executed, 1)
      assert.equal(conformanceReport(fixture, `${launch.target}.inventory.json`).scenarios.length, 1)
      assert.equal(conformanceReport(fixture, `${launch.target}.full-verdict.json`).status, 'passed')
      assert.equal(conformanceReport(fixture, `${launch.target}.gate.json`).status, 'passed')
      const events = readFileSync(join(fixture.state, 'conformance', `${launch.target}.jsonl`), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(events.map(event => event.kind), ['conformance-scenario', 'conformance-summary'])
    }
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
  assert.deepEqual(conformanceLaunches(fixture).map(call => call.target), ['go', 'ts'])
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 1, skipped: 0 })
})

for (const mode of ['partial', 'coverage']) {
  test(`incremental conformance retains the failed full ${mode} verdict and complete mode rejects it`, t => {
    for (const gate of ['incremental', 'complete']) {
      const fixture = goCiFixture(t, { CONFORMANCE_GO_MODE: mode, CONFORMANCE_GATE: gate })
      const prepared = fixture.run('integration', 'prepare')
      assert.equal(prepared.status, 0, prepared.stderr)
      const result = fixture.run('integration')
      assert.equal(result.status, gate === 'incremental' ? 0 : 1, result.stderr)
      assert.equal(conformanceReport(fixture, 'go.json').status, 'failed')
      assert.equal(conformanceReport(fixture, 'go.full-verdict.json').status, 'failed')
      assert.equal(conformanceReport(fixture, 'go.gate.json').status, gate === 'incremental' ? 'passed' : 'failed')
      assert.equal(fixture.results().summary.failed, mode === 'partial' ? 1 : 0)
    }
  })
}

for (const mode of ['failed', 'zero', 'setup', 'truncated', 'malformed']) {
  test(`conformance ${mode} evidence stays red and still allows the TS oracle to run`, t => {
    const fixture = goCiFixture(t, { CONFORMANCE_GO_MODE: mode, CONFORMANCE_CHANGED: 'yes', TEST_RESULTS_OUTPUT: '' })
    const prepared = fixture.run('integration', 'prepare')
    assert.equal(prepared.status, 0, prepared.stderr)
    const result = fixture.run('integration')
    assert.notEqual(result.status, null)
    assert.notEqual(result.status, 0)
    assert.deepEqual(conformanceLaunches(fixture).map(call => call.target), ['go', 'ts'])
    assert.equal(conformanceReport(fixture, 'ts.json').status, 'passed')
    assert.equal(existsSync(join(fixture.state, 'conformance/go.json')), true)
  })
}

test('an unsuccessful converter without validated outputs cannot be accepted as a full-conformance failure', t => {
  const fixture = goCiFixture(t, { TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' })
  writeFileSync(join(fixture.directory, 'scripts/ci-conformance-results.mjs'), 'process.exitCode = 1\n')
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const result = fixture.run('integration')
  assert.equal(result.status, 2, result.stderr)
  assert.match(result.stderr, /complete validated outputs/)
  assert.equal(conformanceReport(fixture, 'go.json').status, 'passed')
})

test('controller commit provenance and target-specific main evidence reach the separate gates', t => {
  const commit = '2'.repeat(40)
  const mainCommit = '3'.repeat(40)
  const fixture = goCiFixture(t, { CONFORMANCE_COMMIT_SHA: commit, CONFORMANCE_CHANGED: 'yes' })
  const mainFile = join(fixture.directory, 'main-go.json')
  writeFileSync(mainFile, JSON.stringify(conformanceFixture({ commitSha: mainCommit }).report))
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const result = fixture.run('integration', '', { CONFORMANCE_MAIN_GO_RESULTS_FILE: mainFile,
    CONFORMANCE_MAIN_COMMIT_SHA: mainCommit })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(conformanceReport(fixture, 'go.json').commitSha, commit)
  assert.equal(conformanceReport(fixture, 'go.json').commitSource, 'environment')
  assert.equal(conformanceReport(fixture, 'go.gate.json').nonRegression.status, 'passed')
  assert.equal(conformanceReport(fixture, 'go.gate.json').nonRegression.mainCommitSha, mainCommit)
  assert.equal(conformanceReport(fixture, 'ts.gate.json').nonRegression.status, 'not-available')
})

test('a failing Go executable build remains red even when conformance returns a passing report', t => {
  const fixture = goCiFixture(t, { FAIL_GO_COMMAND: 'build', CONFORMANCE_CHANGED: 'yes' })
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const result = fixture.run('integration')
  assert.equal(result.status, 9, result.stderr)
  assert.deepEqual(conformanceLaunches(fixture).map(call => call.target), ['go', 'ts'])
})

test('PostgreSQL preparation forwards actual successful installer output once', t => {
  const fixture = goCiFixture(t)
  const started = fixture.run('integration', 'start')
  assert.equal(started.status, 0, started.stderr)
  const result = fixture.run('integration')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.split('fixture cached PostgreSQL preparation complete').length - 1, 1)
  assert.ok(fixture.calls().some(call => call.tool === 'postgres-tools' && call.args[0] === 'install'))
  assert.ok(fixture.calls().some(call => call.tool === 'postgres-tools' && call.args[0] === 'verify'))
})

test('provider cleanup removes prepared resources and private runtime without running tests', t => {
  const fixture = goCiFixture(t)
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const runtime = fixture.runtimeRoot()
  assert.equal(statSync(runtime).mode & 0o777, 0o700)
  const cleanup = fixture.run('integration', 'cleanup', { CI_PARTITION: `sha256:${'f'.repeat(64)}` })
  assert.equal(cleanup.status, 0, cleanup.stderr)
  assert.equal(goCalls(fixture).some(call => call.args[0] === 'test'), false)
  assert.equal(existsSync(join(fixture.state, 'fixture-docker.json')), false)
  assert.equal(existsSync(runtime), false)
})

test('overlapping cleanup calls release the runtime and remove the disposable database once', async t => {
  const fixture = goCiFixture(t, { FIXTURE_DATABASE_REMOVE_DELAY_MS: '500' })
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const runtime = fixture.runtimeRoot()
  const cleanup = () => new Promise(resolve => {
    const child = spawn('bash', [join(fixture.directory, 'scripts/ci-suite.sh'), 'cleanup'], {
      cwd: fixture.directory, env: { ...fixture.environment, SUITE: 'integration' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    })
    let error
    let stderr = ''
    child.stdout?.resume()
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', failure => { error = failure })
    child.once('close', (status, signal) => resolve({ status, signal, error, stderr }))
  })
  const results = await Promise.all([cleanup(), cleanup()])
  for (const result of results) {
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.status, 0, result.stderr)
  }
  const removals = fixture.calls().filter(call => call.tool === 'docker' && call.args[0] === 'rm')
  assert.equal(removals.length, 1)
  assert.equal(goCalls(fixture).some(call => call.args[0] === 'test'), false)
  assert.equal(existsSync(join(fixture.state, 'fixture-docker.json')), false)
  assert.equal(existsSync(join(fixture.state, 'runtime-root')), false)
  assert.equal(existsSync(runtime), false)
})

test('cleanup without a runtime needs no module or installed toolchains and creates no private HOME', t => {
  const fixture = goCiFixture(t)
  rmSync(join(fixture.directory, 'backend'), { recursive: true })
  rmSync(join(fixture.directory, 'conformance'), { recursive: true })
  rmSync(fixture.cache, { recursive: true })
  const cleanup = fixture.run('integration', 'cleanup')
  assert.equal(cleanup.status, 0, cleanup.stderr)
  assert.deepEqual(fixture.calls(), [])
  assert.equal(existsSync(join(fixture.state, 'runtime-root')), false)
})

test('explicit release root integration publishes the legacy result aliases', t => {
  const fixture = goCiFixture(t, { TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' })
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const rootEntry = join(fixture.directory, 'scripts/ci-root-suite.mjs')
  const output = join(fixture.directory, 'host-results.json')
  const durations = join(fixture.directory, 'host-durations.json')
  const result = spawnSync(process.execPath, [rootEntry, 'integration', '--', 'node', 'scripts/test-integration.mjs'],
    { cwd: fixture.directory, encoding: 'utf8', timeout: 20_000,
    env: { ...fixture.environment, FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: output,
      FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT: durations } })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
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
  assert.equal(fixture.isolatedHomeExists(), false)
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
  assert.notEqual(first.runtimeRoot(), second.runtimeRoot())
  assert.equal(new URL(record(first).url).port, '55001')
  assert.equal(new URL(record(second).url).port, '55002')
  assert.equal(first.run('integration').status, 0)
  assert.equal(existsSync(join(first.state, 'fixture-docker.json')), false)
  assert.equal(existsSync(join(second.state, 'fixture-docker.json')), true)
  assert.equal(second.isolatedHomeExists(), true)
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
