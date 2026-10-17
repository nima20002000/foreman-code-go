// Validates Q-CONF's schemaVersion 1 report without changing its outcomes or provenance.
// The reporting contract is owned by conformance/src/reporting and conformance/src/main.ts.
export const CONFORMANCE_REPOSITORY = 'nima20002000/foreman-code-go'
export const CONFORMANCE_BASELINE_SHA = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
export const CONFORMANCE_LANES = ['SKEL', 'E', 'H', 'J', 'A1', 'S', 'R', 'A2']

const commitPattern = /^[0-9a-f]{40}$/
const terminalStatuses = ['passed', 'failed']
const phases = ['setup', 'scenario', 'cleanup']
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = value => typeof value === 'string' && value.trim().length > 0
const isCount = value => Number.isSafeInteger(value) && value >= 0

function validateFailure(error, label, ancestors = new Set()) {
  if (!isRecord(error) || typeof error.name !== 'string' || typeof error.message !== 'string' || ancestors.has(error)) {
    throw new Error(`Invalid conformance failure detail: ${label}.`)
  }
  ancestors.add(error)
  if (error.causes !== undefined) {
    if (!Array.isArray(error.causes)) throw new Error(`Invalid conformance failure causes: ${label}.`)
    for (const cause of error.causes) validateFailure(cause, label, ancestors)
  }
  if (error.cause !== undefined) validateFailure(error.cause, label, ancestors)
  ancestors.delete(error)
}

function validateIdentity(report, expected) {
  if (!expected || !['go', 'ts'].includes(expected.target) || typeof expected.commitSha !== 'string' || !commitPattern.test(expected.commitSha)
    || !['git', 'environment'].includes(expected.commitSource)) {
    throw new Error('Expected an exact conformance target, commit SHA, and commit source.')
  }
  if (report.repository !== CONFORMANCE_REPOSITORY || report.baselineSha !== CONFORMANCE_BASELINE_SHA
    || report.target !== expected.target || report.commitSha !== expected.commitSha
    || report.commitSource !== expected.commitSource) {
    throw new Error('Conformance report does not match the requested repository, baseline, target, or exact commit identity.')
  }
}

function validateScenarioIdentity(scenario) {
  if (!isRecord(scenario) || !isText(scenario.id) || !isText(scenario.title)
    || !CONFORMANCE_LANES.includes(scenario.lane)) {
    throw new Error('Every conformance scenario needs an ID, title, and known owning lane.')
  }
}

function validateOutcome(scenario) {
  validateScenarioIdentity(scenario)
  if (!terminalStatuses.includes(scenario.status) || !phases.includes(scenario.phase)
    || typeof scenario.executed !== 'boolean') {
    throw new Error(`Invalid or unfinished conformance outcome: ${scenario.id}.`)
  }
  if (!Number.isFinite(scenario.durationMs) || scenario.durationMs < 0) {
    throw new Error(`Invalid measured conformance duration: ${scenario.id}.`)
  }
  if (scenario.phase === 'setup' && (scenario.executed || scenario.status !== 'failed')
    || scenario.phase !== 'setup' && !scenario.executed
    || scenario.status === 'passed' && scenario.phase !== 'scenario') {
    throw new Error(`Conformance execution and phase disagree: ${scenario.id}.`)
  }
  if (scenario.status === 'failed') validateFailure(scenario.error, scenario.id)
  else if (scenario.error !== undefined) throw new Error(`Passing conformance scenario has an error: ${scenario.id}.`)
}

function outcomeTotals(scenarios) {
  const totals = { total: scenarios.length, passed: 0, failed: 0, skipped: 0 }
  for (const scenario of scenarios) totals[scenario.status]++
  return totals
}

function validateTotals(actual, expected, label) {
  if (!isRecord(actual) || Object.keys(expected).some(key => !isCount(actual[key]) || actual[key] !== expected[key])) {
    throw new Error(`Conformance totals disagree with terminal outcomes: ${label}.`)
  }
}

function validateScope(scope, scenarios) {
  if (!isRecord(scope) || !['full', 'smoke'].includes(scope.kind) || !Array.isArray(scope.lanes)
    || scope.lanes.some(lane => !CONFORMANCE_LANES.includes(lane)) || !Array.isArray(scope.scenarioIds)
    || scope.scenarioIds.some(id => !isText(id)) || typeof scope.completeSelection !== 'boolean') {
    throw new Error('Invalid conformance selection scope.')
  }
  const complete = scope.kind === 'full' && scope.lanes.length === 0 && scope.scenarioIds.length === 0
  if (scope.completeSelection !== complete) throw new Error('Conformance completeSelection contradicts its filters or smoke scope.')
  for (const scenario of scenarios) {
    if (scope.lanes.length && !scope.lanes.includes(scenario.lane)
      || scope.scenarioIds.length && !scope.scenarioIds.includes(scenario.id)) {
      throw new Error(`Conformance outcome is outside the reported selection: ${scenario.id}.`)
    }
  }
}

function coverageNames(values, label) {
  if (!Array.isArray(values) || values.some(value => !isText(value)) || new Set(values).size !== values.length) {
    throw new Error(`Invalid conformance coverage requirements: ${label}.`)
  }
}

function validateCoverageResult(result, label) {
  if (!isRecord(result) || !terminalStatuses.includes(result.status)
    || !isCount(result.required) || !isCount(result.covered) || result.covered > result.required) {
    throw new Error(`Invalid conformance coverage result: ${label}.`)
  }
  coverageNames(result.missing, `${label} missing`)
  coverageNames(result.unexpected, `${label} unexpected`)
  if (result.missing.length !== result.required - result.covered
    || result.missing.some(value => result.unexpected.includes(value))) {
    throw new Error(`Conformance coverage counts disagree: ${label}.`)
  }
  const passed = result.required > 0 && result.missing.length === 0 && result.unexpected.length === 0
  if ((result.status === 'passed') !== passed) throw new Error(`Conformance coverage status contradicts its gaps: ${label}.`)
}

function validateCoverage(coverage) {
  if (!isRecord(coverage) || !isRecord(coverage.mcp) || typeof coverage.complete !== 'boolean') {
    throw new Error('Invalid or missing conformance coverage.')
  }
  validateCoverageResult(coverage.http, 'http')
  validateCoverageResult(coverage.behaviors, 'behaviors')
  if (coverage.mcp.status === 'not-run') {
    if (!isText(coverage.mcp.reason)) throw new Error('Missing reason for conformance MCP coverage not run.')
  } else if (coverage.mcp.status === 'unavailable') {
    validateFailure(coverage.mcp.error, 'MCP coverage unavailable')
  } else validateCoverageResult(coverage.mcp, 'mcp')
  const complete = ['http', 'mcp', 'behaviors'].every(surface => coverage[surface].status === 'passed')
  if (coverage.complete !== complete) throw new Error('Conformance coverage.complete contradicts its surface results.')
}

/** The caller captures this unfiltered inventory from the same checked-out launcher as the report. */
export function validateConformanceInventory(inventory, target) {
  if (!['go', 'ts'].includes(target) || !isRecord(inventory) || inventory.kind !== 'conformance-inventory'
    || inventory.target !== target || inventory.scope !== 'full' || !Array.isArray(inventory.scenarios)) {
    throw new Error('Expected the actual full conformance inventory for the requested target.')
  }
  const ids = new Set()
  for (const scenario of inventory.scenarios) {
    validateScenarioIdentity(scenario)
    if (ids.has(scenario.id)) throw new Error(`Duplicate conformance inventory ID: ${scenario.id}.`)
    ids.add(scenario.id)
  }
  return inventory
}

function validateInventorySelection(report, inventory) {
  const entries = new Map(inventory.scenarios.map(scenario => [scenario.id, scenario]))
  for (const scenario of report.scenarios) {
    const entry = entries.get(scenario.id)
    if (!entry || entry.lane !== scenario.lane || entry.title !== scenario.title) {
      throw new Error(`Conformance outcome disagrees with the captured inventory: ${scenario.id}.`)
    }
    entries.delete(scenario.id)
  }
  if (report.scope.completeSelection && entries.size) {
    throw new Error(`Complete conformance selection is missing terminal inventory IDs: ${[...entries.keys()].join(', ')}.`)
  }
}

/** Returns the original report. A valid report can truthfully contain failures or diagnostic scope. */
export function validateConformanceReport(report, expected) {
  if (!isRecord(report) || report.schemaVersion !== 1 || !terminalStatuses.includes(report.status)
    || !Array.isArray(report.scenarios)) throw new Error('Expected a schemaVersion 1 conformance terminal report.')
  validateIdentity(report, expected)
  const started = typeof report.startedAt === 'string' ? Date.parse(report.startedAt) : NaN
  const finished = typeof report.finishedAt === 'string' ? Date.parse(report.finishedAt) : NaN
  if (!Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(report.durationMs)
    || report.durationMs !== Math.max(0, finished - started)) throw new Error('Invalid measured conformance run duration.')
  const ids = new Set()
  for (const scenario of report.scenarios) {
    validateOutcome(scenario)
    if (ids.has(scenario.id)) throw new Error(`Duplicate conformance scenario ID: ${scenario.id}.`)
    ids.add(scenario.id)
  }
  validateTotals(report.totals, outcomeTotals(report.scenarios), 'overall')
  if (!isRecord(report.lanes) || Object.keys(report.lanes).length !== CONFORMANCE_LANES.length) {
    throw new Error('Conformance report must retain all eight owning lane totals.')
  }
  for (const lane of CONFORMANCE_LANES) {
    validateTotals(report.lanes[lane], outcomeTotals(report.scenarios.filter(scenario => scenario.lane === lane)), lane)
  }
  const executed = report.scenarios.filter(scenario => scenario.executed).length
  if (!isCount(report.executed) || report.executed !== executed) throw new Error('Conformance executed count disagrees with terminal outcomes.')
  validateScope(report.scope, report.scenarios)
  validateCoverage(report.coverage)
  for (const key of ['setupError', 'cleanupError']) {
    if (report[key] !== undefined) validateFailure(report[key], key)
  }
  if (report.status === 'passed' && (!report.totals.total || report.totals.failed
    || report.setupError !== undefined || report.cleanupError !== undefined
    || report.scope.completeSelection && !report.coverage.complete)) {
    throw new Error('Conformance passing status contradicts its failures, empty selection, or full coverage gaps.')
  }
  if (expected.inventory !== undefined) {
    validateInventorySelection(report, validateConformanceInventory(expected.inventory, expected.target))
  }
  return report
}

/** Evaluate full conformance after validation. Merge/non-regression policy belongs to a separate gate. */
export function fullConformanceVerdict(report) {
  const reasons = []
  if (!report.totals.total) reasons.push('Zero selected conformance scenarios.')
  if (!report.executed) reasons.push('Zero executed conformance scenarios; setup outcomes are not executed tests.')
  if (!report.scope.completeSelection) reasons.push('Smoke or filtered selection does not establish full conformance.')
  if (report.totals.failed) reasons.push(`${report.totals.failed} selected conformance outcomes failed.`)
  if (report.setupError !== undefined) reasons.push('Conformance runner setup failed.')
  if (report.cleanupError !== undefined) reasons.push('Conformance runner cleanup failed.')
  if (!report.coverage.complete) {
    const surfaces = ['http', 'mcp', 'behaviors'].filter(surface => report.coverage[surface].status !== 'passed')
    reasons.push(`Full conformance coverage is incomplete: ${surfaces.join(', ')}.`)
  }
  if (report.status === 'failed' && !reasons.length) reasons.push('Conformance runner reported a failure outside individual outcomes.')
  return { repository: report.repository, baselineSha: report.baselineSha, commitSha: report.commitSha,
    commitSource: report.commitSource, target: report.target, reportedStatus: report.status,
    status: reasons.length ? 'failed' : 'passed', reasons, totals: report.totals, lanes: report.lanes,
    executed: report.executed, scope: report.scope, coverage: report.coverage }
}

/** The raw artifact retains details and the complete error tree; this text is for logs and bounded rows. */
export function conformanceFailureText(error) {
  const messages = [`${error.name}: ${error.message}`]
  for (const cause of error.causes ?? []) messages.push(`caused by ${conformanceFailureText(cause)}`)
  if (error.cause !== undefined) messages.push(`caused by ${conformanceFailureText(error.cause)}`)
  return messages.join('\n')
}
