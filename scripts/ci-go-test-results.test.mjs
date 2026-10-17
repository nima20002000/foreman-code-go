import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GoTestReport } from './ci-go-test-report.mjs'
import { writeGoTestResults } from './ci-go-test-results.mjs'
import { ciTestResults, CI_TEST_RESULT_LIMITS } from './ci-test-results.mjs'

const modulePath = 'example.test/foreman/backend'
const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fileURLToPath(new URL('./ci-go-test-results.mjs', import.meta.url))
const event = (Action, Package = `${modulePath}/config`, Test, fields = {}) => ({ Action, Package,
  ...(Test ? { Test } : {}), ...fields })
const encoded = events => events.map(value => JSON.stringify(value)).join('\n') + '\n'

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'go-ci-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function resultFor(events, options = {}) {
  const collector = new GoTestReport({ modulePath, ...options })
  for (const line of encoded(events).split('\n')) collector.addLine(line)
  return collector.finish()
}

function runCli(t, input) {
  const directory = temporary(t)
  const output = join(directory, 'results.json')
  const durations = join(directory, 'durations.json')
  const progress = join(directory, 'progress.jsonl')
  const env = { ...process.env, HOME: directory, CI_STATE: join(directory, 'state'), CI_PROGRESS_FILE: progress,
    TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' }
  delete env.NODE_TEST_CONTEXT
  const processResult = spawnSync(process.execPath, [cli, '--module', modulePath, '--output', output,
    '--durations', durations], { cwd: root, input, encoding: 'utf8',
    env })
  assert.ifError(processResult.error)
  return { processResult, output, durations, progress }
}

test('interleaved packages retain all test and subtest statuses and real elapsed milliseconds', () => {
  const a = `${modulePath}/config`
  const b = `${modulePath}/storage`
  const { report, selected, executed, failed } = resultFor([
    event('start', a), event('start', b), event('run', a, 'TestConfig'), event('run', b, 'TestPool'),
    event('pause', b, 'TestPool'), event('run', a, 'TestConfig/defaults'),
    event('pass', a, 'TestConfig/defaults', { Elapsed: 0.025 }),
    event('run', a, 'TestConfig/optional'), event('skip', a, 'TestConfig/optional', { Elapsed: 0 }),
    event('pass', a, 'TestConfig', { Elapsed: 0.035 }), event('pass', a, undefined, { Elapsed: 0.040 }),
    event('cont', b, 'TestPool'), event('pass', b, 'TestPool', { Elapsed: 0.007 }),
    event('pass', b, undefined, { Elapsed: 0.060 }),
  ])
  assert.equal(selected, 4)
  assert.equal(executed, 3)
  assert.equal(failed, false)
  const results = ciTestResults([report], root)
  assert.deepEqual(results.summary, { passed: 3, failed: 0, skipped: 1 })
  assert.equal(results.files.find(file => file.file === 'backend/config').durationMs, 40)
  const tests = results.files.flatMap(file => file.tests)
  assert.equal(tests.find(test => test.name === 'TestConfig/defaults').durationMs, 25)
  assert.equal(tests.find(test => test.name === 'TestConfig/optional').durationMs, 0)
})

test('failure output keeps real Go file/line locations without inventing columns', () => {
  const { report, failed } = resultFor([event('start'), event('run', undefined, 'TestConfig'),
    event('output', undefined, 'TestConfig', { Output: '=== RUN   TestConfig\n', OutputType: 'frame' }),
    event('output', undefined, 'TestConfig', { Output: '    config_test.go:17: expected saved value\n' }),
    event('fail', undefined, 'TestConfig', { Elapsed: 0.012 }), event('fail', undefined, undefined, { Elapsed: 0.017 })])
  assert.equal(failed, true)
  const result = ciTestResults([report], root)
  assert.equal(result.files[0].tests[0].location, 'backend/config/config_test.go:17')
  assert.match(result.files[0].tests[0].message, /expected saved value/)
})

test('invalid and unfinished Go streams are rejected through the public collector', () => {
  for (const events of [
    [event('start')],
    [event('start'), event('run', undefined, 'TestConfig'), event('fail')],
    [event('start'), event('run', undefined, 'TestConfig'), event('pass', undefined, 'TestConfig')],
    [event('run', undefined, 'TestConfig')],
    [event('start'), event('run', undefined, 'TestConfig'), event('fail', undefined, 'TestConfig'), event('pass')],
    [event('start'), event('run', undefined, 'TestConfig'), event('pass', undefined, 'TestConfig', { Elapsed: -1 })],
  ]) assert.throws(() => resultFor(events), /Go/)
  const collector = new GoTestReport({ modulePath })
  assert.throws(() => collector.addLine('{broken'), /Invalid Go JSON/)
})

test('empty and skipped-only Go streams preserve honest selected and executed counts', () => {
  const empty = resultFor([event('start'), event('skip')])
  assert.equal(empty.selected, 0)
  assert.equal(empty.executed, 0)
  const skipped = resultFor([event('start'), event('run', undefined, 'TestOptional'),
    event('skip', undefined, 'TestOptional'), event('pass')])
  assert.equal(skipped.selected, 1)
  assert.equal(skipped.executed, 0)
  assert.equal(skipped.report.testResults[0].assertionResults[0].status, 'skipped')
})

test('the streaming CLI publishes failures and watchdog progress while returning a failing status', t => {
  const { processResult, output, durations, progress } = runCli(t, encoded([
    event('start'), event('run', undefined, 'TestConfig'),
    event('output', undefined, 'TestConfig', { Output: 'config_test.go:4: saved value differs\n' }),
    event('fail', undefined, 'TestConfig', { Elapsed: 0 }), event('fail', undefined, undefined, { Elapsed: 0.2 }),
  ]))
  assert.equal(processResult.status, 1, processResult.stderr)
  assert.match(processResult.stdout, /saved value differs/)
  assert.match(processResult.stdout, /1 selected.*1 executed/)
  assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
    { passed: 0, failed: 1, skipped: 0 })
  assert.deepEqual(JSON.parse(readFileSync(durations, 'utf8')), {})
  const events = readFileSync(progress, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.some(event => event.type === 'start' && event.kind === 'test' && event.name === 'TestConfig'))
  assert.ok(events.some(event => event.type === 'finish' && event.kind === 'test'))
})

test('a package failure after successful tests is red without adding a fabricated test', t => {
  const { processResult, output } = runCli(t, encoded([event('start'), event('run', undefined, 'TestConfig'),
    event('pass', undefined, 'TestConfig', { Elapsed: 0.01 }),
    event('output', undefined, undefined, { Output: 'TestMain cleanup failed\n' }),
    event('fail', undefined, undefined, { Elapsed: 0.02 })]))
  assert.equal(processResult.status, 1)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
  assert.deepEqual(results.summary, { passed: 1, failed: 0, skipped: 0 })
  assert.equal(results.files[0].status, 'failed')
  assert.match(processResult.stdout, /TestMain cleanup failed/)
})

test('interleaved build diagnostics and build failures stay red when no test could start', t => {
  const { processResult, output } = runCli(t, encoded([
    { Action: 'build-output', ImportPath: `${modulePath}/config [${modulePath}/config.test]`, Output: 'undefined: setting\n' },
    { Action: 'build-fail', ImportPath: `${modulePath}/config [${modulePath}/config.test]` },
    event('start'), event('fail', undefined, undefined, { FailedBuild: `${modulePath}/config [${modulePath}/config.test]` }),
  ]))
  assert.equal(processResult.status, 1)
  assert.match(processResult.stdout, /undefined: setting/)
  assert.match(processResult.stderr, /zero selected Go tests/)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
  assert.deepEqual(results.summary, { passed: 0, failed: 0, skipped: 0 })
  assert.equal(results.files[0].status, 'failed')
})

for (const [name, input] of [
  ['empty input', ''], ['blank input', ' \n\n'],
  ['no test files', encoded([event('start'), event('skip')])],
  ['a filter selecting no tests', encoded([event('start'), event('pass', undefined, undefined, { Elapsed: 0.01 })])],
]) {
  test(`zero selected Go tests fail: ${name}`, t => {
    const { processResult, output } = runCli(t, input)
    assert.equal(processResult.status, 1, processResult.stderr)
    assert.match(processResult.stderr, /zero selected Go tests/)
    assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
      { passed: 0, failed: 0, skipped: 0 })
  })
}

test('a skipped-only Go suite remains red with its real skipped count', t => {
  const { processResult, output } = runCli(t, encoded([event('start'), event('run', undefined, 'TestNeedsService'),
    event('skip', undefined, 'TestNeedsService', { Elapsed: 0 }), event('pass', undefined, undefined, { Elapsed: 0.01 })]))
  assert.equal(processResult.status, 1)
  assert.match(processResult.stderr, /zero executed Go tests/)
  assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
    { passed: 0, failed: 0, skipped: 1 })
})

for (const [name, input] of [
  ['malformed JSON', '{broken\n'],
  ['unknown event action', encoded([event('mystery')])],
  ['missing package terminal', encoded([event('start'), event('run', undefined, 'TestConfig'), event('pass', undefined, 'TestConfig')])],
  ['missing test terminal', encoded([event('start'), event('run', undefined, 'TestConfig'), event('fail')])],
  ['test outside a package', encoded([event('run', undefined, 'TestConfig')])],
  ['duplicate test result', encoded([event('start'), event('run', undefined, 'TestConfig'), event('pass', undefined, 'TestConfig'), event('fail', undefined, 'TestConfig')])],
  ['invalid elapsed seconds', encoded([event('start'), event('run', undefined, 'TestConfig'), event('pass', undefined, 'TestConfig', { Elapsed: -1 })])],
]) {
  test(`malformed or incomplete Go input never publishes a partial report: ${name}`, t => {
    const { processResult, output, durations } = runCli(t, input)
    assert.equal(processResult.status, 1)
    assert.equal(existsSync(output), false)
    assert.equal(existsSync(durations), false)
  })
}

test('measured zero seconds wins over wall timestamps and only successful packages supply durations', async t => {
  const directory = temporary(t)
  const output = join(directory, 'results.json')
  const durations = join(directory, 'durations.json')
  const input = encoded([
    event('start', modulePath, undefined, { Time: '2026-10-17T15:00:00Z' }),
    event('run', modulePath, 'TestMain', { Time: '2026-10-17T15:00:00Z' }),
    event('pass', modulePath, 'TestMain', { Time: '2026-10-17T15:00:01Z', Elapsed: 0 }),
    event('pass', modulePath, undefined, { Elapsed: 1.25 }),
  ])
  const { report } = await writeGoTestResults(Readable.from([input]), { modulePath, output, durations })
  assert.equal(report.testResults[0].assertionResults[0].duration, 0)
  assert.deepEqual(JSON.parse(readFileSync(durations, 'utf8')), { backend: 1250 })
})

test('bounded CI results retain full Go counts and prioritize a failure after many passes', () => {
  const count = CI_TEST_RESULT_LIMITS.tests + 5
  const events = [event('start')]
  for (let index = 0; index < count; index++) {
    events.push(event('run', undefined, `TestCase${index}`), event('pass', undefined, `TestCase${index}`, { Elapsed: 0 }))
  }
  events.push(event('run', undefined, 'TestLastFailure'), event('fail', undefined, 'TestLastFailure', { Elapsed: 0 }), event('fail'))
  const { report, selected } = resultFor(events)
  const results = ciTestResults([report], root)
  assert.equal(selected, count + 1)
  assert.deepEqual(results.summary, { passed: count, failed: 1, skipped: 0 })
  assert.equal(results.truncated, true)
  assert.equal(results.files[0].tests.length, CI_TEST_RESULT_LIMITS.tests)
  assert.ok(results.files[0].tests.some(test => test.name === 'TestLastFailure' && test.status === 'failed'))
})
