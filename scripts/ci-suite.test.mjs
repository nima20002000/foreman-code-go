import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-suite.sh', import.meta.url))

function runSuite(t, suite, failCommand = '', scope = 'full', action = '', installedClis = true) {
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
  const result = spawnSync('bash', [script, action], {
    encoding: 'utf8',
    env: { ...process.env, SUITE: suite, SCOPE: scope, SELECTED_FILES: 's:1', CI_STATE: join(directory, 'state'),
      PATH: installedClis ? `${directory}${delimiter}${process.env.PATH}` : directory,
      CALLS_FILE: callsFile, FAIL_COMMAND: failCommand },
  })
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { result, calls }
}

const contractsBuild = ['--filter', '@foreman-code/contracts', 'build']
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
