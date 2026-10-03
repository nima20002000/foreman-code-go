import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { TEST_FILE, findUnrunTests, readTestResults } from './test-results.mjs'

const directory = process.env.TEST_RESULTS_DIR
if (!directory) throw new Error('Set TEST_RESULTS_DIR to the directory the test runs wrote their results to.')

const policy = JSON.parse(readFileSync(new URL('../test-policy.json', import.meta.url), 'utf8'))
const testFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((path) => TEST_FILE.test(path))
const { neverRan, missingFiles, staleOptIns } = findUnrunTests({
  results: readTestResults(directory),
  testFiles,
  optInFiles: policy.optInSuites.map((suite) => suite.file),
})

const problems = [
  ['Tests that were skipped in every CI run', neverRan],
  ['Test files that no CI run executed', missingFiles],
  ['Opt-in suites in test-policy.json that no longer exist', staleOptIns],
].filter(([, items]) => items.length > 0)

for (const [title, items] of problems) process.stderr.write(`${title}:\n${items.map((item) => `  ${item}`).join('\n')}\n`)
if (problems.length > 0) {
  process.stderr.write('Every test must run in CI. Make it run, or delete it with a replacement that covers the behavior.\n')
  process.exit(1)
}
