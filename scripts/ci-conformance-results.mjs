// Normalizes launcher reports without changing CiTestResultsSchema or conformance expectations.
// The launcher must supply Vitest results and conformance: { target, selected, complete: true }.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readJsonReport, writeJsonReport } from './ci-report-io.mjs'
import { measuredUnitDurations } from './ci-unit-files.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const lanes = ['SKEL', 'E', 'H', 'J', 'A1', 'S', 'R', 'A2']
const skippedStatuses = new Set(['pending', 'skipped', 'todo', 'disabled'])

function scenarioResult(test) {
  const match = typeof test?.fullName === 'string' && /^\[([A-Z][A-Z0-9]*)\]\s+(.+)/.exec(test.fullName)
  if (!match || !lanes.includes(match[1])) throw new Error('Every conformance scenario needs an owning [LANE] in fullName.')
  let status = test.status
  if (skippedStatuses.has(status)) status = 'skipped'
  if (!['passed', 'failed', 'skipped'].includes(status)) throw new Error(`Unfinished conformance scenario: ${test.fullName}.`)
  const duration = test.duration ?? null
  if (duration !== null && (!Number.isFinite(duration) || duration < 0)
    || duration === null && status !== 'skipped') {
    throw new Error(`Missing or invalid measured duration for conformance scenario ${test.fullName}.`)
  }
  if (test.failureMessages !== undefined && (!Array.isArray(test.failureMessages)
    || test.failureMessages.some(message => typeof message !== 'string'))) {
    throw new Error(`Invalid failure detail for conformance scenario ${test.fullName}.`)
  }
  return { lane: match[1], assertion: { fullName: test.fullName, status, duration,
    ...(test.failureMessages ? { failureMessages: test.failureMessages } : {}) } }
}

function includeFileDuration(group, result) {
  if (!Number.isFinite(result.startTime) || !Number.isFinite(result.endTime) || result.endTime < result.startTime) {
    group.missingTiming = true
    return
  }
  group.start = Math.min(group.start, result.startTime)
  group.end = Math.max(group.end, result.endTime)
}

/** Exact scenario counts and completion are checked before grouping by target and owning lane. */
export function conformanceResults(report, target) {
  if (!['go', 'ts'].includes(target)) throw new Error('Conformance target must be go or ts.')
  const metadata = report?.conformance
  if (metadata?.target !== target || metadata.complete !== true || !Number.isSafeInteger(metadata.selected)
    || metadata.selected < 0 || !Array.isArray(report.testResults)) {
    throw new Error('Expected a complete conformance report with the requested target and selected scenario count.')
  }
  if (report.success !== undefined && typeof report.success !== 'boolean') throw new Error('Invalid conformance runner success status.')
  const groups = new Map()
  const totals = Object.fromEntries(lanes.map(lane => [lane, { passed: 0, failed: 0, skipped: 0 }]))
  const names = new Set()
  const diagnostics = []
  let failed = false
  for (const result of report.testResults) {
    if (!result || typeof result.name !== 'string' || !result.name || !Array.isArray(result.assertionResults)
      || !['passed', 'failed', 'skipped'].includes(result.status)) {
      throw new Error('Invalid or incomplete conformance test file.')
    }
    if (result.status === 'failed') {
      failed = true
      diagnostics.push(`Conformance ${target} file failed: ${result.name}${result.message ? `: ${result.message}` : ''}`)
    }
    const fileFailure = result.status === 'failed' && !result.assertionResults.some(test => test?.status === 'failed')
    const affectedLanes = new Set()
    for (const test of result.assertionResults) {
      const { lane, assertion } = scenarioResult(test)
      if (names.has(assertion.fullName)) throw new Error(`Duplicate conformance scenario: ${assertion.fullName}.`)
      names.add(assertion.fullName)
      totals[lane][assertion.status]++
      if (assertion.status === 'failed') failed = true
      affectedLanes.add(lane)
      const group = groups.get(lane) ?? { name: `conformance/${target}/${lane}`, status: 'passed',
        assertionResults: [], start: Infinity, end: -Infinity, missingTiming: false }
      group.assertionResults.push(assertion)
      if (assertion.status === 'failed' || fileFailure) group.status = 'failed'
      groups.set(lane, group)
    }
    for (const lane of affectedLanes) includeFileDuration(groups.get(lane), result)
  }
  if (names.size !== metadata.selected || report.numTotalTests !== undefined && report.numTotalTests !== names.size) {
    throw new Error(`Conformance scenario count mismatch: selected ${metadata.selected}, reported ${names.size}.`)
  }
  const testResults = lanes.filter(lane => groups.has(lane)).map(lane => {
    const { name, assertionResults, start, end, missingTiming } = groups.get(lane)
    let status = groups.get(lane).status
    if (status !== 'failed' && assertionResults.every(test => test.status === 'skipped')) status = 'skipped'
    return { name, status, assertionResults, duration: missingTiming ? null : end - start }
  })
  failed ||= testResults.some(result => result.status === 'failed')
  if (report.success === true && failed) throw new Error('Inconsistent conformance report: success with failed results.')
  if (report.success === false && !failed) diagnostics.push(`Conformance ${target} runner reported a failure outside scenario results.`)
  failed ||= report.success === false
  const executed = Object.values(totals).reduce((count, lane) => count + lane.passed + lane.failed, 0)
  return { report: { testResults }, totals, selected: names.size, executed, failed, diagnostics }
}

export function conformanceSummary(result, target) {
  const total = { passed: 0, failed: 0, skipped: 0 }
  for (const counts of Object.values(result.totals)) {
    for (const status of Object.keys(total)) total[status] += counts[status]
  }
  const summary = [`Conformance ${target}: ${total.passed}/${result.selected} passed; ${total.failed} failed; ${total.skipped} skipped; ${result.executed} executed.`]
  for (const lane of lanes) {
    const counts = result.totals[lane]
    const selected = counts.passed + counts.failed + counts.skipped
    summary.push(`  ${lane}: ${counts.passed}/${selected} passed; ${counts.failed} failed; ${counts.skipped} skipped.`)
  }
  return `${summary.join('\n')}\n`
}

function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' },
    target: { type: 'string' }, durations: { type: 'string' } } })
  if (!values.input || !values.output || !values.target) {
    throw new Error('Usage: ci-conformance-results.mjs --target go|ts --input <report.json> --output <normalized.json> [--durations <durations.json>]')
  }
  const result = conformanceResults(readJsonReport(values.input), values.target)
  writeJsonReport(values.output, result.report)
  if (values.durations) writeJsonReport(values.durations, measuredUnitDurations(result.report, root, 'conformance'))
  process.stdout.write(conformanceSummary(result, values.target))
  for (const message of result.diagnostics) process.stderr.write(`${message}\n`)
  if (!result.selected) process.stderr.write('Conformance selection is empty: zero selected scenarios.\n')
  else if (!result.executed) process.stderr.write('Conformance scenarios all skipped: zero executed scenarios.\n')
  if (!result.executed || result.failed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
