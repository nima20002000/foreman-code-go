import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { conformanceResults, conformanceSummary } from './ci-conformance-results.mjs'
import { ciTestResults, CI_TEST_RESULT_LIMITS } from './ci-test-results.mjs'
import { conformanceFixture, conformanceScenario } from './test-support/conformance-report-fixture.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = fileURLToPath(new URL('./ci-conformance-results.mjs', import.meta.url))
const failure = { name: 'AssertionError', message: 'Persisted fixture state differs' }

function runCli(t, fixture, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'conformance-ci-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = join(directory, 'raw.json')
  const inventory = join(directory, 'inventory.json')
  const output = options.overwriteRaw ? input : join(directory, 'normalized.json')
  const durations = join(directory, 'durations.json')
  const verdict = join(directory, 'full-verdict.json')
  const inputText = options.inputText ?? JSON.stringify(fixture.report)
  writeFileSync(input, inputText)
  writeFileSync(inventory, options.inventoryText ?? JSON.stringify(fixture.inventory))
  const env = { ...process.env, HOME: directory, CI_STATE: join(directory, 'state'), CI_PROGRESS_FILE: '',
    TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '' }
  delete env.NODE_TEST_CONTEXT
  const args = [cli, '--target', fixture.expected.target, '--commit', fixture.expected.commitSha,
    '--commit-source', fixture.expected.commitSource, '--input', input, '--output', output,
    '--durations', durations, '--verdict-output', verdict]
  if (!options.omitInventory) args.push('--inventory', inventory)
  const processResult = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env })
  assert.ifError(processResult.error)
  return { processResult, input, inputText, output, inventory, durations, verdict }
}

test('conformance adapts executed cases and setup diagnostics while retaining full raw lane totals', () => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario(),
    conformanceScenario({ id: 'fixture.workflow', title: 'Fixture workflow response', lane: 'E', status: 'failed',
      durationMs: 30, error: failure }),
    conformanceScenario({ id: 'fixture.harness', title: 'Fixture harness setup', lane: 'H', status: 'failed',
      phase: 'setup', executed: false, durationMs: 5, error: { name: 'Error', message: 'Fixture binary unavailable' } }),
    conformanceScenario({ id: 'fixture.worker', title: 'Fixture worker cleanup', lane: 'R', status: 'failed',
      phase: 'cleanup', durationMs: 40, error: failure }),
  ] })
  const before = structuredClone(fixture.report)
  const converted = conformanceResults(fixture.report, fixture.expected)
  assert.equal(converted.rawReport, fixture.report)
  assert.deepEqual(fixture.report, before)
  assert.equal(converted.selected, 4)
  assert.equal(converted.executed, 3)
  assert.deepEqual(converted.lanes.H, { total: 1, passed: 0, failed: 1, skipped: 0 })
  const results = ciTestResults([converted.report], root)
  assert.deepEqual(results.summary, { passed: 1, failed: 2, skipped: 0 })
  assert.ok(results.files.every(file => file.file.startsWith('conformance/go/')))
  assert.equal(results.files.find(file => file.file === 'conformance/go/SKEL').status, 'passed')
  const setup = results.files.find(file => file.file === 'conformance/go/H')
  assert.equal(setup.status, 'failed')
  assert.deepEqual(setup.tests, [])
  const cleanup = results.files.find(file => file.file === 'conformance/go/R').tests[0]
  assert.equal(cleanup.durationMs, 40)
  assert.match(cleanup.name, /fixture.worker: Fixture worker cleanup/)
  assert.match(cleanup.message, /cleanup: AssertionError/)
  assert.match(converted.diagnostics.join('\n'), /fixture.harness.*not executed.*binary unavailable/)
  assert.match(conformanceSummary(converted), /H: 0\/1 passed; 1 failed; 0 executed; 1 setup failures/)
  assert.match(conformanceSummary(converted), /A2: 0\/0 passed/)
})

test('raw error trees and extra provenance stay unchanged when display messages are bounded', () => {
  const error = { name: 'AggregateError', message: 'Scenario and cleanup failed', details: { observed: 'fixture state' },
    causes: [failure, { name: 'Error', message: 'Owned process remained', cause: { name: 'Error', message: 'Cleanup timeout' } }] }
  const fixture = conformanceFixture({ commitSource: 'environment', scenarios: [conformanceScenario({ status: 'failed', error })] })
  fixture.report.capture = { note: 'Synthetic provenance extension' }
  const before = structuredClone(fixture.report)
  const converted = conformanceResults(fixture.report, fixture.expected)
  assert.deepEqual(converted.rawReport, before)
  assert.equal(converted.rawReport.scenarios[0].error, error)
  assert.match(converted.report.testResults[0].assertionResults[0].failureMessages[0], /Owned process remained/)
  assert.match(converted.report.testResults[0].assertionResults[0].failureMessages[0], /Cleanup timeout/)
  assert.equal(converted.fullVerdict.commitSource, 'environment')
})

test('Go and TypeScript conformance results retain separate owning groups', () => {
  const go = conformanceFixture()
  const ts = conformanceFixture({ target: 'ts' })
  const result = ciTestResults([conformanceResults(go.report, go.expected).report,
    conformanceResults(ts.report, ts.expected).report], root)
  assert.deepEqual(result.summary, { passed: 2, failed: 0, skipped: 0 })
  assert.deepEqual(result.files.map(file => file.file), ['conformance/go/SKEL', 'conformance/ts/SKEL'])
})

test('complete lane outcome totals survive bounded display truncation', () => {
  const count = CI_TEST_RESULT_LIMITS.tests + 10
  const fixture = conformanceFixture({ scenarios: Array.from({ length: count }, (_, index) =>
    conformanceScenario({ id: `fixture.case-${index}`, title: `Fixture case ${index}`, lane: 'E' })) })
  const converted = conformanceResults(fixture.report, fixture.expected)
  const results = ciTestResults([converted.report], root)
  assert.equal(results.truncated, true)
  assert.equal(results.summary.passed, count)
  assert.equal(results.files[0].tests.length, CI_TEST_RESULT_LIMITS.tests)
  assert.equal(converted.rawReport.scenarios.length, count)
  assert.match(conformanceSummary(converted), new RegExp(`E: ${count}/${count} passed`))
})

test('conformance CLI retains raw bytes and publishes measured outcomes, lane durations, and a separate full verdict', t => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario(),
    conformanceScenario({ id: 'fixture.readback', title: 'Fixture public readback', durationMs: 18 })] })
  const { processResult, input, inputText, output, durations, verdict } = runCli(t, fixture)
  assert.equal(processResult.status, 0, processResult.stderr)
  assert.equal(readFileSync(input, 'utf8'), inputText)
  assert.match(processResult.stdout, /Conformance go: 2\/2 outcomes passed.*2 executed/)
  assert.match(processResult.stdout, /SKEL: 2\/2 passed/)
  assert.deepEqual(JSON.parse(readFileSync(durations, 'utf8')), { 'conformance/go/SKEL': 30 })
  assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
    { passed: 2, failed: 0, skipped: 0 })
  const full = JSON.parse(readFileSync(verdict, 'utf8'))
  assert.equal(full.status, 'passed')
  assert.equal(full.commitSha, fixture.report.commitSha)
  assert.deepEqual(full.lanes, fixture.report.lanes)
  assert.deepEqual(full.coverage, fixture.report.coverage)
})

test('measured zero duration is retained for cases without inventing a learned lane duration', t => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario({ durationMs: 0 })] })
  const { processResult, output, durations } = runCli(t, fixture)
  assert.equal(processResult.status, 0, processResult.stderr)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
  assert.equal(results.files[0].tests[0].durationMs, 0)
  assert.deepEqual(JSON.parse(readFileSync(durations, 'utf8')), {})
})

test('actual scenario failures return full-failure status and remain individually visible', t => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario({ lane: 'E', status: 'failed', durationMs: 7, error: failure })] })
  const { processResult, output, verdict } = runCli(t, fixture)
  assert.equal(processResult.status, 1, processResult.stderr)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
  assert.match(results.files[0].tests[0].message, /scenario: AssertionError: Persisted fixture state differs/)
  assert.deepEqual(results.summary, { passed: 0, failed: 1, skipped: 0 })
  assert.equal(JSON.parse(readFileSync(verdict, 'utf8')).status, 'failed')
})

test('runner cleanup failure stays red without fabricating an executed assertion', t => {
  const fixture = conformanceFixture({ cleanupError: { name: 'Error', message: 'Fixture PostgreSQL did not stop' } })
  const { processResult, output } = runCli(t, fixture)
  assert.equal(processResult.status, 1, processResult.stderr)
  assert.match(processResult.stderr, /runner cleanup failed.*PostgreSQL did not stop/)
  const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
  assert.deepEqual(results.summary, { passed: 1, failed: 0, skipped: 0 })
  const cleanup = results.files.find(file => file.file === 'conformance/go/cleanup')
  assert.equal(cleanup.status, 'failed')
  assert.deepEqual(cleanup.tests, [])
})

test('a full coverage failure is retained separately from its passing scenario assertions', t => {
  const fixture = conformanceFixture()
  fixture.report.status = 'failed'
  fixture.report.coverage.http = { status: 'failed', required: 2, covered: 1, missing: ['http GET /fixture error'], unexpected: [] }
  fixture.report.coverage.complete = false
  const { processResult, input, inputText, output, verdict } = runCli(t, fixture)
  assert.equal(processResult.status, 1, processResult.stderr)
  assert.equal(readFileSync(input, 'utf8'), inputText)
  assert.deepEqual(ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root).summary,
    { passed: 1, failed: 0, skipped: 0 })
  const full = JSON.parse(readFileSync(verdict, 'utf8'))
  assert.equal(full.status, 'failed')
  assert.deepEqual(full.coverage.http.missing, ['http GET /fixture error'])
  assert.match(processResult.stderr, /coverage is incomplete: http/)
})

test('a valid smoke result cannot become a full-conformance pass during conversion', t => {
  const fixture = conformanceFixture({ scope: { kind: 'smoke', lanes: [], scenarioIds: [], completeSelection: false } })
  fixture.report.coverage.mcp = { status: 'not-run', reason: 'Synthetic smoke selection' }
  fixture.report.coverage.complete = false
  const { processResult, input, verdict } = runCli(t, fixture)
  assert.equal(processResult.status, 1, processResult.stderr)
  assert.equal(JSON.parse(readFileSync(input, 'utf8')).status, 'passed')
  const full = JSON.parse(readFileSync(verdict, 'utf8'))
  assert.equal(full.reportedStatus, 'passed')
  assert.equal(full.status, 'failed')
  assert.equal(full.scope.completeSelection, false)
})

for (const [name, fixture, expectedFailed] of [
  ['empty selection', conformanceFixture({ scenarios: [] }), 0],
  ['setup-only selection', conformanceFixture({ scenarios: [conformanceScenario({ status: 'failed', phase: 'setup',
    executed: false, error: { name: 'Error', message: 'Fixture target missing' } })] }), 1],
]) {
  test(`zero executed scenarios stay red without invented assertions: ${name}`, t => {
    const { processResult, output, verdict } = runCli(t, fixture)
    assert.equal(processResult.status, 1, processResult.stderr)
    assert.match(processResult.stderr, /Zero executed conformance scenarios/)
    const results = ciTestResults([JSON.parse(readFileSync(output, 'utf8'))], root)
    assert.deepEqual(results.summary, { passed: 0, failed: 0, skipped: 0 })
    assert.equal(JSON.parse(readFileSync(verdict, 'utf8')).totals.failed, expectedFailed)
    assert.equal(results.files.length, expectedFailed)
    if (expectedFailed) assert.equal(results.files[0].status, 'failed')
  })
}

for (const [name, inputText, expectedError] of [
  ['malformed JSON', '{broken', /invalid JSON/],
  ['blank input', ' \n', /invalid JSON/],
  ['missing schema', '{}', /schemaVersion 1/],
  ['obsolete proposed report', '{"conformance":{"target":"go","selected":0,"complete":true},"testResults":[]}', /schemaVersion 1/],
]) {
  test(`invalid input returns validation-failure status without publishing reports: ${name}`, t => {
    const { processResult, output, durations, verdict } = runCli(t, conformanceFixture(), { inputText })
    assert.equal(processResult.status, 2)
    assert.match(processResult.stderr, expectedError)
    for (const path of [output, durations, verdict]) assert.equal(existsSync(path), false)
  })
}

test('a self-consistent truncated full report fails captured inventory validation before publication', t => {
  const fixture = conformanceFixture({ inventoryScenarios: [conformanceScenario(),
    conformanceScenario({ id: 'fixture.omitted', title: 'Omitted fixture case', lane: 'E' })] })
  const { processResult, input, inputText, output, verdict } = runCli(t, fixture)
  assert.equal(processResult.status, 2)
  assert.match(processResult.stderr, /missing terminal inventory IDs: fixture.omitted/)
  assert.equal(readFileSync(input, 'utf8'), inputText)
  assert.equal(existsSync(output), false)
  assert.equal(existsSync(verdict), false)
})

test('converter CLI requires full inventory and refuses to overwrite raw evidence', t => {
  for (const options of [{ omitInventory: true }, { overwriteRaw: true }]) {
    const { processResult, input, inputText, durations, verdict } = runCli(t, conformanceFixture(), options)
    assert.equal(processResult.status, 2)
    assert.equal(readFileSync(input, 'utf8'), inputText)
    assert.equal(existsSync(durations), false)
    assert.equal(existsSync(verdict), false)
  }
})

for (const [name, modify, expectedError] of [
  ['wrong target', report => { report.target = 'ts' }, /exact commit identity/],
  ['wrong commit', report => { report.commitSha = '0'.repeat(40) }, /exact commit identity/],
  ['duplicate scenario', report => { report.scenarios.push(report.scenarios[0]) }, /Duplicate conformance scenario ID/],
  ['missing lane total', report => { delete report.lanes.E }, /eight owning lane/],
  ['unfinished case', report => { report.scenarios[0].status = 'running' }, /unfinished/],
  ['missing duration', report => { delete report.scenarios[0].durationMs }, /measured conformance duration/],
]) {
  test(`invalid report cannot publish partial normalized evidence: ${name}`, t => {
    const fixture = conformanceFixture()
    modify(fixture.report)
    const { processResult, output, verdict } = runCli(t, fixture)
    assert.equal(processResult.status, 2)
    assert.match(processResult.stderr, expectedError)
    assert.equal(existsSync(output), false)
    assert.equal(existsSync(verdict), false)
  })
}
