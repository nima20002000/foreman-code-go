import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-suite.sh', import.meta.url))

test('concurrent host jobs start and remove separate disposable database servers on distinct loopback ports', t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-databases-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callsFile = join(directory, 'docker-calls.jsonl')
  writeFileSync(callsFile, '')
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify({ args, port: process.env.FOREMAN_CODE_CI_DATABASE_PORT }) + '\\n')
if (args.includes('port')) console.log('127.0.0.1:' + process.env.FIXTURE_PORT)
`, { mode: 0o755 })
  const projects = []
  const urls = []
  for (const port of [55001, 55002]) {
    const runId = randomUUID()
    const temporary = join(directory, runId)
    mkdirSync(temporary)
    const environment = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, TMPDIR: temporary,
      FOREMAN_CODE_CI_HOST_RUN_ID: runId, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '',
      FIXTURE_PORT: String(port), CALLS_FILE: callsFile }
    for (const action of ['up', 'down']) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-db.mjs', import.meta.url)), action],
        { env: environment, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    const url = new URL(readFileSync(join(temporary, 'test-database-url'), 'utf8'))
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.port, String(port))
    urls.push(url.href)
    projects.push(`foreman-ci-${runId}`)
  }
  assert.equal(new Set(urls).size, 2)
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  for (const project of projects) {
    assert.ok(calls.some(({ args, port }) => args.includes(project) && args.includes('up') && port === '0'))
    assert.ok(calls.some(({ args }) => args.includes(project) && args.includes('down') && args.includes('--volumes')))
  }
})

function runSuite(t, suite, failCommand = '', scope = 'full', action = '', installedClis = true, selection = undefined,
  hostRunner = false) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-suite-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callsFile = join(directory, 'calls.jsonl')
  writeFileSync(callsFile, '')
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
if (args.at(-1) === process.env.FAIL_COMMAND) process.exit(9)
`, { mode: 0o755 })
  writeFileSync(join(directory, 'node'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'scripts/ci-selection.mjs') {
  const selection = JSON.parse(process.env.RUNNER_SELECTION)
  if (process.env.BASE_COMMIT) {
    require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(['baseCommit', process.env.BASE_COMMIT]) + '\\n')
  }
  require('node:fs').writeFileSync(process.argv.at(-1), JSON.stringify(selection.files))
  console.error(selection.scope === 'full' ? 'Running full suite: ' + (selection.reason || 'Shared CI infrastructure changed.') : 'Selected affected files.')
  console.log(selection.scope)
}
`, { mode: 0o755 })
  writeFileSync(join(directory, 'corepack'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
if (args.at(-1) === process.env.FAIL_COMMAND) process.exit(9)
`, { mode: 0o755 })
  if (installedClis) {
    for (const cli of ['codex', 'claude']) {
      writeFileSync(join(directory, cli), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    }
  } else {
    for (const command of ['bash', 'date']) symlinkSync(`/bin/${command}`, join(directory, command))
    writeFileSync(join(directory, 'npm'), `#!${process.execPath}
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(['npm', ...args]) + '\\n')
if (args.at(-1) === process.env.FAIL_COMMAND) process.exit(9)
`, { mode: 0o755 })
  }
  if (selection && !selection.missingSelector) {
    mkdirSync(join(directory, 'scripts'))
    writeFileSync(join(directory, 'scripts/ci-affected.mjs'), 'export {}')
    writeFileSync(join(directory, 'git'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify(['git', ...process.argv.slice(2)]) + '\\n')
if (process.argv[2] === 'rev-parse') console.log('false')
`, { mode: 0o755 })
  }
  if (selection?.databaseFailure) {
    const state = join(directory, 'state')
    mkdirSync(state)
    writeFileSync(join(state, 'db.log'), 'Database unavailable.\n')
    writeFileSync(join(state, 'db.exit'), '9')
  }
  const result = spawnSync('bash', [script, action], {
    encoding: 'utf8',
    ...(selection ? { cwd: directory } : {}),
    env: { ...process.env, SUITE: suite, SCOPE: selection?.omitScope ? undefined : scope,
      SELECTED_FILES: selection ? '' : 's:1', DEFAULT_BRANCH: 'release/stable', CI_STATE: join(directory, 'state'),
      RUNNER_SELECTION: JSON.stringify(selection),
      BASE_COMMIT: selection?.baseCommit ?? '',
      CI_HOST_RUNNER: hostRunner ? '1' : '0',
      CI_USER_SYSTEMD: '0',
      PATH: installedClis ? `${directory}${delimiter}${process.env.PATH}` : directory,
      CALLS_FILE: callsFile, FAIL_COMMAND: failCommand },
  })
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { result, calls }
}

const contractsBuild = ['--filter', '@foreman-code/contracts', 'build']
test('cloud suites forward an explicit base to selection without fetching the default branch', t => {
  const baseCommit = 'a'.repeat(40)
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'affected', files: ['apps/api/src/value.ts'], baseCommit })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls[0], ['git', 'rev-parse', '--is-shallow-repository'])
  assert.deepEqual(calls[2], ['baseCommit', baseCommit])
  assert.equal(calls.some(call => call[0] === 'git' && call[1] === 'fetch'), false)
  assert.deepEqual(calls[3], ['scripts/ci-affected-run.mjs', 'typecheck', '--files-from', calls[1].at(-1)])
})

test('an invalid explicit base logs the reason and runs the full cloud suite part', t => {
  const reason = 'baseCommit is unavailable or is not an ancestor of the resolved commit.'
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'full', files: [], baseCommit: 'a'.repeat(40), reason })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stderr.includes(`Running full suite: ${reason}`))
  assert.deepEqual(calls.slice(3), [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})

test('omitted scope derives affected files on the cloud runner using the workspace default branch', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'affected', files: ['apps/api/src/value.ts'], omitScope: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls.slice(0, 2), [
    ['git', 'rev-parse', '--is-shallow-repository'],
    ['git', 'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/release/stable:refs/remotes/origin/release/stable'],
  ])
  assert.equal(calls[2][0], 'scripts/ci-selection.mjs')
  assert.equal(calls[2][1], 'typecheck-api')
  assert.equal(calls[2][2], 'refs/remotes/origin/release/stable')
  assert.deepEqual(calls[3], ['scripts/ci-affected-run.mjs', 'typecheck', '--files-from', calls[2].at(-1)])
})
test('a shared infrastructure fallback runs the complete cloud suite part and logs the reason', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { scope: 'full', files: [] })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Running full suite: Shared CI infrastructure changed/)
  assert.deepEqual(calls.slice(3), [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})
test('a repository without a selector runs the full cloud part and logs the reason', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'affected', '', true,
    { missingSelector: true, omitScope: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Running full suite: The repository has no affected selector/)
  assert.deepEqual(calls, [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})
test('explicit full scope bypasses runner selection and runs the complete cloud part', t => {
  const { result, calls } = runSuite(t, 'typecheck-api', '', 'full', '', true,
    { scope: 'affected', files: ['apps/api/src/value.ts'] })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls, [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']])
})
test('a host CI part uses Corepack and the already delegated host service', t => {
  const { result, calls } = runSuite(t, 'unit-api', '', 'full', '', true, undefined, true)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls[0], ['pnpm', ...contractsBuild])
  assert.deepEqual(calls[1], ['scripts/ci-unit-files.mjs', 'select', 'unit-api', ''])
  assert.deepEqual(calls[2].slice(0, 2), ['pnpm', 'test'])
})
test('host preparation installs missing harness CLIs with the cloud package age policy', t => {
  const { result, calls } = runSuite(t, 'unit-api', '', 'full', 'prepare', false)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(calls[0], ['pnpm', 'db:up'])
  assert.equal(calls.length, 2)
  const [command, ...args] = calls[1]
  assert.equal(command, 'npm')
  assert.deepEqual(args.slice(0, 3), ['install', '--global', '--silent'])
  assert.match(args[3], /^--before=\d{4}-\d{2}-\d{2}T/)
  const cutoff = Date.parse(args[3].slice('--before='.length))
  assert.ok(Math.abs(Date.now() - cutoff - 48 * 60 * 60 * 1000) < 60_000)
  assert.deepEqual(args.slice(4), ['@openai/codex', '@anthropic-ai/claude-code'])
})
test('host preparation propagates a missing harness installation failure', t => {
  const { result, calls } = runSuite(t, 'integration', '@anthropic-ai/claude-code', 'full', 'prepare', false)
  assert.equal(result.status, 9)
  assert.equal(calls.length, 2)
})
for (const suite of ['unit', 'unit-api', 'unit-web', 'unit-web-heavy', 'unit-other', 'integration']) {
  test(`${suite} prepares the host database and reuses installed harness CLIs`, t => {
    const { result, calls } = runSuite(t, suite, '', 'full', 'prepare')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [['pnpm', 'db:up']])
  })
  test(`${suite} fails preparation when the database cannot start`, t => {
    const { result, calls } = runSuite(t, suite, 'db:up', 'full', 'prepare')
    assert.equal(result.status, 9)
    assert.deepEqual(calls, [['pnpm', 'db:up']])
  })
}
for (const suite of ['unit-web', 'unit-web-heavy', 'unit-other']) {
  test(`${suite} prepares its disposable database without installing harness CLIs`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected', 'prepare', false)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [['pnpm', 'db:up']])
  })
  test(`${suite} stops before affected tests when its database preparation failed`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected', '', true,
      { scope: 'affected', files: ['apps/web/src/example.test.tsx'], databaseFailure: true })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /Database unavailable/)
    assert.equal(calls.some(call => call[0] === 'scripts/ci-affected-run.mjs'), false)
  })
}
for (const suite of ['install', 'lint-api', 'typecheck-other', 'build-api']) {
  test(`${suite} needs no host database or harness preparation`, t => {
    const { result, calls } = runSuite(t, suite, '', 'full', 'prepare')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [])
  })
}
for (const suite of ['unit-web', 'unit-web-heavy', 'unit-other', 'lint-api', 'lint-other', 'typecheck-api', 'typecheck-other']) {
  test(`${suite} forwards its affected selection to the parent suite runner`, t => {
    const { result, calls } = runSuite(t, suite, '', 'affected')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, [['scripts/ci-affected-run.mjs', suite.split('-')[0], '--indexes', 's:1']])
  })
}
const parts = [
  ['typecheck-api', [contractsBuild, ['--filter', '@foreman-code/api', 'typecheck']]],
  ['typecheck-other', [contractsBuild, ['-r', '--filter', '!@foreman-code/api', '--if-present', 'typecheck']]],
  ['build-api', [contractsBuild, ['--filter', '@foreman-code/api', 'build']]],
  ['build-other', [['-r', '--filter', '!@foreman-code/api', '--if-present', 'build']]],
]

for (const [suite, expected] of parts) {
  test(`${suite} selects its packages and builds contracts once`, t => {
    const { result, calls } = runSuite(t, suite)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls, expected)
  })
}

for (const suite of ['typecheck-api', 'typecheck-other', 'build-api']) {
  test(`${suite} stops when the contracts build fails`, t => {
    const { result, calls } = runSuite(t, suite, 'build')
    assert.equal(result.status, 9)
    assert.deepEqual(calls, [contractsBuild])
  })
}

for (const suite of ['typecheck', 'build']) {
  test(`${suite} retains the complete root suite and its failure status`, t => {
    const { result, calls } = runSuite(t, suite, suite)
    assert.equal(result.status, 9)
    assert.deepEqual(calls, [[suite]])
  })
}

function runNodeBootstrap(t, failedAttempts) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-node-bootstrap-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const callsFile = join(directory, 'calls')
  const shellEnvironment = join(directory, 'shell-environment')
  writeFileSync(callsFile, '')
  writeFileSync(shellEnvironment, '')
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const { parse } = require('yaml')
  const configuration = parse(readFileSync(new URL('../.circleci/config.yml', import.meta.url), 'utf8'))
  const command = configuration.jobs.ci.steps.find(step => step.run?.name === 'Node and pnpm').run.command
  const fixture = `
    attempts=0
    nvm() {
      printf '%s\\n' "nvm $*" >> "$CALLS_FILE"
      if [ "$1" = install ]; then
        attempts=$((attempts + 1))
        if [ "$attempts" -le "$FAILED_ATTEMPTS" ]; then
          echo "Version '$2' not found" >&2
          return 3
        fi
      elif [ "$1" = which ]; then
        printf '%s\\n' "$NODE_BINARY"
      fi
    }
    corepack() { printf '%s\\n' "corepack $*" >> "$CALLS_FILE"; }
    node() { printf '%s\\n' "node $*" >> "$CALLS_FILE"; }
    sleep() { printf '%s\\n' "sleep $*" >> "$CALLS_FILE"; }
    chmod() { :; }
    mkdir() { :; }
    export -f nvm corepack node sleep chmod mkdir
  `
  const result = spawnSync('bash', ['-ec', fixture + command], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
    env: { ...process.env, CALLS_FILE: callsFile, FAILED_ATTEMPTS: String(failedAttempts),
      NODE_BINARY: process.execPath, BASH_ENV: shellEnvironment },
  })
  return { result, calls: readFileSync(callsFile, 'utf8').trim().split('\n'),
    shellEnvironment: readFileSync(shellEnvironment, 'utf8') }
}

test('cloud Node bootstrap recovers from a transient version lookup failure using the same pinned version', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 1)
  assert.equal(result.status, 0, result.stderr)
  const installs = calls.filter(call => call.startsWith('nvm install '))
  assert.deepEqual(installs, ['nvm install 22.23.2', 'nvm install 22.23.2'])
  assert.ok(calls.includes('nvm which 22.23.2'))
  assert.ok(calls.includes('corepack enable'))
  assert.ok(calls.includes('node --version'))
  assert.ok(shellEnvironment.includes(process.execPath.slice(0, process.execPath.lastIndexOf('/'))))
})

test('cloud Node bootstrap stops after three failed installs before enabling the package manager', t => {
  const { result, calls, shellEnvironment } = runNodeBootstrap(t, 10)
  assert.equal(result.status, 3)
  assert.equal(calls.filter(call => call === 'nvm install 22.23.2').length, 3)
  assert.equal(calls.some(call => call.startsWith('corepack ')), false)
  assert.equal(shellEnvironment, '')
  assert.match(result.stderr, /Version '22\.23\.2' not found/)
})
