// node:test reporter that records each test's outcome for scripts/check-test-results.mjs.
// Pair it with the spec reporter. It writes results only when TEST_RESULTS_DIR is set.
import { writeTestResults } from './test-results.mjs'

export default async function* nodeTestResultsReporter(source) {
  const ancestors = new Map()
  const tests = []
  for await (const event of source) {
    const { data } = event
    if (event.type === 'test:start') {
      const stack = ancestors.get(data.file) ?? []
      stack.length = data.nesting
      stack.push(data.name)
      ancestors.set(data.file, stack)
    }
    if ((event.type === 'test:pass' || event.type === 'test:fail') && data.details?.type !== 'suite' && data.file) {
      const path = (ancestors.get(data.file) ?? []).slice(0, data.nesting)
      tests.push({ file: data.file, name: [...path, data.name].join(' '), status: nodeStatus(event.type, data) })
    }
  }
  if (writeTestResults('node', tests)) yield `Recorded ${tests.length} test results.\n`
}

function nodeStatus(type, data) {
  if (data.todo !== undefined) return 'skipped'
  if (data.skip !== undefined) return 'skipped'
  return type === 'test:pass' ? 'passed' : 'failed'
}
