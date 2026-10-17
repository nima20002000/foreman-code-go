// Adapts Q-CONF's versioned raw report to the existing bounded CI results contract.
// Keep the input and captured inventory as separate artifacts; neither is rewritten here.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readJsonReport, writeJsonReport } from './ci-report-io.mjs'
import { measuredUnitDurations } from './ci-unit-files.mjs'
import { CONFORMANCE_LANES, conformanceFailureText, fullConformanceVerdict,
  validateConformanceReport } from './ci-conformance-report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function scenarioAssertion(scenario) {
  const assertion = { fullName: `[${scenario.lane}] ${scenario.id}: ${scenario.title}`,
    status: scenario.status, duration: scenario.durationMs }
  if (scenario.error !== undefined) {
    assertion.failureMessages = [`${scenario.phase}: ${conformanceFailureText(scenario.error)}`]
  }
  return assertion
}

function laneResult(report, lane, diagnostics) {
  const outcomes = report.scenarios.filter(scenario => scenario.lane === lane)
  if (!outcomes.length) return null
  const setup = outcomes.filter(scenario => !scenario.executed)
  const messages = setup.map(scenario => `Conformance ${report.target} setup failed for ${scenario.id} (${lane}, not executed): ${conformanceFailureText(scenario.error)}`)
  diagnostics.push(...messages)
  const duration = outcomes.reduce((total, scenario) => total + scenario.durationMs, 0)
  return { name: `conformance/${report.target}/${lane}`,
    status: outcomes.some(scenario => scenario.status === 'failed') ? 'failed' : 'passed',
    duration: Number.isFinite(duration) ? duration : null,
    assertionResults: outcomes.filter(scenario => scenario.executed).map(scenarioAssertion),
    ...(messages.length ? { message: messages.join('\n') } : {}) }
}

/** Validation does not certify a passing run. Raw failures and the full verdict remain separate. */
export function conformanceResults(raw, expected) {
  const report = validateConformanceReport(raw, expected)
  const diagnostics = []
  const testResults = CONFORMANCE_LANES.map(lane => laneResult(report, lane, diagnostics)).filter(Boolean)
  for (const phase of ['setup', 'cleanup']) {
    const error = report[`${phase}Error`]
    if (error === undefined) continue
    const message = `Conformance ${report.target} runner ${phase} failed: ${conformanceFailureText(error)}`
    diagnostics.push(message)
    testResults.push({ name: `conformance/${report.target}/${phase}`, status: 'failed', duration: null,
      assertionResults: [], message })
  }
  return { rawReport: report, report: { testResults }, totals: report.totals, lanes: report.lanes,
    selected: report.totals.total, executed: report.executed, diagnostics,
    fullVerdict: fullConformanceVerdict(report) }
}

export function conformanceSummary(result) {
  const report = result.rawReport
  const summary = [`Conformance ${report.target}: ${report.totals.passed}/${report.totals.total} outcomes passed; ${report.totals.failed} failed; ${report.executed} executed.`]
  for (const lane of CONFORMANCE_LANES) {
    const counts = report.lanes[lane]
    const outcomes = report.scenarios.filter(scenario => scenario.lane === lane)
    const executed = outcomes.filter(scenario => scenario.executed).length
    summary.push(`  ${lane}: ${counts.passed}/${counts.total} passed; ${counts.failed} failed; ${executed} executed; ${counts.total - executed} setup failures.`)
  }
  summary.push(`Full conformance ${report.target}: ${result.fullVerdict.status}.`)
  summary.push(`Selection: ${report.scope.kind}, complete=${report.scope.completeSelection}; coverage: http=${report.coverage.http.status}, mcp=${report.coverage.mcp.status}, behaviors=${report.coverage.behaviors.status}.`)
  summary.push(`Identity: ${report.repository}@${report.commitSha} (${report.commitSource}); baseline ${report.baselineSha}.`)
  return `${summary.join('\n')}\n`
}

function separateArtifactPaths(values) {
  const inputs = [resolve(values.input), resolve(values.inventory)]
  const outputs = [values.output, values.durations, values['verdict-output']].filter(Boolean).map(path => resolve(path))
  if (new Set(outputs).size !== outputs.length || outputs.some(path => inputs.includes(path))) {
    throw new Error('Conformance raw input, inventory, normalized results, durations, and verdict need separate artifact paths.')
  }
}

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, inventory: { type: 'string' },
    output: { type: 'string' }, target: { type: 'string' }, commit: { type: 'string' },
    'commit-source': { type: 'string' }, durations: { type: 'string' }, 'verdict-output': { type: 'string' } } })
  if (!values.input || !values.inventory || !values.output || !values.target || !values.commit || !values['commit-source']) {
    throw new Error('Usage: ci-conformance-results.mjs --target go|ts --commit <exact-sha> --commit-source git|environment --inventory <full-inventory.json> --input <raw-report.json> --output <normalized.json> [--durations <durations.json>] [--verdict-output <full-verdict.json>]')
  }
  separateArtifactPaths(values)
  const result = conformanceResults(readJsonReport(values.input), { target: values.target, commitSha: values.commit,
    commitSource: values['commit-source'], inventory: readJsonReport(values.inventory) })
  writeJsonReport(values.output, result.report)
  if (values.durations) writeJsonReport(values.durations, measuredUnitDurations(result.report, root, 'conformance'))
  if (values['verdict-output']) writeJsonReport(values['verdict-output'], result.fullVerdict)
  process.stdout.write(conformanceSummary(result))
  for (const message of [...result.diagnostics, ...result.fullVerdict.reasons]) process.stderr.write(`${message}\n`)
  if (result.fullVerdict.status === 'failed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}
