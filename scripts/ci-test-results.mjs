// Turns Vitest JSON reports into the bounded structured test results a CI ticket keeps (CiTestResultsSchema).
//   node scripts/ci-test-results.mjs <output> <vitest-report.json>...
// Missing or unreadable reports are skipped; nothing is written when none can be read.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// Keep in step with CI_TEST_RESULT_LIMITS in packages/contracts/src/ciHost.ts.
export const CI_TEST_RESULT_LIMITS = { tests: 600, files: 300, name: 200, file: 200, message: 240 }
const rank = { failed: 0, skipped: 1, passed: 2 }
const DAY_MS = 24 * 3_600_000

const clip = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value
const testStatus = value => value === 'passed' || value === 'failed' ? value : 'skipped'
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, DAY_MS) : null
// Terminal colors and control characters say nothing in a table.
const plain = value => String(value ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

/** Merges Vitest JSON reports. Failed tests are kept first, then skipped, then passed; summary counts every test. */
export function ciTestResults(reports, repository = root) {
  const summary = { passed: 0, failed: 0, skipped: 0 }
  const byFile = new Map()
  for (const report of reports) {
    for (const result of Array.isArray(report?.testResults) ? report.testResults : []) {
      if (typeof result?.name !== 'string' || !result.name) continue
      const path = (isAbsolute(result.name) ? relative(repository, result.name) : result.name).replaceAll('\\', '/')
      const tests = (Array.isArray(result.assertionResults) ? result.assertionResults : []).map(test => {
        const status = testStatus(test?.status)
        summary[status]++
        const name = clip(plain(test?.fullName || test?.title).trim() || 'Unnamed test', CI_TEST_RESULT_LIMITS.name)
        const failure = Array.isArray(test?.failureMessages) ? test.failureMessages[0] : undefined
        const message = status === 'failed' ? clip(plain(failure).trim(), CI_TEST_RESULT_LIMITS.message) : ''
        return { name, status, durationMs: duration(test?.duration), ...(message ? { message } : {}) }
      })
      let status = 'passed'
      if (result.status === 'failed' || tests.some(test => test.status === 'failed')) status = 'failed'
      else if (tests.length && tests.every(test => test.status === 'skipped')) status = 'skipped'
      const file = clip(path || 'unknown file', CI_TEST_RESULT_LIMITS.file)
      byFile.set(file, { file, status, durationMs: duration(result.endTime - result.startTime), tests })
    }
  }
  const files = [...byFile.values()].sort((left, right) => rank[left.status] - rank[right.status]
    || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  const kept = files.slice(0, CI_TEST_RESULT_LIMITS.files)
  const all = kept.flatMap((file, fileIndex) => file.tests.map((test, index) => ({ fileIndex, index, rank: rank[test.status] })))
  const chosen = new Set(all.sort((left, right) => left.rank - right.rank || left.fileIndex - right.fileIndex
    || left.index - right.index).slice(0, CI_TEST_RESULT_LIMITS.tests).map(entry => `${entry.fileIndex}:${entry.index}`))
  const tests = summary.passed + summary.failed + summary.skipped
  return { summary, truncated: kept.length < files.length || chosen.size < tests,
    files: kept.map((file, fileIndex) => ({ ...file, tests: file.tests.filter((_, index) => chosen.has(`${fileIndex}:${index}`)) })) }
}

function readReport(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null }
  catch { return null }
}

/** Writes the merged results of the readable reports; returns whether any could be read. */
export function writeCiTestResults(output, paths, repository = root) {
  const reports = paths.map(readReport).filter(Boolean)
  if (!reports.length) return false
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(ciTestResults(reports, repository)), { mode: 0o600 })
  renameSync(temporary, output)
  return true
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const [output, ...reports] = process.argv.slice(2)
  if (!output) throw new Error('Usage: ci-test-results.mjs <output> <vitest-report.json>...')
  writeCiTestResults(resolve(output), reports.map(path => resolve(path)))
}
