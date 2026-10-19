import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readAffectedRequest, validateAffectedSuite } from './ci-affected-scope.mjs'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'
import { nativeActionFixture } from './test-support/ci-native-action-fixture.mjs'

// The external Go executable is a process fixture. These tests qualify public
// runner selection/reporting; actual S/H race detection is a separate remote CI gate.
function selectedRace(t, overrides = {}, roots = ['TestRuntimeState']) {
  const fixture = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', ...overrides })
  const file = 'backend/runtime/state_test.go'
  mkdirSync(join(fixture.directory, 'backend/runtime'), { recursive: true })
  writeFileSync(join(fixture.directory, file), 'package runtime\n')
  const request = { files: [file], goTestRoots: { './runtime': roots }, goRace: true }
  const selection = join(fixture.directory, 'selected-race.json')
  writeFileSync(selection, JSON.stringify(request))
  fixture.environment.CI_AFFECTED_SELECTION_FILE = selection
  return { ...fixture, request }
}

const json = (fixture, path) => JSON.parse(readFileSync(join(fixture.state, path), 'utf8'))
const lines = (fixture, path) => readFileSync(join(fixture.state, path), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const testCalls = fixture => fixture.calls().filter(call => call.tool === 'go' && call.args[0] === 'test')
const terminalEvents = (fixture, kind) => lines(fixture, `go/${kind}.jsonl`)
  .filter(event => event.Test && ['pass', 'fail', 'skip'].includes(event.Action))

function assertClean(fixture) {
  assert.equal(fixture.isolatedHomeExists(), false)
  assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'untouched')
}

for (const kind of ['unit', 'integration']) {
  test(`a bounded ${kind} race selection runs its exact named root once and retains its results`, t => {
    const fixture = selectedRace(t)
    const suite = kind === 'unit' ? 'unit-api' : 'integration'
    if (kind === 'integration') {
      const prepared = fixture.run(suite, 'prepare')
      assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr)
    }
    const result = fixture.run(suite)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const calls = testCalls(fixture)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['test', '-json', '-count=1',
      ...(kind === 'integration' ? ['-tags', 'integration'] : []), '-race', '-run', '^(TestRuntimeState)$', './runtime'])
    assert.equal(calls[0].goflags, '-mod=readonly', 'Race selection must not be hidden in inherited GOFLAGS.')
    assert.deepEqual(terminalEvents(fixture, kind).map(event => [event.Test, event.Action]), [['TestRuntimeState', 'pass']])
    assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
    assert.deepEqual(lines(fixture, `go/${kind}.commands.jsonl`),
      [{ package: './runtime', filter: '^(TestRuntimeState)$', race: 1, openssl: 0, exit: 0 }])
    assert.equal(json(fixture, 'affected-selection.json').goRace, true)
    const status = json(fixture, `go/${kind}.action-status.json`)
    assert.equal(status.nativeExit, 0)
    assert.equal(status.converterExit, 0)
    assert.equal(status.actionExit, 0)
    assertClean(fixture)
  })
}

test('a selected race assertion failure remains a failed named result and action', t => {
  const fixture = selectedRace(t, { GO_TEST_MODE: 'failed' })
  const result = fixture.run('unit-api')
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(terminalEvents(fixture, 'unit').map(event => [event.Test, event.Action]), [['TestRuntimeState', 'fail']])
  assert.deepEqual(fixture.results().summary, { passed: 0, failed: 1, skipped: 0 })
  assert.equal(testCalls(fixture).length, 1)
  const status = json(fixture, 'go/unit.action-status.json')
  assert.equal(status.nativeExit, 7)
  assert.equal(status.converterExit, 1)
  assert.equal(status.actionExit, 7)
  assertClean(fixture)
})

test('a race command with zero native cases fails without inventing a failed test', t => {
  const fixture = selectedRace(t, { GO_TEST_MODE: 'zero' })
  const result = fixture.run('unit-api')
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(terminalEvents(fixture, 'unit'), [])
  const reported = json(fixture, 'go-unit.vitest.json').testResults.flatMap(file => file.assertionResults)
  assert.deepEqual(reported, [])
  assert.equal(testCalls(fixture).length, 1)
  const status = json(fixture, 'go/unit.action-status.json')
  assert.equal(status.nativeExit, 0)
  assert.equal(status.converterExit, 1)
  assert.equal(status.actionExit, 1)
  assertClean(fixture)
})

test('a missing selected race root fails even when its selected neighbor passed', t => {
  const fixture = selectedRace(t, {}, ['TestRuntimeState', 'TestNeverReported'])
  const result = fixture.run('unit-api')
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(terminalEvents(fixture, 'unit').map(event => [event.Test, event.Action]), [['TestRuntimeState', 'pass']])
  const reported = json(fixture, 'go-unit.vitest.json').testResults.flatMap(file => file.assertionResults)
  assert.deepEqual(reported.map(value => [value.fullName, value.status]), [['TestRuntimeState', 'passed']])
  assert.equal(testCalls(fixture).length, 1)
  const status = json(fixture, 'go/unit.action-status.json')
  assert.equal(status.nativeExit, 0)
  assert.equal(status.converterExit, 1)
  assert.equal(status.actionExit, 1)
  assertClean(fixture)
})

test('race admission requires explicit boolean named test scope and rejects arbitrary Go flags', t => {
  const fixture = selectedRace(t)
  for (const goRace of ['true', 1, null, ['-race']]) {
    assert.throws(() => readAffectedRequest({ ...fixture.request, goRace }, fixture.directory), /Go race execution/)
  }
  assert.throws(() => readAffectedRequest({ files: fixture.request.files, goRace: true }, fixture.directory), /named Go test roots/)
  assert.throws(() => readAffectedRequest({ ...fixture.request, goFlags: ['-race'] }, fixture.directory), /bounded affected request/)
  const request = readAffectedRequest(fixture.request, fixture.directory)
  for (const suite of ['build-api', 'typecheck-api', 'lint-api']) {
    assert.throws(() => validateAffectedSuite(suite, request, fixture.directory), /test scope/)
  }
  assert.deepEqual(validateAffectedSuite('unit-api', request, fixture.directory).goTestRoots,
    { './runtime': ['TestRuntimeState'] })
})

test('a native test selection cannot recursively execute a registered ordinary action', t => {
  const fixture = nativeActionFixture(t)
  const selector = 'scripts/native-test-adapter.test.mjs'
  const selectedGo = 'backend/runtime/state_test.go'
  const selection = 'scripts/nested-native-selection.json'
  fixture.put(selector, "import { test } from 'node:test'\ntest('native adapter fixture', () => {})\n")
  fixture.put(selectedGo, 'package runtime\n')
  fixture.put(selection, { files: [selectedGo, fixture.actions[0].selector],
    goTestRoots: { './runtime': ['TestRuntimeState'] } })
  fixture.put('scripts/ci-native-selectors.json', { [selector]: { suite: 'unit', selection } })
  const result = fixture.normalize('unit-other', [selector])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /cannot recursively select another adapter/)
  assert.equal(result.request, null, 'A rejected nested action must not publish a prepared selection.')
})
