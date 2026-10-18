// CI policy is separate from the launcher's complete, unmodified conformance report.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { validateConformanceInventory, validateConformanceReport, fullConformanceVerdict } from './ci-conformance-report.mjs'
import { readJsonReport, writeJsonReport } from './ci-report-io.mjs'

function launcherFailures(report, exitCode) {
  if (!Number.isInteger(exitCode) || ![0, 1].includes(exitCode)) {
    return [`Conformance launcher did not finish normally (exit ${exitCode}).`]
  }
  const expected = report.status === 'passed' ? 0 : 1
  if (exitCode !== expected) return [`Conformance launcher exit ${exitCode} contradicts reported status ${report.status}.`]
  return []
}

function requiredSkeleton(report) {
  if (report.target !== 'go') return { status: 'not-applicable', reason: 'Go skeleton acceptance is checked on the Go target.' }
  const selected = report.scenarios.filter(scenario => scenario.lane === 'SKEL')
  const passedIds = selected.filter(scenario => scenario.executed && scenario.status === 'passed').map(scenario => scenario.id)
  const failedIds = selected.filter(scenario => !scenario.executed || scenario.status !== 'passed').map(scenario => scenario.id)
  return { status: selected.length > 0 && failedIds.length === 0 ? 'passed' : 'failed', selected: selected.length,
    executed: selected.filter(scenario => scenario.executed).length, passedIds, failedIds }
}

function compareMain(report, mainReport, mainCommitSha) {
  if (mainReport === undefined && mainCommitSha === undefined) {
    return { status: 'not-available', reason: 'No real exact-main conformance report was supplied; non-regression is not established.' }
  }
  if (mainReport === undefined || !mainCommitSha) {
    throw new Error('An exact-main conformance report and its explicit fork commit SHA must be supplied together.')
  }
  const main = validateConformanceReport(mainReport, { target: report.target, commitSha: mainCommitSha,
    commitSource: mainReport.commitSource })
  if (!main.scope.completeSelection) throw new Error('Exact-main comparison needs a full-selection report.')
  // Main can truthfully have no executable Go target yet. Keep its zero counts; the current run must still execute and pass SKEL.
  // A current inventory may contain new scenarios. Compare the actual historical passes, not a reconstructed baseline.
  const passingScenarioIds = main.scenarios.filter(scenario => scenario.executed && scenario.status === 'passed')
    .map(scenario => scenario.id)
  const current = new Map(report.scenarios.map(scenario => [scenario.id, scenario]))
  const regressions = []
  for (const id of passingScenarioIds) {
    const outcome = current.get(id)
    if (!outcome || !outcome.executed || outcome.status !== 'passed') {
      regressions.push({ id, reason: outcome ? 'Previously passing scenario did not execute and pass.' : 'Previously passing scenario is missing.',
        ...(outcome ? { status: outcome.status, phase: outcome.phase, executed: outcome.executed } : {}) })
    }
  }
  let status = 'passed'
  if (!passingScenarioIds.length) status = 'not-established'
  if (regressions.length) status = 'failed'
  return { status, mainCommitSha: main.commitSha,
    mainCommitSource: main.commitSource, mainReportedStatus: main.status, mainExecuted: main.executed,
    mainSelected: main.totals.total, passingScenarioIds, compared: passingScenarioIds.length, regressions,
    ...(!passingScenarioIds.length ? { reason: 'The supplied exact-main report has no executed passing IDs; non-regression is not established.' } : {}) }
}

function affectedGate(report, inventory, fullConformance, selectionIds, launcherExit) {
  if (!Array.isArray(selectionIds) || !selectionIds.length || selectionIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(selectionIds).size !== selectionIds.length) {
    throw new Error('Affected conformance requires a nonempty, unique list of exact scenario IDs.')
  }
  const known = new Set(inventory.scenarios.map(scenario => scenario.id))
  const unknown = selectionIds.filter(id => !known.has(id))
  if (unknown.length) throw new Error(`Unknown selected conformance scenario IDs: ${unknown.join(', ')}.`)
  const selected = new Set(selectionIds)
  const actual = new Map(report.scenarios.map(scenario => [scenario.id, scenario]))
  const missingIds = selectionIds.filter(id => !actual.has(id))
  const unexpectedIds = [...actual.keys()].filter(id => !selected.has(id))
  const passedIds = report.scenarios.filter(scenario => selected.has(scenario.id) && scenario.executed && scenario.status === 'passed')
    .map(scenario => scenario.id)
  const failedIds = report.scenarios.filter(scenario => selected.has(scenario.id) && (!scenario.executed || scenario.status !== 'passed'))
    .map(scenario => scenario.id)
  const reasons = launcherFailures(report, launcherExit)
  if (report.scope.kind !== 'full' || report.scope.lanes.length || report.scope.completeSelection
    || report.scope.scenarioIds.length !== selected.size || new Set(report.scope.scenarioIds).size !== selected.size
    || report.scope.scenarioIds.some(id => !selected.has(id))) {
    reasons.push('Affected conformance raw scope must match exactly the requested scenario IDs, without lane or smoke filters.')
  }
  if (missingIds.length || unexpectedIds.length) reasons.push('Affected conformance terminal outcomes do not match the requested scenario IDs.')
  if (!report.executed) reasons.push('Zero executed conformance scenarios; setup outcomes are not executed tests.')
  if (failedIds.length) reasons.push('Every selected conformance scenario must execute and pass.')
  if (report.setupError !== undefined) reasons.push('Conformance runner setup failed.')
  if (report.cleanupError !== undefined) reasons.push('Conformance runner cleanup failed.')
  if (report.status !== 'passed') reasons.push('The affected conformance launcher reported a failure.')
  return { schemaVersion: 1, repository: report.repository, baselineSha: report.baselineSha, commitSha: report.commitSha,
    commitSource: report.commitSource, target: report.target, mode: 'affected', status: reasons.length ? 'failed' : 'passed',
    reasons, evidence: 'validated', launcherExit, inventorySelected: inventory.scenarios.length, fullConformance,
    selection: { scenarioIds: [...selectionIds], requested: selectionIds.length, reported: report.totals.total, executed: report.executed,
      passedIds, failedIds, missingIds, unexpectedIds },
    skeleton: { status: 'not-established', reason: 'An affected selection does not establish complete skeleton acceptance.' },
    nonRegression: { status: 'not-established', reason: 'An affected selection does not establish full exact-main non-regression.' } }
}

/** Evaluate an early or complete gate without rewriting any scenario outcome, coverage claim, or run identity. */
export function conformanceGate(raw, expected, { selectionIds, mode = selectionIds === undefined ? 'incremental' : 'affected',
  launcherExit, mainReport, mainCommitSha } = {}) {
  if (!['incremental', 'complete', 'affected'].includes(mode)) throw new Error('CONFORMANCE_GATE must be incremental or complete or affected.')
  const inventory = validateConformanceInventory(expected?.inventory, expected?.target)
  const report = validateConformanceReport(raw, { ...expected, inventory })
  const fullConformance = fullConformanceVerdict(report)
  if (mode === 'affected') {
    if (mainReport !== undefined || mainCommitSha !== undefined) throw new Error('Affected conformance cannot establish a full exact-main comparison.')
    return affectedGate(report, inventory, fullConformance, selectionIds, launcherExit)
  }
  if (selectionIds !== undefined) throw new Error('Explicit scenario IDs require the affected conformance policy.')
  const skeleton = requiredSkeleton(report)
  const nonRegression = compareMain(report, mainReport, mainCommitSha)
  const reasons = launcherFailures(report, launcherExit)
  if (!report.scope.completeSelection) reasons.push('The CI gate requires the full, unfiltered conformance selection.')
  if (!report.totals.total) reasons.push('Zero selected conformance scenarios.')
  if (!report.executed) reasons.push('Zero executed conformance scenarios; setup failures are not executed tests.')
  if (report.setupError !== undefined) reasons.push('Conformance runner setup failed.')
  if (report.cleanupError !== undefined) reasons.push('Conformance runner cleanup failed.')
  if (report.status === 'failed' && !report.totals.failed && report.coverage.complete
    && report.setupError === undefined && report.cleanupError === undefined) {
    reasons.push('Conformance runner reported an unexplained failure outside scenario outcomes and coverage.')
  }
  if (report.target === 'go' && skeleton.status !== 'passed') {
    reasons.push('Go acceptance requires a nonempty SKEL selection with every SKEL scenario executed and passed.')
  }
  if (nonRegression.status === 'failed') reasons.push('Scenarios that passed on the supplied exact-main report regressed.')
  if (mode === 'complete' && fullConformance.status !== 'passed') reasons.push(...fullConformance.reasons)
  return { schemaVersion: 1, repository: report.repository, baselineSha: report.baselineSha, commitSha: report.commitSha,
    commitSource: report.commitSource, target: report.target, mode, status: reasons.length ? 'failed' : 'passed',
    reasons, evidence: 'validated', launcherExit, inventorySelected: inventory.scenarios.length,
    fullConformance, skeleton, nonRegression }
}

function readGate(values) {
  const expected = { target: values.target, commitSha: values.commit, commitSource: values['commit-source'],
    inventory: readJsonReport(values.inventory) }
  const launcherExit = /^[0-9]+$/.test(values['launcher-exit']) ? Number(values['launcher-exit']) : NaN
  const options = { mode: process.env.CONFORMANCE_GATE ?? (values.selection ? 'affected' : 'incremental'), launcherExit }
  if (values.selection) options.selectionIds = readJsonReport(values.selection)
  if (values['main-input'] !== undefined || values['main-commit'] !== undefined) {
    if (!values['main-input'] || !values['main-commit']) {
      throw new Error('An exact-main conformance report and its explicit fork commit SHA must be supplied together.')
    }
    options.mainReport = readJsonReport(values['main-input'])
    options.mainCommitSha = values['main-commit']
  }
  return conformanceGate(readJsonReport(values.input), expected, options)
}

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, inventory: { type: 'string' },
    output: { type: 'string' }, target: { type: 'string' }, commit: { type: 'string' },
    'commit-source': { type: 'string' }, 'launcher-exit': { type: 'string' },
    selection: { type: 'string' },
    'main-input': { type: 'string' }, 'main-commit': { type: 'string' } } })
  if (!values.input || !values.inventory || !values.output || !values.target || !values.commit
    || !values['commit-source'] || values['launcher-exit'] === undefined) {
    throw new Error('Usage: ci-conformance-gate.mjs --target go|ts --input <raw.json> --inventory <inventory.json> --output <gate.json> --commit <sha> --commit-source git|environment --launcher-exit <code> [--selection <scenario-ids.json>] [--main-input <main.json> --main-commit <sha>]')
  }
  const evidencePaths = [values.input, values.inventory, values.selection, values['main-input']].filter(Boolean).map(path => resolve(path))
  if (evidencePaths.includes(resolve(values.output))) {
    throw new Error('The conformance gate output must be separate from its retained raw report, inventory, and exact-main evidence.')
  }
  let gate
  try {
    gate = readGate(values)
  } catch (error) {
    gate = { schemaVersion: 1, target: values.target, mode: process.env.CONFORMANCE_GATE ?? (values.selection ? 'affected' : 'incremental'),
      status: 'failed', evidence: 'invalid', reasons: [error.message],
      fullConformance: { status: 'not-evaluated', reason: 'See the retained raw report and full-verdict artifact.' },
      nonRegression: { status: 'not-evaluated', reason: 'Conformance gate evidence is invalid or missing.' } }
  }
  writeJsonReport(values.output, gate)
  process.stdout.write(`Conformance ${gate.target}: ${gate.mode} CI gate ${gate.status}; full conformance ${gate.fullConformance.status}; exact-main non-regression ${gate.nonRegression.status}.\n`)
  for (const reason of gate.reasons) process.stderr.write(`${reason}\n`)
  if (gate.nonRegression.reason) process.stdout.write(`${gate.nonRegression.reason}\n`)
  if (gate.evidence === 'validated') {
    process.stdout.write(`Raw conformance status ${gate.fullConformance.reportedStatus}; ${gate.fullConformance.executed}/${gate.fullConformance.totals.total} scenarios executed. The raw report is unchanged.\n`)
  }
  if (gate.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
