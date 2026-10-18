import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

// Public executor regressions use the shared fake Go process boundary, never real Go receipts.
const selector = 'scripts/native-adapter.test.mjs'
const plan = 'scripts/native-plan.json'
const adapter = `import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeSelectorBinding, repositoryRoot } from './ci-affected-scope.mjs'
test('executes the exact fixture native action', () => {
  const binding = nativeSelectorBinding('${selector}')
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/ci-affected-run.mjs'),
    binding.suite, '--files-from', join(repositoryRoot, binding.selection)],
    { cwd: repositoryRoot, env: environment, stdio: 'inherit' })
  assert.ifError(result.error)
  assert.equal(result.status, 0)
})
`
const reporter = `import { rmSync } from 'node:fs'
import { join } from 'node:path'
export default async function* report(events) {
  for await (const event of events) void event
  if (process.env.FIXTURE_WRAPPER_REPORT_MODE === 'absent') {
    process.once('exit', () => rmSync(join(process.env.CI_NATIVE_REPORTS_DIR, 'wrapper.json'), { force: true }))
  } else yield '{ malformed wrapper output'
}
`
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

for (const mode of ['absent', 'malformed']) {
  test(`the bound public executor keeps native results when the wrapper report is ${mode}`, t => {
    const fixture = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '',
      FIXTURE_WRAPPER_REPORT_MODE: mode })
    const root = fixture.directory
    mkdirSync(join(root, 'backend/runtime'), { recursive: true })
    writeFileSync(join(root, 'backend/runtime/runtime_test.go'),
      'package runtime\n\nimport "testing"\n\nfunc TestRuntimeState(t *testing.T) {}\n')
    writeFileSync(join(root, plan), JSON.stringify({ files: ['backend/runtime/runtime_test.go'],
      goTestRoots: { './runtime': ['TestRuntimeState'] } }))
    writeFileSync(join(root, selector), adapter)
    writeFileSync(join(root, 'scripts/ci-native-selectors.json'), JSON.stringify({
      [selector]: { suite: 'unit-api', selection: plan },
    }))
    // A standard Node reporter controls only the copied fixture's wrapper-output boundary.
    writeFileSync(join(root, 'scripts/ci-node-test-reporter.mjs'), reporter)
    const selection = join(root, 'selected.json')
    writeFileSync(selection, JSON.stringify([selector]))
    const result = spawnSync(process.execPath, [join(root, 'scripts/ci-affected-run.mjs'),
      'unit', '--files-from', selection], { cwd: root, env: fixture.environment, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Cannot read the raw wrapper report/)
    const results = fixture.results()
    assert.deepEqual(results.summary, { passed: 1, failed: 0, skipped: 0 })
    assert.deepEqual(results.files.find(file => file.file === 'backend/runtime').tests,
      [{ name: 'TestRuntimeState', status: 'passed', durationMs: 250 }])
    const failedAdapter = results.files.find(file => file.file === selector)
    assert.equal(failedAdapter.status, 'failed')
    assert.deepEqual(failedAdapter.tests, [])

    const sessions = join(fixture.state, 'go/native-reports')
    const entries = readdirSync(sessions)
    assert.equal(entries.length, 1)
    const session = join(sessions, entries[0])
    const metadata = readJson(join(session, 'metadata.json'))
    assert.equal(metadata.selector, selector)
    assert.equal(metadata.failed, true)
    assert.equal(metadata.wrapperExit, 0)
    assert.ok(metadata.wrapperReadError)
    assert.deepEqual(metadata.nativeCounts, { reported: 1, executed: 1, passed: 1, failed: 0, skipped: 0 })
    assert.deepEqual(readJson(join(session, 'wrapper-status.json')).termination, { exitCode: 0, signal: null })
    if (mode === 'absent') assert.equal(existsSync(join(session, 'wrapper.json')), false)
    else assert.equal(readFileSync(join(session, 'wrapper.json'), 'utf8'), '{ malformed wrapper output')
    const publication = readJson(join(session, 'publication-go-unit.json'))
    assert.equal(publication.exitCode, 0)
    assert.deepEqual(publication.report.testResults.flatMap(file => file.assertionResults.map(item => item.fullName)),
      ['TestRuntimeState'])
    const action = readJson(join(session, 'suite-state/go/unit.action-status.json'))
    assert.equal(action.nativeExit, 0)
    assert.equal(action.converterExit, 0)
    assert.equal(action.actionExit, 0)
    const commands = fixture.calls().filter(call => call.tool === 'go' && call.args[0] === 'test')
    assert.deepEqual(commands.map(call => call.args),
      [['test', '-json', '-count=1', '-run', '^(TestRuntimeState)$', './runtime']])
  })
}
