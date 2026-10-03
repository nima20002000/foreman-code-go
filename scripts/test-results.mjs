import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

// Test files, including ad hoc suffixes that lint rejects, so unrun ones are reported too.
export const TEST_FILE = /\.(?:test|smoke|model|qualification|node)\.[cm]?[jt]sx?$/

/** Vitest options that also write a JSON report when TEST_RESULTS_DIR is set. */
export function vitestResultOptions() {
  const directory = process.env.TEST_RESULTS_DIR
  if (!directory) return {}
  const ciReporters = process.env.GITHUB_ACTIONS ? ['github-actions'] : []
  return {
    reporters: ['default', ...ciReporters, 'json'],
    outputFile: { json: join(directory, `vitest-${randomUUID()}.json`) },
  }
}

/** Writes results when TEST_RESULTS_DIR is set, and reports whether it did. */
export function writeTestResults(runner, tests) {
  const directory = process.env.TEST_RESULTS_DIR
  if (!directory) return false
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${runner}-${randomUUID()}.json`), JSON.stringify({ runner, tests }))
  return true
}

function repositoryPath(file) {
  const path = file.startsWith('file://') ? fileURLToPath(file) : file
  return relative(repositoryRoot, path)
}

function vitestTests(report) {
  return report.testResults.flatMap((file) => file.assertionResults.map((test) => ({
    file: repositoryPath(file.name),
    name: test.fullName,
    status: ['passed', 'failed'].includes(test.status) ? test.status : 'skipped',
  })))
}

/** Reads every report in the directory as { file, name, status } with repository-relative files. */
export function readTestResults(directory) {
  return readdirSync(directory).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const report = JSON.parse(readFileSync(join(directory, name), 'utf8'))
    if (report.runner === 'node') return report.tests.map((test) => ({ ...test, file: repositoryPath(test.file) }))
    return vitestTests(report)
  })
}

/**
 * Finds tests that never executed in any run, and test files that produced no results.
 * Opt-in suites need external tools and are listed with a reason in test-policy.json.
 */
export function findUnrunTests({ results, testFiles, optInFiles }) {
  const optIn = new Set(optInFiles)
  const executed = new Set()
  const seen = new Map()
  for (const result of results) {
    const key = `${result.file} > ${result.name}`
    seen.set(key, result)
    if (result.status !== 'skipped') executed.add(key)
  }
  const reportedFiles = new Set(results.map((result) => result.file))
  const neverRan = [...seen.entries()]
    .filter(([key, result]) => !executed.has(key) && !optIn.has(result.file))
    .map(([key]) => key)
    .sort()
  const missingFiles = testFiles.filter((file) => !reportedFiles.has(file) && !optIn.has(file)).sort()
  const staleOptIns = optInFiles.filter((file) => !testFiles.includes(file)).sort()
  return { neverRan, missingFiles, staleOptIns }
}
