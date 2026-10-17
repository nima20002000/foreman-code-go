import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fullConformanceVerdict, validateConformanceInventory, validateConformanceReport } from './ci-conformance-report.mjs'
import { conformanceFixture, conformanceScenario } from './test-support/conformance-report-fixture.mjs'

const failure = { name: 'AssertionError', message: 'The public response differed', details: { actual: 'starting', expected: 'ready' } }

test('versioned report validation retains original outcomes, provenance, error trees, and every lane total', () => {
  const fixture = conformanceFixture({ commitSource: 'environment', scenarios: [
    conformanceScenario(),
    conformanceScenario({ id: 'fixture.workflow', title: 'Fixture workflow response', lane: 'E', status: 'failed',
      durationMs: 31, error: { name: 'AggregateError', message: 'Scenario and cleanup failed',
        causes: [failure, { name: 'Error', message: 'Cleanup failed', cause: { name: 'Error', message: 'Owned process remained' } }] } }),
    conformanceScenario({ id: 'fixture.harness', title: 'Fixture harness setup', lane: 'H', status: 'failed',
      phase: 'setup', executed: false, durationMs: 8, error: { name: 'Error', message: 'Fixture binary unavailable' } }),
    conformanceScenario({ id: 'fixture.worker', title: 'Fixture worker cleanup', lane: 'R', status: 'failed',
      phase: 'cleanup', durationMs: 22, error: failure }),
  ] })
  fixture.report.extraMetadata = { origin: 'synthetic regression fixture', nested: ['retained'] }
  const original = structuredClone(fixture.report)
  assert.equal(validateConformanceReport(fixture.report, fixture.expected), fixture.report)
  assert.deepEqual(fixture.report, original)
  assert.deepEqual(Object.keys(fixture.report.lanes), ['SKEL', 'E', 'H', 'J', 'A1', 'S', 'R', 'A2'])
  assert.deepEqual(fixture.report.totals, { total: 4, passed: 1, failed: 3, skipped: 0 })
  assert.equal(fixture.report.executed, 3)
  const verdict = fullConformanceVerdict(fixture.report)
  assert.equal(verdict.status, 'failed')
  assert.equal(verdict.commitSource, 'environment')
  assert.equal(verdict.lanes, fixture.report.lanes)
  assert.equal(verdict.coverage, fixture.report.coverage)
})

for (const [name, change] of [
  ['repository', report => { report.repository = 'example/another-repository' }],
  ['baseline', report => { report.baselineSha = '0'.repeat(40) }],
  ['target', report => { report.target = 'ts' }],
  ['commit', report => { report.commitSha = '0'.repeat(40) }],
  ['commit source', report => { report.commitSource = 'environment' }],
]) {
  test(`report provenance must match the actual requested ${name}`, () => {
    const fixture = conformanceFixture()
    change(fixture.report)
    assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /exact commit identity/)
  })
}

test('validation requires an independently supplied exact commit and source identity', () => {
  const fixture = conformanceFixture()
  for (const commitSha of [undefined, 123, 'main', 'a'.repeat(39), fixture.expected.commitSha.toUpperCase()]) {
    assert.throws(() => validateConformanceReport(fixture.report, { ...fixture.expected, commitSha }), /exact conformance target, commit SHA/)
  }
  assert.throws(() => validateConformanceReport(fixture.report, { ...fixture.expected, commitSource: undefined }), /exact conformance target, commit SHA/)
})

for (const [name, change, expectedError] of [
  ['missing version', report => { delete report.schemaVersion }, /schemaVersion 1/],
  ['nonterminal status', report => { report.scenarios[0].status = 'running' }, /unfinished/],
  ['skipped status', report => { report.scenarios[0].status = 'skipped' }, /unfinished/],
  ['unknown phase', report => { report.scenarios[0].phase = 'preparing' }, /unfinished/],
  ['executed setup', report => { report.scenarios[0].phase = 'setup' }, /execution and phase/],
  ['unexecuted scenario', report => { report.scenarios[0].executed = false }, /execution and phase/],
  ['passing cleanup', report => { report.scenarios[0].phase = 'cleanup' }, /execution and phase/],
  ['passing error', report => { report.scenarios[0].error = failure }, /Passing.*error/],
  ['missing failure detail', report => { report.scenarios[0].status = 'failed' }, /failure detail/],
  ['negative duration', report => { report.scenarios[0].durationMs = -1 }, /measured.*duration/],
  ['nonfinite duration', report => { report.scenarios[0].durationMs = Infinity }, /measured.*duration/],
  ['duplicate ID', report => { report.scenarios.push(report.scenarios[0]) }, /Duplicate conformance scenario ID/],
  ['missing ID', report => { delete report.scenarios[0].id }, /ID, title/],
  ['missing title', report => { delete report.scenarios[0].title }, /ID, title/],
  ['unknown lane', report => { report.scenarios[0].lane = 'OTHER' }, /owning lane/],
  ['overall total', report => { report.totals.total++ }, /totals disagree/],
  ['lane total', report => { report.lanes.SKEL.passed++ }, /totals disagree/],
  ['skipped total', report => { report.totals.skipped++ }, /totals disagree/],
  ['missing lane', report => { delete report.lanes.H }, /eight owning lane/],
  ['executed count', report => { report.executed++ }, /executed count/],
  ['unfinished timestamps', report => { delete report.finishedAt }, /run duration/],
  ['inconsistent run duration', report => { report.durationMs++ }, /run duration/],
  ['passing empty selection', report => { report.scenarios = []; report.totals = { total: 0, passed: 0, failed: 0, skipped: 0 }
    report.lanes.SKEL = { total: 0, passed: 0, failed: 0, skipped: 0 }; report.executed = 0 }, /passing status contradicts/],
]) {
  test(`invalid terminal report is rejected through public validation: ${name}`, () => {
    const fixture = conformanceFixture()
    change(fixture.report)
    assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), expectedError)
  })
}

test('failure trees reject malformed causes without dropping valid aggregate details', () => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario({ status: 'failed', error: failure })] })
  fixture.report.scenarios[0].error = { name: 'AggregateError', message: 'Both failed', causes: ['lost error'] }
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /failure detail/)
  const cycle = { name: 'Error', message: 'Cyclic fixture' }
  cycle.cause = cycle
  fixture.report.scenarios[0].error = cycle
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /failure detail/)
})

test('setup failures remain selected outcomes but never become executed tests', () => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario({ status: 'failed', phase: 'setup', executed: false,
    durationMs: 0, error: { name: 'Error', message: 'Fixture target missing' } })] })
  const report = validateConformanceReport(fixture.report, fixture.expected)
  assert.equal(report.totals.failed, 1)
  assert.equal(report.executed, 0)
  assert.equal(fullConformanceVerdict(report).status, 'failed')
  assert.match(fullConformanceVerdict(report).reasons.join('\n'), /Zero executed/)
})

test('a diagnostic smoke report preserves its passing outcomes while full conformance stays failed', () => {
  const fixture = conformanceFixture({ scope: { kind: 'smoke', lanes: [], scenarioIds: [], completeSelection: false } })
  fixture.report.coverage.mcp = { status: 'not-run', reason: 'Filtered fixture selection' }
  fixture.report.coverage.complete = false
  const report = validateConformanceReport(fixture.report, fixture.expected)
  assert.equal(report.status, 'passed')
  const verdict = fullConformanceVerdict(report)
  assert.equal(verdict.reportedStatus, 'passed')
  assert.equal(verdict.status, 'failed')
  assert.match(verdict.reasons.join('\n'), /Smoke or filtered/)
  assert.match(verdict.reasons.join('\n'), /coverage is incomplete/)
})

test('completeSelection must agree with filters and each selected outcome', () => {
  const fixture = conformanceFixture()
  fixture.report.scope.scenarioIds = ['fixture.health']
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /completeSelection contradicts/)
  fixture.report.scope.completeSelection = false
  fixture.report.scope.scenarioIds = ['fixture.different']
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /outside the reported selection/)
})

test('full coverage gaps and unavailable live MCP coverage are valid failed evidence', () => {
  const fixture = conformanceFixture()
  fixture.report.status = 'failed'
  fixture.report.coverage.http = { status: 'failed', required: 2, covered: 1, missing: ['http GET /fixture error'], unexpected: [] }
  fixture.report.coverage.mcp = { status: 'unavailable', error: { name: 'Error', message: 'Fixture target did not start' } }
  fixture.report.coverage.complete = false
  const before = structuredClone(fixture.report)
  const report = validateConformanceReport(fixture.report, fixture.expected)
  assert.equal(fullConformanceVerdict(report).status, 'failed')
  assert.match(fullConformanceVerdict(report).reasons.join('\n'), /http, mcp/)
  assert.deepEqual(report, before)
})

for (const [name, change, expectedError] of [
  ['missing coverage', report => { delete report.coverage }, /missing conformance coverage/],
  ['wrong complete flag', report => { report.coverage.complete = false }, /coverage.complete contradicts/],
  ['missing count', report => { report.coverage.http.required++ }, /coverage counts disagree/],
  ['unexpected requirement', report => { report.coverage.http.unexpected.push('unregistered fixture') }, /coverage status contradicts/],
  ['duplicate missing requirement', report => { report.coverage.http.missing = ['fixture', 'fixture'] }, /coverage requirements/],
  ['unknown MCP state', report => { report.coverage.mcp = { status: 'pending' } }, /coverage result/],
  ['missing live error', report => { report.coverage.mcp = { status: 'unavailable' } }, /failure detail/],
]) {
  test(`contradictory coverage cannot certify conformance: ${name}`, () => {
    const fixture = conformanceFixture()
    change(fixture.report)
    assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), expectedError)
  })
}

test('passing status cannot conceal failed outcomes or a full coverage gap', () => {
  const fixture = conformanceFixture({ scenarios: [conformanceScenario({ status: 'failed', error: failure })] })
  fixture.report.status = 'passed'
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /passing status contradicts/)
  const coverage = conformanceFixture()
  coverage.report.coverage.mcp = { status: 'not-run', reason: 'Fixture missing discovery' }
  coverage.report.coverage.complete = false
  assert.throws(() => validateConformanceReport(coverage.report, coverage.expected), /passing status contradicts/)
})

test('runner-level setup and cleanup failures remain red when named outcomes passed', () => {
  for (const phase of ['setup', 'cleanup']) {
    const fixture = conformanceFixture({ [`${phase}Error`]: failure })
    const report = validateConformanceReport(fixture.report, fixture.expected)
    assert.equal(report.totals.failed, 0)
    assert.equal(fullConformanceVerdict(report).status, 'failed')
    assert.match(fullConformanceVerdict(report).reasons.join('\n'), new RegExp(`runner ${phase} failed`))
  }
  const fixture = conformanceFixture()
  fixture.report.status = 'failed'
  assert.match(fullConformanceVerdict(validateConformanceReport(fixture.report, fixture.expected)).reasons.join('\n'), /outside individual outcomes/)
})

test('the actual full inventory catches a self-consistent report with omitted terminal outcomes', () => {
  const fixture = conformanceFixture({ inventoryScenarios: [conformanceScenario(),
    conformanceScenario({ id: 'fixture.second', title: 'Second fixture case', lane: 'E' })] })
  const { inventory, ...identity } = fixture.expected
  assert.equal(validateConformanceReport(fixture.report, identity), fixture.report)
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /missing terminal inventory IDs: fixture.second/)
  fixture.report.scope = { kind: 'full', lanes: ['SKEL'], scenarioIds: [], completeSelection: false }
  assert.equal(fullConformanceVerdict(validateConformanceReport(fixture.report, fixture.expected)).status, 'failed')
})

test('inventory validation requires a full target-specific unique list and matching outcome ownership', () => {
  const fixture = conformanceFixture()
  assert.equal(validateConformanceInventory(fixture.inventory, 'go'), fixture.inventory)
  assert.throws(() => validateConformanceInventory(fixture.inventory, 'ts'), /actual full conformance inventory/)
  const duplicate = structuredClone(fixture.inventory)
  duplicate.scenarios.push(duplicate.scenarios[0])
  assert.throws(() => validateConformanceInventory(duplicate, 'go'), /Duplicate conformance inventory ID/)
  const smoke = { ...fixture.inventory, scope: 'smoke' }
  assert.throws(() => validateConformanceInventory(smoke, 'go'), /actual full conformance inventory/)
  fixture.inventory.scenarios[0].lane = 'E'
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /disagrees with the captured inventory/)
  fixture.inventory.scenarios[0].lane = 'SKEL'
  fixture.inventory.scenarios[0].id = 'fixture.other'
  assert.throws(() => validateConformanceReport(fixture.report, fixture.expected), /disagrees with the captured inventory/)
})
