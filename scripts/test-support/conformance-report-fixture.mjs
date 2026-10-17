// Synthetic public-report fixtures for CI tooling tests; these are never conformance evidence.
import { CONFORMANCE_BASELINE_SHA, CONFORMANCE_LANES, CONFORMANCE_REPOSITORY } from '../ci-conformance-report.mjs'

export function conformanceScenario(overrides = {}) {
  return { id: 'fixture.health', title: 'Fixture health response', lane: 'SKEL', status: 'passed',
    phase: 'scenario', executed: true, durationMs: 12, ...overrides }
}

function totals(scenarios) {
  return { total: scenarios.length, passed: scenarios.filter(scenario => scenario.status === 'passed').length,
    failed: scenarios.filter(scenario => scenario.status === 'failed').length, skipped: 0 }
}

function completeCoverage() {
  const surface = () => ({ status: 'passed', required: 1, covered: 1, missing: [], unexpected: [] })
  return { http: surface(), mcp: surface(), behaviors: surface(), complete: true }
}

export function conformanceFixture({ target = 'go', scenarios = [conformanceScenario()], inventoryScenarios = scenarios,
  scope = { kind: 'full', lanes: [], scenarioIds: [], completeSelection: true }, coverage = completeCoverage(),
  commitSha = CONFORMANCE_BASELINE_SHA, commitSource = 'git', setupError, cleanupError } = {}) {
  const counts = totals(scenarios)
  const durationMs = Math.ceil(scenarios.reduce((elapsed, scenario) => elapsed + scenario.durationMs, 0)) + 10
  const startedAt = '2026-10-17T00:00:00.000Z'
  const passed = counts.total > 0 && counts.failed === 0 && setupError === undefined && cleanupError === undefined
    && (!scope.completeSelection || coverage.complete)
  const report = { repository: CONFORMANCE_REPOSITORY, baselineSha: CONFORMANCE_BASELINE_SHA,
    commitSha, commitSource, schemaVersion: 1, target, status: passed ? 'passed' : 'failed', startedAt,
    finishedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), durationMs, totals: counts,
    lanes: Object.fromEntries(CONFORMANCE_LANES.map(lane => [lane, totals(scenarios.filter(scenario => scenario.lane === lane))])),
    scenarios, scope, coverage, executed: scenarios.filter(scenario => scenario.executed).length,
    ...(setupError === undefined ? {} : { setupError }), ...(cleanupError === undefined ? {} : { cleanupError }) }
  const inventory = { kind: 'conformance-inventory', target, scope: 'full',
    scenarios: inventoryScenarios.map(({ id, title, lane }) => ({ id, title, lane })) }
  return { report, inventory, expected: { target, commitSha, commitSource, inventory } }
}
