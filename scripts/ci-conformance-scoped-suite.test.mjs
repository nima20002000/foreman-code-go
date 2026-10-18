import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { conformanceScenario } from './test-support/conformance-report-fixture.mjs'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

// Candidate-entrypoint regressions use synthetic process/report fixtures, never native execution receipts.
const health = conformanceScenario()

function scopedSuite(t, { tsRequired = false, mode } = {}) {
  const fixture = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '',
    CONFORMANCE_GO_MODE: mode ?? '', CONFORMANCE_CHANGED: 'unknown' })
  const source = 'conformance/src/fixture.ts'
  mkdirSync(join(fixture.directory, 'conformance/src'), { recursive: true })
  writeFileSync(join(fixture.directory, source), '// Synthetic launcher scope fixture.\n')
  const selection = join(fixture.directory, 'affected-conformance.json')
  writeFileSync(selection, JSON.stringify({ files: [source], conformanceScenarios: [health.id],
    conformanceTsRequired: tsRequired }))
  fixture.environment.CI_AFFECTED_SELECTION_FILE = selection
  return fixture
}

const readReport = (fixture, target, suffix) => JSON.parse(readFileSync(join(fixture.state, 'conformance', `${target}.${suffix}`), 'utf8'))
const launches = fixture => fixture.calls().filter(call => call.tool === 'corepack' && call.args.includes('run')
  && call.args[call.args.indexOf('run') + 1] === 'conformance' && !call.args.includes('--list'))

for (const tsRequired of [false, true]) {
  test(`affected integration executes exact conformance IDs with explicit TS requirement ${tsRequired}`, t => {
    const fixture = scopedSuite(t, { tsRequired })
    const prepared = fixture.run('integration', 'prepare')
    assert.equal(prepared.status, 0, prepared.stderr)
    const result = fixture.run('integration')
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(launches(fixture).map(call => call.target), tsRequired ? ['go', 'ts'] : ['go'])
    for (const launch of launches(fixture)) {
      assert.deepEqual(launch.args.slice(launch.args.indexOf('conformance', launch.args.indexOf('run')) + 1),
        ['--scenario', health.id])
      const raw = readReport(fixture, launch.target, 'json')
      const gate = readReport(fixture, launch.target, 'gate.json')
      assert.equal(raw.scope.completeSelection, false)
      assert.deepEqual(raw.scope.scenarioIds, [health.id])
      assert.equal(raw.executed, 1)
      assert.deepEqual(raw.scenarios.map(scenario => [scenario.id, scenario.durationMs, scenario.lane]), [[health.id, 12, 'SKEL']])
      assert.equal(readReport(fixture, launch.target, 'full-verdict.json').status, 'failed')
      assert.equal(gate.status, 'passed')
      assert.equal(gate.selection.executed, 1)
      assert.equal(gate.nonRegression.status, 'not-established')
      assert.equal(readReport(fixture, launch.target, 'action-status.json').actionExit, 0)
    }
    assert.equal(fixture.calls().some(call => call.tool === 'git' && call.args[0] === 'fetch'), false)
    assert.equal(fixture.calls().some(call => call.tool === 'go' && call.args[0] === 'test'), false)
    assert.deepEqual(fixture.results().summary, { passed: tsRequired ? 2 : 1, failed: 0, skipped: 0 })
    assert.equal(fixture.isolatedHomeExists(), false)
  })
}

for (const mode of ['failed', 'zero', 'setup']) {
  test(`affected conformance ${mode} stays red while raw actual cases remain honest`, t => {
    const fixture = scopedSuite(t, { mode })
    assert.equal(fixture.run('integration', 'prepare').status, 0)
    const result = fixture.run('integration')
    assert.notEqual(result.status, null)
    assert.notEqual(result.status, 0)
    assert.equal(launches(fixture).length, 1)
    const raw = readReport(fixture, 'go', 'json')
    const gate = readReport(fixture, 'go', 'gate.json')
    const executed = mode === 'failed' ? 1 : 0
    assert.equal(raw.executed, executed)
    assert.equal(gate.selection.executed, executed)
    assert.equal(gate.status, 'failed')
    assert.notEqual(readReport(fixture, 'go', 'action-status.json').actionExit, 0)
    assert.deepEqual(fixture.results().summary, { passed: 0, failed: mode === 'failed' ? 1 : 0, skipped: 0 })
    assert.equal(fixture.isolatedHomeExists(), false)
  })
}
