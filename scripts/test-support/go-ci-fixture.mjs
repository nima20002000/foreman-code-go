import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('..', import.meta.url))
const pins = JSON.parse(readFileSync(join(scripts, 'ci-go-versions.json'), 'utf8'))
const prologue = `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1], '.cjs');
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ tool, args, cwd: process.cwd(),
  home: process.env.HOME, gopath: process.env.GOPATH, database: process.env.DATABASE_URL,
  environmentFile: process.env.FOREMAN_CODE_API_ENV_FILE, graphqlEnvironmentFile: process.env.GRAPHQL_API_ENV_FILE,
  postgresServiceFile: process.env.PGSERVICEFILE, postgresPasswordFile: process.env.PGPASSFILE,
  postgresBinaryDirectory: process.env.CONFORMANCE_POSTGRES_BIN_DIR, goBinary: process.env.CONFORMANCE_GO_BINARY,
  conformanceResults: process.env.CONFORMANCE_RESULTS_FILE, progressFile: process.env.CI_PROGRESS_FILE,
  temporaryDirectory: process.env.TMPDIR, configDirectory: process.env.XDG_CONFIG_HOME,
  hostRunId: process.env.FOREMAN_CODE_CI_HOST_RUN_ID,
  adminDatabase: process.env.FOREMAN_CODE_CI_TEST_ADMIN_URL,
  scope: process.env.SCOPE, goflags: process.env.GOFLAGS, target: process.env.CONFORMANCE_TARGET }) + '\\n');
`

const goProgram = prologue + `
if (args[0] === 'build' && process.env.FIXTURE_VERIFY_RUNTIME_NODE === '1') {
  const executable = path.join(process.env.HOME, 'runtime-node');
  fs.writeFileSync(executable, "const fs = require('node:fs'); const path = require('node:path');"
    + "const socket = path.join(process.env.TMPDIR, 's'.repeat(70));"
    + "const server = require('node:net').createServer();"
    + "server.on('error', error => { console.error(error); process.exitCode = 1 });"
    + "server.listen(socket, () => server.close(() => fs.writeFileSync(path.join(process.env.CI_STATE, 'node-runtime.json'),"
    + " JSON.stringify({ commonjs: true, socket, homeMode: fs.statSync(process.env.HOME).mode & 0o777,"
    + " rootMode: fs.statSync(path.dirname(process.env.HOME)).mode & 0o777 }))));");
  const result = require('node:child_process').spawnSync(process.execPath, [executable], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) { console.error(result.stderr); process.exit(result.status ?? 1); }
}
if (args[0] === 'env') { console.log('go' + process.env.FIXTURE_GO_VERSION); process.exit(0); }
if (args[0] === 'list') { console.log('example.test/backend'); process.exit(0); }
if (args[0] === process.env.FAIL_GO_COMMAND) process.exit(9);
if (args[0] !== 'test') process.exit(0);
console.error('synthetic Go stderr: ' + (process.env.GO_TEST_MODE || 'normal'));
const Package = 'example.test/backend/runtime';
const event = value => console.log(JSON.stringify({ Time: '2026-10-10T00:00:00Z', Package, ...value }));
event({ Action: 'start' });
if (process.env.GO_TEST_MODE === 'zero') { event({ Action: 'skip' }); process.exit(0); }
event({ Action: 'run', Test: 'TestRuntimeState' });
const failed = process.env.GO_TEST_MODE === 'failed';
event({ Action: 'output', Test: 'TestRuntimeState', Output: failed ? 'runtime_test.go:10: expected ready\\n' : 'runtime ready\\n' });
event({ Action: failed ? 'fail' : 'pass', Test: 'TestRuntimeState', Elapsed: 0.25 });
event({ Action: failed ? 'fail' : 'pass', Elapsed: 0.5 });
process.exit(failed ? 7 : 0);
`

const packageProgram = prologue + `
async function runConformance() {
  const { conformanceFixture, conformanceScenario } = await import(path.join(process.cwd(),
    'scripts/test-support/conformance-report-fixture.mjs'));
  const target = process.env.CONFORMANCE_TARGET;
  const mode = process.env['CONFORMANCE_' + target.toUpperCase() + '_MODE'];
  const options = { target, commitSha: process.env.FIXTURE_COMMIT_SHA, commitSource: 'git' };
  if (process.env.CONFORMANCE_COMMIT_SHA !== undefined) {
    options.commitSha = process.env.CONFORMANCE_COMMIT_SHA;
    options.commitSource = 'environment';
  }
  const failure = { name: 'Error', message: 'fixture health differs' };
  if (mode === 'failed') options.scenarios = [conformanceScenario({ status: 'failed', error: failure })];
  if (mode === 'setup') options.scenarios = [conformanceScenario({ status: 'failed', phase: 'setup', executed: false, error: failure })];
  if (mode === 'zero') options.scenarios = [];
  if (mode === 'truncated') {
    options.scenarios = [];
    options.inventoryScenarios = [conformanceScenario()];
  }
  if (mode === 'partial') options.scenarios = [conformanceScenario(),
    conformanceScenario({ id: 'fixture.event', title: 'Fixture event response', lane: 'E', status: 'failed', error: failure })];
  if (mode === 'coverage') {
    options.coverage = conformanceFixture().report.coverage;
    options.coverage.http.covered = 0;
    options.coverage.http.missing = ['GET /fixture'];
    options.coverage.http.status = 'failed';
    options.coverage.complete = false;
  }
  const ids = args.flatMap((value, index) => value === '--scenario' ? [args[index + 1]] : []);
  if (process.env.CI_AFFECTED_SELECTION_FILE && JSON.parse(fs.readFileSync(process.env.CI_AFFECTED_SELECTION_FILE, 'utf8')).conformanceScenarios?.length) {
    options.inventoryScenarios = [conformanceScenario(), conformanceScenario({ id: 'fixture.event',
      title: 'Fixture event response', lane: 'E' })];
  }
  if (ids.length && !args.includes('--list')) {
    options.scenarios = (options.scenarios ?? [conformanceScenario()]).filter(scenario => ids.includes(scenario.id));
    options.scope = { kind: 'full', lanes: [], scenarioIds: ids, completeSelection: false };
  }
  const { report, inventory } = conformanceFixture(options);
  if (args.includes('--list')) { console.log(JSON.stringify(inventory)); return; }
  if (mode === 'missing') { process.exitCode = 3; return; }
  if (mode === 'malformed') {
    fs.writeFileSync(process.env.CONFORMANCE_RESULTS_FILE, '{');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(process.env.CONFORMANCE_RESULTS_FILE, JSON.stringify(report));
  for (const scenario of report.scenarios) console.log(JSON.stringify({ kind: 'conformance-scenario', ...scenario }));
  console.log(JSON.stringify({ kind: 'conformance-summary', ...report }));
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
function writeTestReport(destination) {
  let file = 'apps/web/src/fast.test.tsx';
  if (process.env.FOREMAN_WEB_TEST_PHASE === 'heavy') file = 'apps/web/src/heavy.test.tsx';
  if (args.includes('@foreman-code/contracts')) file = 'packages/contracts/src/contract.test.ts';
  if (args.includes('--dir') && args.includes('conformance')) file = 'conformance/src/reporting/report.test.ts';
  if (args.includes('--test')) file = 'scripts/tool.test.mjs';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({ testResults: [{ name: file, status: 'passed', startTime: 0, endTime: 20,
    assertionResults: [{ fullName: 'renders the current state', status: 'passed', duration: 20, failureMessages: [] }] }] }));
}
async function main() {
  if (args.includes(process.env.FAIL_PNPM_COMMAND)) { process.exitCode = 9; return; }
  if (args.includes('run') && args[args.indexOf('run') + 1] === 'conformance') return runConformance();
  let destination = args.find(value => value.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
  destination ??= args.find(value => value.startsWith('--test-reporter-destination=') && !value.endsWith('=stdout'))
    ?.slice('--test-reporter-destination='.length);
  if (destination) writeTestReport(destination);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`

// The PostgreSQL installer has its own public tests. Suite fixtures mock that process boundary.
const postgresToolchain = `#!/bin/bash
ci_postgres_environment() {
  export CONFORMANCE_POSTGRES_BIN_DIR="$FOREMAN_CODE_CI_POSTGRES_CACHE/bin"
}
ci_postgres_install() { ci_postgres_environment; postgres-tools install; }
ci_postgres_verify() { postgres-tools verify; }
if [ "\${BASH_SOURCE[0]}" = "$0" ]; then
  case "\${1:-}" in install) ci_postgres_install ;; verify) ci_postgres_verify ;; *) exit 2 ;; esac
fi
`

const dockerProgram = prologue + `
const storage = path.join(process.env.CI_STATE, 'fixture-docker.json');
if (args[0] === 'run') {
  if (process.env.FAIL_DATABASE_START === '1') { console.error('fixture database start failed'); process.exit(1); }
  const name = args[args.indexOf('--name') + 1];
  const [label, owner] = args[args.indexOf('--label') + 1].split('=');
  fs.writeFileSync(path.join(process.env.CI_STATE, 'fixture-docker-started'), '');
  setTimeout(() => {
    fs.writeFileSync(storage, JSON.stringify({ Id: name, Config: { Labels: { [label]: owner } },
      State: { Running: true, Health: { Status: 'healthy' } },
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: process.env.FIXTURE_DATABASE_PORT ?? '55439' }] } } }));
    console.log(name);
  }, Number(process.env.FIXTURE_DATABASE_DELAY_MS ?? 0));
} else if (args[0] === 'inspect') {
  if (!fs.existsSync(storage)) { console.error('No such container'); process.exit(1); }
  console.log('[' + fs.readFileSync(storage, 'utf8') + ']');
} else if (args[0] === 'rm') {
  setTimeout(() => fs.rmSync(storage, { force: true }), Number(process.env.FIXTURE_DATABASE_REMOVE_DELAY_MS ?? 0));
}
else if (args[0] === 'exec') fs.readFileSync(0);
`

function executable(directory, name, program) {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${name}.cjs`)
  writeFileSync(file, `#!${process.execPath}\n${program}`, { mode: 0o755 })
  symlinkSync(file, join(directory, name))
}

export function goCiFixture(t, overrides = {}) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-suite-go-'))
  const imageBin = mkdtempSync('/tmp/fci-go-image-')
  const home = join(directory, 'original-home')
  const state = join(directory, '.logs/state')
  const calls = join(directory, 'calls.jsonl')
  const recordedCalls = () => existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const runtimeRoot = () => {
    const record = join(state, 'runtime-root')
    if (existsSync(record)) return readFileSync(record, 'utf8').trim()
    const last = recordedCalls().findLast(call => /^\/tmp\/fci\.[A-Za-z0-9]{6}\/home$/.test(call.home))
    return last ? dirname(last.home) : undefined
  }
  t.after(() => {
    const runtime = runtimeRoot()
    if (runtime && existsSync(join(runtime, 'ci-state')) && readFileSync(join(runtime, 'ci-state'), 'utf8').trim() === state) {
      rmSync(runtime, { recursive: true, force: true })
    }
    rmSync(directory, { recursive: true, force: true })
    rmSync(imageBin, { recursive: true, force: true })
  })
  const cache = join(directory, 'cache with spaces')
  const postgresCache = join(directory, 'postgres cache with spaces')
  const bin = join(directory, 'bin')
  for (const path of [home, state, bin, join(directory, 'scripts'), join(directory, 'backend'),
    join(directory, 'apps/web'), join(directory, 'apps/api/src'), join(directory, 'conformance')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(home, 'existing-state'), 'untouched')
  writeFileSync(join(directory, 'backend/go.mod'), `module example.test/backend\n\ngo 1.25.0\n\ntoolchain go${pins.go.version}\n`)
  writeFileSync(join(directory, 'apps/api/src/feature.test.ts'), '// Existing selected-file fixture; never executed as a frozen API suite.\n')
  writeFileSync(join(directory, 'conformance/package.json'), JSON.stringify({
    scripts: { conformance: 'fixture', typecheck: 'fixture', lint: 'fixture', test: 'fixture' },
  }))
  writeFileSync(join(directory, 'apps/web/heavy-tests.json'), JSON.stringify({ files: ['src/heavy.test.tsx'] }))
  // Synthetic runtime entries make the selected export planner observable without launching the product.
  for (const file of ['conformance/src/main.ts', 'apps/api/src/server.ts', 'apps/api/src/cli/operatorCredentials.ts']) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), '// Synthetic conformance launcher dependency fixture.\n')
  }
  for (const name of ['ci-suite.sh', 'ci-runtime-state.sh', 'ci-root-suite.mjs', 'ci-go-toolchain.sh', 'ci-go-toolchain-module.mjs', 'ci-go-suite.sh', 'ci-go-versions.json',
    'ci-go-prerequisites.mjs', 'ci-go-test-results.mjs', 'ci-conformance-suite.sh', 'ci-conformance-results.mjs',
    'ci-conformance-report.mjs', 'ci-conformance-gate.mjs', 'test-support/conformance-report-fixture.mjs',
    'ci-go-test-report.mjs', 'ci-report-io.mjs', 'ci-typecheck-cache.mjs',
    'ci-test-results.mjs', 'ci-unit-files.mjs', 'ci-progress-reporter.mjs', 'ci-node-test-reporter.mjs', 'ci-contracts.mjs',
    'ci-affected-run.mjs', 'ci-affected-scope.mjs', 'ci-affected-contracts.mjs', 'ci-files.mjs',
    'ci-native-reports.mjs', 'ci-go-selected-roots.mjs',
    'test-postgres-init.sql']) {
    // A copied CLI keeps its import.meta.url entry guard and repository root inside this fixture.
    mkdirSync(dirname(join(directory, 'scripts', name)), { recursive: true })
    copyFileSync(join(scripts, name), join(directory, 'scripts', name))
  }
  mkdirSync(join(directory, 'packages/contracts/src'), { recursive: true })
  copyFileSync(join(scripts, '../packages/contracts/src/ciImportGraph.mjs'),
    join(directory, 'packages/contracts/src/ciImportGraph.mjs'))
  writeFileSync(join(directory, 'scripts/ci-postgres-toolchain.sh'), postgresToolchain)
  writeFileSync(calls, '')
  for (const name of ['go', 'db', 'postgres', 'scripts-db']) {
    writeFileSync(join(state, `${name}.log`), '')
    writeFileSync(join(state, `${name}.exit`), '0\n')
  }
  executable(join(cache, `toolchains/go${pins.go.version}/bin`), 'go', goProgram)
  executable(join(cache, `toolchains/go${pins.go.version}/bin`), 'gofmt', prologue
    + `if (process.env.UNFORMATTED_GO) console.log(process.env.UNFORMATTED_GO);`)
  executable(join(cache, `tools/staticcheck-${pins.staticcheck.version}/bin`), 'staticcheck', prologue
    + `if (args[0] === '-version') console.log('staticcheck fixture (${pins.staticcheck.version.slice(1)})');
if (process.env.FAIL_STATICCHECK === '1' && args[0] !== '-version') process.exit(6);`)
  executable(bin, 'corepack', packageProgram)
  executable(bin, 'docker', dockerProgram)
  executable(bin, 'postgres-tools', prologue + `
if (args[0] === 'install') console.log('fixture cached PostgreSQL preparation complete');
if (args[0] === process.env.FAIL_POSTGRES_COMMAND) process.exit(8);`)
  executable(bin, 'cc', prologue + `console.log('fixture C compiler');`)
  executable(bin, 'pkg-config', prologue + `console.log('fixture libvips');`)
  executable(imageBin, 'go', prologue + `
if (args[0] === 'env' && args[1] === 'GOVERSION') { console.log('go1.26.8'); process.exit(0); }
console.error('fixture tool download failed'); process.exit(8);`)
  executable(bin, 'git', prologue + `
if (args[0] === 'fetch') process.exit(process.env.CONFORMANCE_CHANGED === 'unknown' ? 1 : 0);
if (args[0] === 'diff') process.exit(process.env.CONFORMANCE_CHANGED === 'yes' ? 1 : 0);
if (args[0] === 'rev-parse') console.log(process.env.FIXTURE_COMMIT_SHA);
if (args[0] === 'ls-files') {
  const files = JSON.parse(process.env.FIXTURE_WEB_FILES ?? '["apps/web/src/fast.test.tsx"]');
  process.stdout.write(files.join('\\0') + '\\0');
}`)
  const environment = { ...process.env, BASH_ENV: '', ENV: '', HOME: home, XDG_CACHE_HOME: '',
    CI: 'true', CI_HOST_RUNNER: '1', CI_STATE: state, FOREMAN_CODE_CI_GO_CACHE: cache, CGO_ENABLED: '1',
    FOREMAN_CODE_CI_POSTGRES_CACHE: postgresCache, FIXTURE_COMMIT_SHA: '1'.repeat(40),
    FIXTURE_CALLS: calls, FIXTURE_GO_VERSION: pins.go.version, PATH: `${bin}${delimiter}${imageBin}${delimiter}${process.env.PATH}`,
    FOREMAN_CODE_CI_HOST_RUN_ID: '',
    SCOPE: 'full', FOREMAN_CODE_CI_RELEASE: '1', SELECTED_FILES: '', SLICE: '', CI_PARTITION: '', CI_EXPECTED_DURATION_MS: '',
    CI_AFFECTED_SELECTION_FILE: '', CI_AFFECTED_VITEST_OUTPUT: '', CI_NATIVE_REPORTS_DIR: '', CI_NATIVE_SELECTOR: '',
    CI_PREREQUISITES_UNTRACKED: '', CI_USER_SYSTEMD: '', CI_PROGRESS_FILE: '', FOREMAN_CODE_CI_CONTRACTS_CACHE: '',
    FOREMAN_CODE_CI_TYPECHECK_CACHE: '', TEST_RESULTS_OUTPUT: join(directory, 'results.json'),
    DURATIONS_OUTPUT: join(directory, 'durations.json'), FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '',
    FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT: '', CONFORMANCE_CHANGED: 'no', CONFORMANCE_GATE: 'incremental',
    CONFORMANCE_MAIN_GO_RESULTS_FILE: '', CONFORMANCE_MAIN_TS_RESULTS_FILE: '', CONFORMANCE_MAIN_COMMIT_SHA: '',
    ...overrides }
  delete environment.NODE_TEST_CONTEXT
  if (!Object.hasOwn(overrides, 'CONFORMANCE_COMMIT_SHA')) delete environment.CONFORMANCE_COMMIT_SHA
  const run = (suite, action = '', extra = {}) => {
    const result = spawnSync('bash', [join(directory, 'scripts/ci-suite.sh'), ...action ? [action] : []],
      { cwd: directory, env: { ...environment, SUITE: suite, ...extra }, encoding: 'utf8', timeout: 20_000 })
    // A sandbox launch error is not a red CI test result.
    assert.equal(result.error, undefined, result.error?.message)
    return result
  }
  return { directory, home, state, cache, postgresCache, environment, run, runtimeRoot,
    runtimeHome: () => join(runtimeRoot(), 'home'), calls: recordedCalls,
    results: () => JSON.parse(readFileSync(environment.TEST_RESULTS_OUTPUT, 'utf8')),
    isolatedHomeExists: () => runtimeRoot() !== undefined && existsSync(join(runtimeRoot(), 'home')) }
}
