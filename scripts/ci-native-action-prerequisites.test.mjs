import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeActionFixture } from './test-support/ci-native-action-fixture.mjs'

function preparation(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.ok(['true', 'false'].includes(result.stdout.trim()), 'The cloud CLI must report its prerequisite decision.')
  return result.stdout.trim() === 'true'
}

for (const kind of ['build', 'typecheck', 'lint']) {
  test(`cloud prepares native tools for an ordinary selected Go ${kind} action`, t => {
    const fixture = nativeActionFixture(t)
    const action = fixture.actions.find(value => value.kind === kind)
    // The unchanged pre-fix CLI accepts this ordinary JS selection and returns
    // false. Its identical-test witness fails this assertion, after setup succeeds.
    assert.equal(preparation(fixture.cloud('unit-other', [action.selector])), true,
      'A selected Go action must receive native tools before its JS adapter starts.')
  })
}

test('unselected native actions and source checks do not request native tools', t => {
  const fixture = nativeActionFixture(t)
  assert.equal(preparation(fixture.cloud('unit-other', [fixture.ordinary])), false)
  for (const suite of ['build-other', 'typecheck-other', 'lint-other']) {
    for (const { selector } of fixture.actions) {
      assert.equal(preparation(fixture.cloud(suite, [selector])), false)
    }
  }
})

test('selected native actions acquire no native test report requirements', t => {
  const fixture = nativeActionFixture(t)
  for (const { selector } of fixture.actions) {
    const result = fixture.normalize('unit-other', [selector])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(result.request.nativeReports, {})
    assert.deepEqual(result.request.goTestRoots, {})
    assert.deepEqual(result.request.conformanceScenarios, [])
  }
})
