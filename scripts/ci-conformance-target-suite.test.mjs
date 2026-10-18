import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { conformanceScenario } from './test-support/conformance-report-fixture.mjs'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

// Synthetic process/report fixtures test suite routing only; the six real scenarios require separate CI tickets.
const selected = conformanceScenario()
const readReport = (fixture, suffix) => JSON.parse(readFileSync(join(fixture.state, 'conformance', `ts.${suffix}`), 'utf8'))
const launches = fixture => fixture.calls().filter(call => call.tool === 'corepack' && call.args.includes('run')
  && call.args[call.args.indexOf('run') + 1] === 'conformance' && !call.args.includes('--list'))

function scopedSuite(t, mode = '') {
  const fixture = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '',
    CONFORMANCE_TS_MODE: mode, FAIL_GO_COMMAND: 'build', CONFORMANCE_CHANGED: 'unknown' })
  const source = 'conformance/src/selected.ts'
  mkdirSync(join(fixture.directory, 'conformance/src'), { recursive: true })
  writeFileSync(join(fixture.directory, source), 'export {}\n')
  const selection = join(fixture.directory, 'selected-conformance.json')
  writeFileSync(selection, JSON.stringify({ files: [source], conformanceScenarios: [selected.id],
    conformanceTarget: 'ts', conformanceTsRequired: false }))
  fixture.environment.CI_AFFECTED_SELECTION_FILE = selection
  return fixture
}

test('the public suite routes an explicit TS selection and preserves synthetic fixture outcome fields', t => {
  const fixture = scopedSuite(t)
  const prepared = fixture.run('integration', 'prepare')
  assert.equal(prepared.status, 0, prepared.stderr)
  const result = fixture.run('integration')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(launches(fixture).map(call => ({ target: call.target,
    arguments: call.args.slice(call.args.indexOf('conformance', call.args.indexOf('run')) + 1) })),
  [{ target: 'ts', arguments: ['--target', 'ts', '--scenario', selected.id] }])
  assert.equal(fixture.calls().some(call => call.tool === 'go' || call.tool === 'gofmt' || call.tool === 'staticcheck'), false)
  assert.equal(fixture.calls().some(call => call.tool === 'docker' && call.args[0] === 'run'), false)
  const raw = readReport(fixture, 'json')
  assert.equal(raw.target, 'ts')
  assert.equal(raw.scope.completeSelection, false)
  assert.deepEqual(raw.scope.scenarioIds, [selected.id])
  assert.deepEqual(raw.scenarios.map(({ id, lane, durationMs, executed, status }) => ({ id, lane, durationMs, executed, status })),
    [{ id: selected.id, lane: 'SKEL', durationMs: 12, executed: true, status: 'passed' }])
  assert.equal(readReport(fixture, 'full-verdict.json').status, 'failed')
  assert.equal(readReport(fixture, 'gate.json').status, 'passed')
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
  assert.equal(fixture.isolatedHomeExists(), false)
})

for (const mode of ['failed', 'zero', 'setup']) {
  test(`explicit TS qualification preserves ${mode} outcomes without Go fallback or synthetic executed cases`, t => {
    const fixture = scopedSuite(t, mode)
    assert.equal(fixture.run('integration', 'prepare').status, 0)
    const result = fixture.run('integration')
    assert.notEqual(result.status, null)
    assert.notEqual(result.status, 0)
    assert.deepEqual(launches(fixture).map(call => call.target), ['ts'])
    assert.equal(fixture.calls().some(call => call.tool === 'go'), false)
    const raw = readReport(fixture, 'json')
    const gate = readReport(fixture, 'gate.json')
    const executed = mode === 'failed' ? 1 : 0
    assert.equal(raw.executed, executed)
    assert.equal(gate.selection.executed, executed)
    assert.equal(gate.status, 'failed')
    assert.notEqual(readReport(fixture, 'action-status.json').actionExit, 0)
    assert.deepEqual(fixture.results().summary, { passed: 0, failed: mode === 'failed' ? 1 : 0, skipped: 0 })
    assert.equal(fixture.isolatedHomeExists(), false)
  })
}
