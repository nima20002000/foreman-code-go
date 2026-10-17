import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformanceResults, conformanceSummary } from './ci-conformance-results.mjs'
import { ciTestResults, CI_TEST_RESULT_LIMITS } from './ci-test-results.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fileURLToPath(new URL('./ci-conformance-results.mjs', import.meta.url))
const scenario = (fullName, status = 'passed', duration = 12) => ({ fullName, status, duration })

function fixture(assertions = [scenario('[SKEL] responds to health')], target = 'go') {
  return { conformance: { target, selected: assertions.length, complete: true }, numTotalTests: assertions.length,
    testResults: [{ name: 'conformance/test/http.test.ts', status: 'passed', startTime: 100, endTime: 180,
      assertionResults: assertions }] }
}

function runCli(t, report, target = 'go') {
  const directory = mkdtempSync(join(tmpdir(), 'conformance-ci-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'input.json')
  const output = join(directory, 'output.json')
  const durations = join(directory, 'durations.json')
  writeFileSync(input, typeof report === 'string' ? report : JSON.stringify(report))
  const env = { ...process.env, HOME: directory, CI_STATE: join(directory, 'state'), CI_PROGRESS_FILE: '',
    TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' }
  delete env.NODE_TEST_CONTEXT
  const processResult = spawnSync(process.execPath, [cli, '--target', target, '--input', input, '--output', output,
    '--durations', durations], { cwd: root, encoding: 'utf8', env })
  assert.ifError(processResult.error)
  return { processResult, output, durations }
}

test('conformance groups scenarios by target and owner with real durations and readable complete lane totals', () => {
  const input = fixture([scenario('[SKEL] responds to health'), scenario('[E] schedules a workflow', 'failed', 30),
    scenario('[E] cancels a workflow', 'pending', null), scenario('[R] pairs an isolated worker', 'passed', 40)])
  input.testResults[0].status = 'failed'
  const converted = conformanceResults(input, 'go')
  assert.equal(converted.selected, 4)
  assert.equal(converted.executed, 3)
  assert.equal(converted.failed, true)
  assert.deepEqual(converted.totals.E, { passed: 0, failed: 1, skipped: 1 })
  const results = ciTestResults([converted.report], root)
  assert.deepEqual(results.summary, { passed: 2, failed: 1, skipped: 1 })
  assert.ok(results.files.every(file => file.file.startsWith('conformance/go/')))
  assert.equal(results.files.find(file => file.file === 'conformance/go/SKEL').status, 'passed')
  assert.equal(results.files.find(file => file.file === 'conformance/go/E').status, 'failed')
  assert.equal(results.files.flatMap(file => file.tests).find(test => test.name === '[E] schedules a workflow').durationMs, 30)
  assert.match(conformanceSummary(converted, 'go'), /E: 0\/2 passed; 1 failed; 1 skipped/)
  assert.match(conformanceSummary(converted, 'go'), /A2: 0\/0 passed/)
})

test('conformance conversion preserves runner failures and rejects unfinished or inconsistent counts', () => {
  const globalFailure = fixture()
  globalFailure.success = false
  const failed = conformanceResults(globalFailure, 'go')
  assert.equal(failed.failed, true)
  assert.equal(failed.selected, 1)
  assert.equal(failed.executed, 1)
  assert.match(failed.diagnostics[0], /failure outside scenario results/)
  const contradiction = fixture([scenario('[SKEL] responds to health', 'failed')])
  contradiction.success = true
  assert.throws(() => conformanceResults(contradiction, 'go'), /Inconsistent/)
  const unfinished = fixture()
  unfinished.conformance.complete = false
  assert.throws(() => conformanceResults(unfinished, 'go'), /complete/)
  const missing = fixture()
  missing.conformance.selected++
  assert.throws(() => conformanceResults(missing, 'go'), /count mismatch/)
  const skipped = conformanceResults(fixture([scenario('[H] uses the configured SDK', 'pending', null)]), 'go')
  assert.equal(skipped.selected, 1)
  assert.equal(skipped.executed, 0)
})

test('Go and TypeScript conformance reports never overwrite each other in the existing CI merger', () => {
  const go = conformanceResults(fixture(), 'go')
  const ts = conformanceResults(fixture(undefined, 'ts'), 'ts')
  const result = ciTestResults([go.report, ts.report], root)
  assert.deepEqual(result.summary, { passed: 2, failed: 0, skipped: 0 })
  assert.deepEqual(result.files.map(file => file.file), ['conformance/go/SKEL', 'conformance/ts/SKEL'])
})

test('conformance CLI saves successful scenario results and measured owning-lane wall durations', t => {
  const { processResult, output, durations } = runCli(t, fixture())
  assert.equal(processResult.status, 0, processResult.stderr)
  assert.match(processResult.stdout, /Conformance go: 1\/1 passed.*1 executed/)
  assert.match(processResult.stdout, /SKEL: 1\/1 passed/)
  assert.deepEqual(JSON.parse(readFileSync(durations, 'utf8')), { 'conformance/go/SKEL': 80 })
  assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
    { passed: 1, failed: 0, skipped: 0 })
})

test('conformance scenario failures return red and remain visible as individual failures', t => {
  const report = fixture([scenario('[E] resumes a workflow', 'failed', 7)])
  report.testResults[0].status = 'failed'
  report.testResults[0].assertionResults[0].failureMessages = ['persisted run status differs']
  const { processResult, output } = runCli(t, report)
  assert.equal(processResult.status, 1)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
  assert.equal(results.files[0].tests[0].message, 'persisted run status differs')
  assert.deepEqual(results.summary, { passed: 0, failed: 1, skipped: 0 })
})

test('a runner-level failure stays red even when every recorded scenario passed', t => {
  const report = fixture()
  report.success = false
  const { processResult, output } = runCli(t, report)
  assert.equal(processResult.status, 1)
  assert.match(processResult.stderr, /failure outside scenario results/)
  assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
    { passed: 1, failed: 0, skipped: 0 })
})

test('a successful runner flag cannot conceal an assertion-level failure', t => {
  const report = fixture([scenario('[E] saves a workflow', 'failed')])
  report.success = true
  const { processResult, output } = runCli(t, report)
  assert.equal(processResult.status, 1)
  assert.match(processResult.stderr, /Inconsistent conformance report/)
  assert.equal(existsSync(output), false)
})

for (const [name, report, error] of [
  ['no scenarios', fixture([]), /zero selected scenarios/],
  ['only skipped scenarios', fixture([scenario('[H] starts a harness', 'skipped', null)]), /zero executed scenarios/],
]) {
  test(`conformance never passes without executed scenarios: ${name}`, t => {
    const { processResult, output } = runCli(t, report)
    assert.equal(processResult.status, 1)
    assert.match(processResult.stderr, error)
    const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
    assert.equal(results.summary.passed, 0)
    assert.equal(results.summary.failed, 0)
  })
}

for (const [name, modify, error] of [
  ['missing completion', report => { delete report.conformance.complete }, /complete conformance report/],
  ['wrong target', report => { report.conformance.target = 'ts' }, /requested target/],
  ['missing scenario', report => { report.conformance.selected++ }, /scenario count mismatch/],
  ['mismatched Vitest total', report => { report.numTotalTests++ }, /scenario count mismatch/],
  ['duplicate scenario', report => { report.testResults[0].assertionResults.push(scenario('[SKEL] responds to health')) }, /Duplicate conformance scenario/],
  ['missing owner', report => { report.testResults[0].assertionResults[0].fullName = 'responds to health' }, /owning \[LANE\]/],
  ['unfinished scenario', report => { report.testResults[0].assertionResults[0].status = 'running' }, /Unfinished conformance scenario/],
  ['missing duration', report => { delete report.testResults[0].assertionResults[0].duration }, /measured duration/],
]) {
  test(`invalid conformance reports never publish partial results: ${name}`, t => {
    const report = fixture()
    modify(report)
    const { processResult, output } = runCli(t, report)
    assert.equal(processResult.status, 1)
    assert.match(processResult.stderr, error)
    assert.equal(existsSync(output), false)
  })
}

test('lane totals count all scenarios even when the bounded CI report truncates visible tests', () => {
  const count = CI_TEST_RESULT_LIMITS.tests + 10
  const converted = conformanceResults(fixture(Array.from({ length: count }, (_, index) => scenario(`[E] scenario ${index}`))), 'go')
  const results = ciTestResults([converted.report], root)
  assert.equal(results.truncated, true)
  assert.equal(results.summary.passed, count)
  assert.equal(results.files[0].tests.length, CI_TEST_RESULT_LIMITS.tests)
  assert.match(conformanceSummary(converted, 'go'), new RegExp(`E: ${count}/${count} passed`))
})
