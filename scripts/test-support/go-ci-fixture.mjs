import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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
  scope: process.env.SCOPE, goflags: process.env.GOFLAGS, target: process.env.CONFORMANCE_TARGET }) + '\\n');
`

const goProgram = prologue + `
if (args[0] === 'env') { console.log('go' + process.env.FIXTURE_GO_VERSION); process.exit(0); }
if (args[0] === 'list') { console.log('example.test/backend'); process.exit(0); }
if (args[0] === process.env.FAIL_GO_COMMAND) process.exit(9);
if (args[0] !== 'test') process.exit(0);
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
if (args.includes(process.env.FAIL_PNPM_COMMAND)) process.exit(9);
if (args.includes('test:ci')) {
  const target = process.env.CONFORMANCE_TARGET;
  const mode = process.env['CONFORMANCE_' + target.toUpperCase() + '_MODE'];
  if (mode === 'missing') process.exit(3);
  const status = mode === 'failed' ? 'failed' : 'passed';
  const assertions = mode === 'zero' ? [] : [{ fullName: '[SKEL] reads server health', status,
    duration: 10, failureMessages: status === 'failed' ? ['health differs'] : [] }];
  const report = { conformance: { target, complete: true, selected: assertions.length },
    testResults: [{ name: 'conformance/health.test.ts', status, startTime: 0, endTime: 10, assertionResults: assertions }] };
  fs.writeFileSync(process.env.CONFORMANCE_RESULTS_OUTPUT, JSON.stringify(report));
  process.exit(status === 'failed' ? 4 : 0);
}
let destination = args.find(value => value.startsWith('--outputFile.json='))?.slice('--outputFile.json='.length);
destination ??= args.find(value => value.startsWith('--test-reporter-destination=') && !value.endsWith('=stdout'))
  ?.slice('--test-reporter-destination='.length);
if (destination) {
  let file = 'apps/web/src/fast.test.tsx';
  if (process.env.FOREMAN_WEB_TEST_PHASE === 'heavy') file = 'apps/web/src/heavy.test.tsx';
  if (args.includes('@foreman-code/contracts')) file = 'packages/contracts/src/contract.test.ts';
  if (args.includes('--test')) file = 'scripts/tool.test.mjs';
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify({ testResults: [{ name: file, status: 'passed', startTime: 0, endTime: 20,
    assertionResults: [{ fullName: 'renders the current state', status: 'passed', duration: 20, failureMessages: [] }] }] }));
}
`

const dockerProgram = prologue + `
const storage = path.join(process.env.CI_STATE, 'fixture-docker.json');
if (args[0] === 'run') {
  if (process.env.FAIL_DATABASE_START === '1') { console.error('fixture database start failed'); process.exit(1); }
  const name = args[args.indexOf('--name') + 1];
  const owner = args[args.indexOf('--label') + 1].split('=')[1];
  fs.writeFileSync(path.join(process.env.CI_STATE, 'fixture-docker-started'), '');
  setTimeout(() => {
    fs.writeFileSync(storage, JSON.stringify({ Id: name, Config: { Labels: { 'foreman-code.go-ci-database': owner } },
      State: { Running: true, Health: { Status: 'healthy' } },
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: process.env.FIXTURE_DATABASE_PORT ?? '55439' }] } } }));
    console.log(name);
  }, Number(process.env.FIXTURE_DATABASE_DELAY_MS ?? 0));
} else if (args[0] === 'inspect') {
  if (!fs.existsSync(storage)) { console.error('No such container'); process.exit(1); }
  console.log('[' + fs.readFileSync(storage, 'utf8') + ']');
} else if (args[0] === 'rm') fs.rmSync(storage, { force: true });
`

function executable(directory, name, program) {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${name}.cjs`)
  writeFileSync(file, `#!${process.execPath}\n${program}`, { mode: 0o755 })
  symlinkSync(file, join(directory, name))
}

export function goCiFixture(t, overrides = {}) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-suite-go-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'original-home')
  const state = join(directory, '.logs/state')
  const cache = join(directory, 'cache with spaces')
  const bin = join(directory, 'bin')
  for (const path of [home, state, bin, join(directory, 'scripts'), join(directory, 'backend'),
    join(directory, 'apps/web'), join(directory, 'conformance')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(home, 'existing-state'), 'untouched')
  writeFileSync(join(directory, 'backend/go.mod'), `module example.test/backend\n\ngo 1.25.0\n\ntoolchain go${pins.go.version}\n`)
  writeFileSync(join(directory, 'conformance/package.json'), JSON.stringify({ scripts: { 'test:ci': 'fixture' } }))
  writeFileSync(join(directory, 'apps/web/heavy-tests.json'), JSON.stringify({ files: ['src/heavy.test.tsx'] }))
  for (const name of ['ci-suite.sh', 'ci-root-suite.mjs', 'ci-go-toolchain.sh', 'ci-go-suite.sh', 'ci-go-versions.json',
    'ci-go-prerequisites.mjs', 'ci-go-test-results.mjs', 'ci-conformance-results.mjs',
    'ci-go-test-report.mjs', 'ci-report-io.mjs', 'ci-typecheck-cache.mjs',
    'ci-test-results.mjs', 'ci-unit-files.mjs', 'ci-progress-reporter.mjs', 'ci-node-test-reporter.mjs', 'ci-contracts.mjs']) {
    // A copied CLI keeps its import.meta.url entry guard and repository root inside this fixture.
    copyFileSync(join(scripts, name), join(directory, 'scripts', name))
  }
  const calls = join(directory, 'calls.jsonl')
  writeFileSync(calls, '')
  for (const name of ['go', 'db']) {
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
  executable(bin, 'cc', prologue + `console.log('fixture C compiler');`)
  executable(bin, 'pkg-config', prologue + `console.log('fixture libvips');`)
  executable(bin, 'git', prologue + `
if (args[0] === 'fetch') process.exit(process.env.CONFORMANCE_CHANGED === 'unknown' ? 1 : 0);
if (args[0] === 'diff') process.exit(process.env.CONFORMANCE_CHANGED === 'yes' ? 1 : 0);
if (args[0] === 'ls-files') {
  const files = JSON.parse(process.env.FIXTURE_WEB_FILES ?? '["apps/web/src/fast.test.tsx"]');
  process.stdout.write(files.join('\\0') + '\\0');
}`)
  const environment = { ...process.env, BASH_ENV: '', ENV: '', HOME: home, XDG_CACHE_HOME: '',
    CI: 'true', CI_HOST_RUNNER: '1', CI_STATE: state, FOREMAN_CODE_CI_GO_CACHE: cache, CGO_ENABLED: '1',
    FIXTURE_CALLS: calls, FIXTURE_GO_VERSION: pins.go.version, PATH: `${bin}${delimiter}${process.env.PATH}`,
    SCOPE: 'affected', SELECTED_FILES: 's:0', SLICE: '', CI_PARTITION: '', CI_EXPECTED_DURATION_MS: '',
    CI_PREREQUISITES_UNTRACKED: '', CI_USER_SYSTEMD: '', CI_PROGRESS_FILE: '', FOREMAN_CODE_CI_CONTRACTS_CACHE: '',
    FOREMAN_CODE_CI_TYPECHECK_CACHE: '', TEST_RESULTS_OUTPUT: join(directory, 'results.json'),
    DURATIONS_OUTPUT: join(directory, 'durations.json'), FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '',
    FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT: '', CONFORMANCE_CHANGED: 'no', ...overrides }
  delete environment.NODE_TEST_CONTEXT
  const run = (suite, action = '', extra = {}) => {
    const result = spawnSync('bash', [join(directory, 'scripts/ci-suite.sh'), ...action ? [action] : []],
      { cwd: directory, env: { ...environment, SUITE: suite, ...extra }, encoding: 'utf8', timeout: 20_000 })
    // A sandbox launch error is not a red CI test result.
    assert.equal(result.error, undefined, result.error?.message)
    return result
  }
  return { directory, home, state, cache, environment, run,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    results: () => JSON.parse(readFileSync(environment.TEST_RESULTS_OUTPUT, 'utf8')),
    isolatedHomeExists: () => existsSync(join(state, 'home')) }
}
