// Bind a selected JS/TS adapter to real native reports without counting its success assertion as a Go case.
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CONFORMANCE_LANES } from './ci-conformance-report.mjs'
import { readJsonReport, writeJsonReport } from './ci-report-io.mjs'

const kinds = ['go-unit', 'go-integration', 'conformance-go', 'conformance-ts']
const statuses = ['passed', 'failed', 'skipped']
const publicationPrefix = 'publication-'
const emptyCounts = () => ({ reported: 0, executed: 0, passed: 0, failed: 0, skipped: 0 })
const publicationPath = (directory, kind) => join(directory, `${publicationPrefix}${kind}.json`)
const localFile = (file, repository) => (isAbsolute(file) ? relative(repository, file) : file).replaceAll('\\', '/')

function selectorPath(selector) {
  if (typeof selector !== 'string' || !selector || posix.isAbsolute(selector) || win32.isAbsolute(selector)
    || selector.includes('\\') || selector.includes('\0') || posix.normalize(selector) !== selector
    || selector.split('/').includes('..') || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(selector)) {
    throw new Error('Native reports require the exact real repository test selector.')
  }
  return selector
}

function checkedExpectation(value, selector) {
  if (value?.schemaVersion !== 1 || value.selector !== selectorPath(selector)
    || !Array.isArray(value.requiredKinds) || !Array.isArray(value.optionalKinds)) {
    throw new Error('Native report expectation does not match its selected adapter.')
  }
  const expected = [...value.requiredKinds, ...value.optionalKinds]
  if (expected.some(kind => !kinds.includes(kind)) || new Set(expected).size !== expected.length) {
    throw new Error('Native report expectation needs distinct supported report kinds.')
  }
  return value
}

function expectation(directory, selector) {
  return checkedExpectation(readJsonReport(join(directory, 'expected.json')), selector)
}

/** The executor writes this before launching a bound adapter, including an empty binding for ordinary JS. */
export function expectNativeReports({ directory, selector, requiredKinds = [], optionalKinds = [] }) {
  const value = checkedExpectation({ schemaVersion: 1, selector, requiredKinds, optionalKinds }, selector)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!lstatSync(directory).isDirectory() || readdirSync(directory).length) {
    throw new Error('Native report collection needs a fresh owned directory.')
  }
  writeFileSync(join(directory, 'expected.json'), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
}

/** Register before native setup. A setup failure leaves a visible unfinished expectation. */
export function beginNativeReport({ directory, selector, kind }) {
  const expected = expectation(directory, selector)
  if (![...expected.requiredKinds, ...expected.optionalKinds].includes(kind)) {
    throw new Error(`The selected adapter is not bound to native report kind ${kind}.`)
  }
  writeFileSync(publicationPath(directory, kind), `${JSON.stringify({ schemaVersion: 1, selector, kind, state: 'started' })}\n`,
    { mode: 0o600, flag: 'wx' })
}

function nativeNamespace(name, kind) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0')
    || posix.normalize(name) !== name || name.split('/').includes('..')) return false
  if (kind.startsWith('go-')) return name === 'backend' || name.startsWith('backend/')
  const target = kind.slice('conformance-'.length)
  return [...CONFORMANCE_LANES, 'setup', 'cleanup'].some(lane => name === `conformance/${target}/${lane}`)
}

function validateNativeReport(report, kind) {
  if (!report || !Array.isArray(report.testResults)) throw new Error('Native publication is not a complete test report.')
  for (const row of report.testResults) {
    if (!nativeNamespace(row?.name, kind) || !statuses.includes(row.status) || !Array.isArray(row.assertionResults)) {
      throw new Error(`Native publication does not preserve its ${kind} result namespace.`)
    }
    for (const test of row.assertionResults) {
      if (typeof test?.fullName !== 'string' || !test.fullName.trim() || !statuses.includes(test.status)
        || test.duration !== null && (!Number.isFinite(test.duration) || test.duration < 0)
        || test.failureMessages !== undefined && (!Array.isArray(test.failureMessages)
          || test.failureMessages.some(message => typeof message !== 'string'))) {
        throw new Error(`Native publication in ${row.name} has an invalid named case.`)
      }
    }
  }
  return report
}

/** Complete even a failed/zero native action; its real report and exit remain independent facts. */
export function finishNativeReport({ directory, selector, kind, reportPath, exitCode }) {
  const expected = expectation(directory, selector)
  if (![...expected.requiredKinds, ...expected.optionalKinds].includes(kind)) throw new Error('Unbound native report completion.')
  const path = publicationPath(directory, kind)
  const started = readJsonReport(path)
  if (started.schemaVersion !== 1 || started.selector !== selector || started.kind !== kind || started.state !== 'started') {
    throw new Error('Native report was not registered exactly once before execution.')
  }
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error('Native action exit code is missing or invalid.')
  const report = validateNativeReport(readJsonReport(reportPath), kind)
  writeJsonReport(path, { ...started, state: 'complete', exitCode, report })
}

function publication(directory, name, expected, seen) {
  const value = readJsonReport(join(directory, name))
  if (value.schemaVersion !== 1 || value.selector !== expected.selector || !kinds.includes(value.kind)
    || name !== `${publicationPrefix}${value.kind}.json`
    || ![...expected.requiredKinds, ...expected.optionalKinds].includes(value.kind)
    || value.state !== 'complete' || !Number.isInteger(value.exitCode) || value.exitCode < 0) {
    throw new Error(`Missing, unfinished or unbound native report: ${name}.`)
  }
  validateNativeReport(value.report, value.kind)
  const identities = value.report.testResults.flatMap(row => row.assertionResults.map(test => JSON.stringify([row.name, test.fullName])))
  if (new Set(identities).size !== identities.length || identities.some(identity => seen.has(identity))) {
    throw new Error('Duplicate native case identity across report publications.')
  }
  for (const identity of identities) seen.add(identity)
  return value
}

function countsFor(value) {
  const counts = emptyCounts()
  for (const row of value.report.testResults) {
    for (const test of row.assertionResults) {
      if (value.kind.startsWith('go-') && test.fullName.startsWith('Benchmark')) continue
      counts.reported++
      counts[test.status]++
      if (test.status !== 'skipped') counts.executed++
    }
  }
  return counts
}

const wrapperRow = row => typeof row?.name === 'string' && Boolean(row.name.trim()) && Array.isArray(row.assertionResults)
const wrapperCase = test => typeof (test?.fullName || test?.title) === 'string'
  && Boolean((test.fullName || test.title).trim()) && [...statuses, 'pending', 'todo'].includes(test.status)

function wrapperRows(wrapperReport, selector, repository, substitute) {
  if (!wrapperReport || !Array.isArray(wrapperReport.testResults)
    || wrapperReport.testResults.some(row => !wrapperRow(row) || !row.assertionResults.every(wrapperCase))) {
    throw new Error('The selected adapter did not publish a complete wrapper report.')
  }
  return wrapperReport.testResults.flatMap(row => {
    if (!substitute || localFile(row.name, repository) !== selector) return [row]
    const assertionResults = row.assertionResults.filter(test => test.status !== 'passed')
    return assertionResults.length || row.status === 'failed' ? [{ ...row, assertionResults }] : []
  })
}

/** Return native rows plus genuine wrapper failures/unrelated JS; no synthetic named tests are created. */
export function adoptNativeReports(wrapperReport, { directory, repository, selector, wrapperExit }) {
  const diagnostics = []
  const nativeCounts = emptyCounts()
  const reports = []
  let expected
  let rows = []
  try {
    expected = expectation(directory, selector)
    const names = readdirSync(directory).filter(name => name.startsWith(publicationPrefix))
    const seen = new Set()
    for (const kind of expected.requiredKinds) {
      if (!names.includes(`${publicationPrefix}${kind}.json`)) diagnostics.push(`Required native report is missing: ${kind}.`)
    }
    for (const name of names) {
      try {
        const value = publication(directory, name, expected, seen)
        const counts = countsFor(value)
        for (const key of Object.keys(nativeCounts)) nativeCounts[key] += counts[key]
        if (!counts.executed) diagnostics.push(`${value.kind} reported zero executed native cases.`)
        if (value.exitCode !== 0 || counts.failed || value.report.testResults.some(row => row.status === 'failed')) {
          diagnostics.push(`${value.kind} native action failed (exit ${value.exitCode}).`)
        }
        reports.push(value.report)
      } catch (error) {
        diagnostics.push(error.message)
      }
    }
    const bound = expected.requiredKinds.length + expected.optionalKinds.length > 0
    rows = wrapperRows(wrapperReport, selector, repository, bound)
    if (bound && !wrapperReport.testResults.some(row => localFile(row.name, repository) === selector)) {
      diagnostics.push('The bound adapter has no attributable wrapper result.')
    }
  } catch (error) {
    diagnostics.push(error.message)
    // Keep only attributable real wrapper assertions. A malformed row must not poison the
    // valid native publications or turn an absent assertion into an "Unnamed test" count.
    const readable = Array.isArray(wrapperReport?.testResults) ? wrapperReport.testResults.filter(wrapperRow)
      .map(row => ({ ...row, assertionResults: row.assertionResults.filter(wrapperCase) })) : []
    const bound = expected && expected.requiredKinds.length + expected.optionalKinds.length > 0
    rows = wrapperRows({ testResults: readable }, selector, repository, bound)
  }
  if (!Number.isInteger(wrapperExit) || wrapperExit !== 0) diagnostics.push(`The wrapper command failed (exit ${wrapperExit}).`)
  if (rows.some(row => row.status === 'failed' || row.assertionResults?.some(test => test.status === 'failed'))) {
    diagnostics.push('The wrapper report contains a real failure.')
  }
  if (diagnostics.length && !rows.some(row => localFile(row.name, repository) === selector && row.status === 'failed')) {
    rows.push({ name: selector, status: 'failed', duration: null, assertionResults: [], message: diagnostics.join('\n') })
  }
  return { report: { testResults: [...rows, ...reports.flatMap(report => report.testResults)] },
    failed: diagnostics.length > 0, diagnostics, nativeCounts }
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    kind: { type: 'string' }, input: { type: 'string' }, 'exit-code': { type: 'string' },
  } })
  if (positionals.length !== 1 || !['begin', 'finish'].includes(positionals[0])) throw new Error('Use begin or finish for one native report.')
  const options = { directory: process.env.CI_NATIVE_REPORTS_DIR, selector: process.env.CI_NATIVE_SELECTOR, kind: values.kind }
  if (!options.directory || !options.selector) throw new Error('Native reporting must be bound by the affected executor.')
  if (positionals[0] === 'begin') beginNativeReport(options)
  else finishNativeReport({ ...options, reportPath: values.input,
    exitCode: /^[0-9]+$/.test(values['exit-code'] ?? '') ? Number(values['exit-code']) : NaN })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
