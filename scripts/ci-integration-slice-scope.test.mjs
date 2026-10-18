import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { environmentRequest, explicitRelease, validateAffectedSuite } from './ci-affected-scope.mjs'
import { integrationFileList } from './ci-files.mjs'
import { cloudSelectionFixture, cloudSuiteFixture } from './test-support/ci-cloud-path-fixture.mjs'

test('a full-labelled integration slice selects its actual bounded inventory before the release guard', t => {
  const f = cloudSelectionFixture(t)
  const environment = f.integrationEnvironment()
  let request
  assert.doesNotThrow(() => { request = environmentRequest(environment, f.directory) })
  assert.deepEqual(request.files, [f.integrationSelector])
  assert.equal(explicitRelease(environment, f.directory), false)
  assert.deepEqual(validateAffectedSuite('integration', request, f.directory).nativeReports,
    { [f.integrationSelector]: { requiredKinds: ['go-integration'], optionalKinds: [] } })
})

test('verified dispatch inputs retain a bounded integration slice when outer file inputs are empty', t => {
  const f = cloudSelectionFixture(t)
  const selected = f.integrationEnvironment()
  const bytes = JSON.stringify({ commit: '3'.repeat(40), files: '', partition: '', slice: selected.SLICE })
  f.put('ci-dispatch-inputs.json', bytes)
  const environment = { ...selected, SLICE: '', CI_PARTITION: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
  let request
  assert.doesNotThrow(() => { request = environmentRequest(environment, f.directory) })
  assert.deepEqual(request.files, [f.integrationSelector])
  assert.equal(explicitRelease(environment, f.directory), false)
  f.put('ci-dispatch-inputs.json', `${bytes}\n`)
  assert.throws(() => environmentRequest(environment, f.directory), /dispatch inputs hash mismatch/)
  assert.throws(() => explicitRelease(environment, f.directory), /dispatch inputs hash mismatch/)
})

test('invalid integration slices remain red and only an explicit release retains full semantics', t => {
  const f = cloudSelectionFixture(t)
  const environment = f.integrationEnvironment()
  for (const SLICE of ['1/1', `s:${integrationFileList(f.directory).length}`, 's:']) {
    assert.throws(() => explicitRelease({ ...environment, SLICE }, f.directory), /Invalid integration file index|selected zero files/)
  }
  assert.throws(() => explicitRelease(f.integrationEnvironment(f.unboundIntegration), f.directory), /Unsupported affected file/)
  assert.throws(() => explicitRelease({ ...environment, SLICE: '' }, f.directory), /Full CI scope is reserved/)
  assert.throws(() => explicitRelease({ ...environment, SUITE: 'unit-other' }, f.directory), /Full CI scope is reserved/)
  // Compatibility of the existing API only: the bounded lifecycle below never requests release mode.
  assert.equal(explicitRelease({ ...environment, FOREMAN_CODE_CI_RELEASE: '1' }, f.directory), true)
})

test('a bounded integration slice reaches its adapter and keeps the named native fixture result', t => {
  const f = cloudSuiteFixture(t)
  const environment = { ...f.integrationEnvironment(), TEST_RESULTS_OUTPUT: f.environment.TEST_RESULTS_OUTPUT,
    DURATIONS_OUTPUT: f.environment.DURATIONS_OUTPUT, CLOUD_FIXTURE_REAL_PATH: process.env.PATH }
  for (const phase of ['start', 'prepare']) {
    const prepared = f.run('integration', phase, environment)
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
  }
  const result = f.run('integration', '', environment)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const commands = f.calls().filter(call => call.tool === 'go' && call.args[0] === 'test')
  assert.deepEqual(commands.map(call => call.args), [
    ['test', '-json', '-count=1', '-tags', 'integration', '-run', '^(TestRuntimeState)$', './runtime'],
  ])
  const report = f.results()
  assert.deepEqual(report.summary, { passed: 1, failed: 0, skipped: 0 })
  assert.deepEqual(report.files.flatMap(file => file.tests), [
    { name: 'TestRuntimeState', status: 'passed', durationMs: 250 },
  ])
  assert.equal(f.isolatedHomeExists(), false)
})
