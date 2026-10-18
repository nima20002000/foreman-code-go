import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { environmentRequest, explicitRelease, nativeSelectorBinding, readAffectedRequest, validateAffectedSuite } from './ci-affected-scope.mjs'
import { repositoryFileList } from './ci-files.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'affected-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
  put('backend/runtime/state_test.go', 'package runtime\n')
  put('scripts/native.test.mjs', 'export {}\n')
  put('apps/api/test/native.integration.test.ts', 'export {}\n')
  put('conformance/src/selected.ts', 'export {}\n')
  const unit = { files: ['backend/runtime/state_test.go'], goTestRoots: { './runtime': ['TestRuntimeState'] } }
  put('scripts/unit-selection.json', JSON.stringify(unit))
  put('scripts/integration-selection.json', JSON.stringify(unit))
  put('scripts/ci-native-selectors.json', JSON.stringify({
    'scripts/native.test.mjs': { suite: 'unit-api', selection: 'scripts/unit-selection.json' },
    'apps/api/test/native.integration.test.ts': { suite: 'integration', selection: 'scripts/integration-selection.json' },
  }))
  return { root, put, unit }
}

test('manifest binding stays in the explicitly supplied repository root', t => {
  const f = fixture(t)
  const binding = nativeSelectorBinding('scripts/native.test.mjs', f.root)
  assert.equal(binding.suite, 'unit-api')
  assert.deepEqual(binding.requiredKinds, ['go-unit'])
  const request = readAffectedRequest(['apps/api/test/native.integration.test.ts'], f.root)
  assert.deepEqual(validateAffectedSuite('integration', request, f.root).nativeReports,
    { 'apps/api/test/native.integration.test.ts': { requiredKinds: ['go-integration'], optionalKinds: [] } })
})

test('lint and typecheck of a bound adapter do not acquire native test scope', t => {
  const f = fixture(t)
  const request = readAffectedRequest(['scripts/native.test.mjs'], f.root)
  for (const suite of ['lint-other', 'typecheck-other']) {
    assert.deepEqual(validateAffectedSuite(suite, request, f.root).nativeReports, {})
  }
  const tested = validateAffectedSuite('unit-other', request, f.root)
  assert.deepEqual(tested.nativeReports['scripts/native.test.mjs'].requiredKinds, ['go-unit'])
  assert.throws(() => validateAffectedSuite('lint-other', tested, f.root), /test scope/)
})

test('Go test roots require exact bound packages and literal supported names', t => {
  const f = fixture(t)
  assert.deepEqual(validateAffectedSuite('unit-api', readAffectedRequest(f.unit, f.root), f.root).goTestRoots, f.unit.goTestRoots)
  for (const goTestRoots of [{ './other': ['TestRuntimeState'] }, { './runtime': [] },
    { './runtime': ['TestRuntimeState', 'TestRuntimeState'] }, { './runtime': ['Test.*'] }, { './runtime': ['FuzzRuntime'] }]) {
    assert.throws(() => readAffectedRequest({ ...f.unit, goTestRoots }, f.root), /Go test|named/)
  }
  assert.throws(() => validateAffectedSuite('unit-api', readAffectedRequest(f.unit.files, f.root), f.root), /named roots/)
  assert.throws(() => validateAffectedSuite('unit-other', readAffectedRequest(f.unit, f.root), f.root), /does not belong/)
  const zeroProbe = readAffectedRequest({ ...f.unit, goTestRoots: { './runtime': ['TestKnownAbsent'] } }, f.root)
  assert.deepEqual(validateAffectedSuite('unit-api', zeroProbe, f.root).goTestRoots, zeroProbe.goTestRoots)
})

test('unknown and empty invoked scope cannot silently become release or frozen API checks', t => {
  const f = fixture(t)
  assert.throws(() => validateAffectedSuite('unit', readAffectedRequest([], f.root), f.root), /zero files/)
  f.put('apps/api/test/unbound.integration.test.ts', 'export {}')
  assert.throws(() => validateAffectedSuite('integration',
    readAffectedRequest(['apps/api/test/unbound.integration.test.ts'], f.root), f.root), /Unsupported affected file/)
  assert.throws(() => environmentRequest({}, f.root), /scope is unresolved/)
  assert.throws(() => explicitRelease({ SCOPE: 'full' }), /explicit release mode/)
  assert.equal(explicitRelease({ SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '1' }), false)
  assert.equal(explicitRelease({ SCOPE: 'full', FOREMAN_CODE_CI_RELEASE: '1' }), true)
})

test('conformance scope requires exact scenario IDs and an explicit comparison decision', t => {
  const f = fixture(t)
  const files = ['conformance/src/selected.ts']
  assert.throws(() => readAffectedRequest({ files, conformanceScenarios: ['health'] }, f.root), /explicit TS comparison/)
  assert.throws(() => readAffectedRequest({ files, conformanceScenarios: ['health', 'health'], conformanceTsRequired: false }, f.root), /scenario IDs/)
  const request = readAffectedRequest({ files, conformanceScenarios: ['health'], conformanceTsRequired: false }, f.root)
  assert.deepEqual(validateAffectedSuite('integration', request, f.root).conformanceScenarios, ['health'])
})

test('early setup resolves the existing hash-bound provider file index transport', t => {
  const f = fixture(t)
  execFileSync('git', ['init', '-q', '-b', 'fixture'], { cwd: f.root })
  execFileSync('git', ['add', '.'], { cwd: f.root })
  const index = repositoryFileList(f.root).indexOf('scripts/native.test.mjs')
  const inputs = { commit: 'a'.repeat(40), slice: '', files: `s:${index}`, partition: '' }
  const bytes = Buffer.from(JSON.stringify(inputs))
  f.put('ci-dispatch-inputs.json', bytes)
  const environment = { CI_PARTITION: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
  assert.deepEqual(environmentRequest(environment, f.root).files, ['scripts/native.test.mjs'])
  f.put('ci-dispatch-inputs.json', JSON.stringify({ ...inputs, files: '' }))
  assert.throws(() => environmentRequest(environment, f.root), /hash mismatch/)
  const empty = Buffer.from(JSON.stringify({ ...inputs, files: '' }))
  f.put('ci-dispatch-inputs.json', empty)
  assert.throws(() => environmentRequest({ CI_PARTITION: `sha256:${createHash('sha256').update(empty).digest('hex')}` }, f.root), /no explicit affected/)
})
