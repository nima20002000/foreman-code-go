import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cloudNativePrerequisites } from './ci-cloud-native-prerequisites.mjs'
import { cloudSelectionFixture } from './test-support/ci-cloud-path-fixture.mjs'

test('cloud prerequisites follow selected native adapters, packages and conformance scenarios', t => {
  const f = cloudSelectionFixture(t)
  const environments = [
    f.selectedEnvironment('unit-other', f.unitSelector),
    f.integrationEnvironment(),
    f.requestEnvironment('typecheck-api', { files: [f.goSource] }),
    f.requestEnvironment('unit-api', { files: [f.goFile], goTestRoots: { './runtime': ['TestRuntimeState'] } }),
    f.requestEnvironment('integration', { files: [f.conformanceFile], conformanceScenarios: ['fixture.health'], conformanceTsRequired: false }),
  ]
  for (const environment of environments) assert.equal(cloudNativePrerequisites(environment, f.directory), true)
})

test('ordinary JavaScript and retained-only root scopes do not request native preparation', t => {
  const f = cloudSelectionFixture(t)
  for (const suite of ['unit-other', 'unit', 'typecheck', 'lint', 'build']) {
    assert.equal(cloudNativePrerequisites(f.selectedEnvironment(suite, f.ordinary), f.directory), false)
  }
  // Checking adapter source as JavaScript does not execute its native test binding.
  for (const suite of ['typecheck', 'lint']) {
    assert.equal(cloudNativePrerequisites(f.selectedEnvironment(suite, f.unitSelector), f.directory), false)
  }
  assert.equal(cloudNativePrerequisites({ SUITE: 'install' }, f.directory), false)
})

test('unresolved native scope and uncommitted report claims fail before preparation is requested', t => {
  const f = cloudSelectionFixture(t)
  assert.throws(() => cloudNativePrerequisites({ SUITE: 'unit-other', SCOPE: 'affected' }, f.directory), /Affected CI scope is unresolved/)
  assert.throws(() => cloudNativePrerequisites({ SUITE: 'integration', SCOPE: 'full' }, f.directory), /Full CI scope is reserved/)
  assert.throws(() => cloudNativePrerequisites({ SUITE: 'unknown', SCOPE: 'affected' }, f.directory), /Unsupported affected suite/)
  assert.throws(() => cloudNativePrerequisites(f.requestEnvironment('unit-other', []), f.directory), /selected zero files/)
  f.put('scripts/ci-native-selectors.json', {})
  const claimed = f.requestEnvironment('unit-other', { files: [f.unitSelector],
    nativeReports: { [f.unitSelector]: { requiredKinds: ['go-unit'], optionalKinds: [] } } })
  assert.throws(() => cloudNativePrerequisites(claimed, f.directory), /require a committed selected adapter binding/)
})
