import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CI_TEST_RESULT_LIMITS, ciTestResults, writeCiTestResults } from './ci-test-results.mjs'

const temporary = t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-test-results-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('merges Vitest reports into repository files with per-test status, duration and failure', () => {
  const root = resolve('results-fixture')
  const results = ciTestResults([{ testResults: [
    { name: resolve(root, 'apps/api/test/a.test.ts'), status: 'failed', startTime: 100, endTime: 350, assertionResults: [
      { fullName: 'a saves', status: 'passed', duration: 12 },
      { fullName: 'a rejects', status: 'failed', duration: 30, failureMessages: ['\u001b[31mAssertionError\u001b[39m: expected 1 to be 2\n  at a.test.ts:4'] },
    ] },
  ] }, { testResults: [
    { name: 'apps/api/test/b.integration.test.ts', status: 'passed', startTime: 0, endTime: 20, assertionResults: [
      { title: 'b waits', status: 'pending' }, { fullName: 'b later', status: 'todo' },
    ] },
  ] }], root)
  assert.deepEqual(results, { summary: { passed: 1, failed: 1, skipped: 2 }, truncated: false, files: [
    { file: 'apps/api/test/a.test.ts', status: 'failed', durationMs: 250, tests: [
      { name: 'a saves', status: 'passed', durationMs: 12 },
      { name: 'a rejects', status: 'failed', durationMs: 30, message: 'AssertionError: expected 1 to be 2\n  at a.test.ts:4' }] },
    { file: 'apps/api/test/b.integration.test.ts', status: 'skipped', durationMs: 20, tests: [
      { name: 'b waits', status: 'skipped', durationMs: null }, { name: 'b later', status: 'skipped', durationMs: null }] },
  ] })
})

test('keeps failed tests first within the bounds and still counts every test', () => {
  const passing = Array.from({ length: CI_TEST_RESULT_LIMITS.files + 20 }, (_, index) => ({
    name: `apps/web/src/p${String(index).padStart(3, '0')}.test.tsx`, status: 'passed', startTime: 0, endTime: 1,
    assertionResults: Array.from({ length: 3 }, (_, test) => ({ fullName: `p${index} case ${test} ${'x'.repeat(300)}`,
      status: 'passed', duration: 1 })) }))
  const failing = { name: 'apps/web/src/z.test.tsx', status: 'failed', startTime: 0, endTime: 1,
    assertionResults: [{ fullName: 'z breaks', status: 'failed', duration: 1, failureMessages: ['y'.repeat(1000)] }] }
  const results = ciTestResults([{ testResults: [...passing, failing] }], '/')
  const kept = results.files.flatMap(file => file.tests)
  assert.equal(results.truncated, true)
  assert.deepEqual(results.summary, { passed: passing.length * 3, failed: 1, skipped: 0 })
  assert.equal(results.files.length, CI_TEST_RESULT_LIMITS.files)
  assert.equal(results.files[0].file, 'apps/web/src/z.test.tsx')
  assert.equal(kept.length, CI_TEST_RESULT_LIMITS.tests)
  assert.equal(kept[0].name, 'z breaks')
  assert.equal(kept[0].message.length, CI_TEST_RESULT_LIMITS.message)
  assert.ok(kept.every(test => test.name.length <= CI_TEST_RESULT_LIMITS.name))
  assert.ok(Buffer.byteLength(JSON.stringify(results)) < 512 * 1024)
})

test('writes nothing when no report can be read', t => {
  const directory = temporary(t)
  const output = join(directory, 'out', 'test-results.json')
  assert.equal(writeCiTestResults(output, [join(directory, 'missing.json')]), false)
  assert.equal(existsSync(output), false)
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ testResults: [] }))
  assert.equal(writeCiTestResults(output, [join(directory, 'missing.json'), join(directory, 'report.json')]), true)
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { summary: { passed: 0, failed: 0, skipped: 0 }, truncated: false, files: [] })
})

test('a unit slice records its test results without handing the results path to the tests', t => {
  const directory = temporary(t)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = join(directory, 'reports', 'test-results.json')
  mkdirSync(join(directory, 'reports'))
  writeFileSync(join(directory, 'pnpm'), `#!${process.execPath}
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const args = process.argv.slice(2)
if (args.includes('build')) process.exit(0)
writeFileSync(process.env.SEEN_FILE, JSON.stringify(process.env.TEST_RESULTS_OUTPUT ?? null))
const report = args.find(arg => arg.startsWith('--outputFile.json=')).split('=').slice(1).join('=')
const file = args.find(arg => arg.endsWith('.test.tsx') || arg.endsWith('.test.ts'))
writeFileSync(report, JSON.stringify({ testResults: [{ name: resolve(file), startTime: 100, endTime: 175, status: 'failed',
  assertionResults: [{ fullName: 'renders', status: 'failed', duration: 9, failureMessages: ['broken'] }] }] }))
process.exit(3)
`, { mode: 0o755 })
  const result = spawnSync('bash', ['scripts/ci-suite.sh'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, SUITE: 'unit-web', SCOPE: 'full', SLICE: '1/3', DURATIONS_INPUT: '',
      DURATIONS_OUTPUT: join(directory, 'reports', 'durations.json'), TEST_RESULTS_OUTPUT: output,
      CI_STATE: join(directory, 'state'), PATH: `${directory}${delimiter}${process.env.PATH}`,
      SEEN_FILE: join(directory, 'seen.json'), CI_HOST_RUNNER: '0' },
  })
  assert.equal(result.status, 3, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(directory, 'seen.json'), 'utf8')), null)
  const results = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual(results.summary, { passed: 0, failed: 1, skipped: 0 })
  assert.equal(results.files.length, 1)
  assert.ok(results.files[0].file.startsWith('apps/web/src/'))
  assert.deepEqual(results.files[0].tests, [{ name: 'renders', status: 'failed', durationMs: 9, message: 'broken' }])
})
