import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-suite.sh', import.meta.url))

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
  require('node:fs').writeFileSync(process.argv.at(-1), JSON.stringify(selection.files))
  console.error(selection.scope === 'full' ? 'Running full suite: Shared CI infrastructure changed.' : 'Selected affected files.')
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
  const result = spawnSync('bash', [script, action], {
    encoding: 'utf8',
    ...(selection ? { cwd: directory } : {}),
    env: { ...process.env, SUITE: suite, SCOPE: selection?.omitScope ? undefined : scope,
      SELECTED_FILES: selection ? '' : 's:1', DEFAULT_BRANCH: 'release/stable', CI_STATE: join(directory, 'state'),
      RUNNER_SELECTION: JSON.stringify(selection),
      CI_HOST_RUNNER: hostRunner ? '1' : '0',
      PATH: installedClis ? `${directory}${delimiter}${process.env.PATH}` : directory,
      CALLS_FILE: callsFile, FAIL_COMMAND: failCommand },
  })
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { result, calls }
}

const contractsBuild = ['--filter', '@foreman-code/contracts', 'build']
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
for (const suite of ['unit', 'unit-api', 'integration']) {
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
for (const suite of ['install', 'unit-web', 'unit-web-heavy', 'unit-other', 'lint-api', 'typecheck-other', 'build-api']) {
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
