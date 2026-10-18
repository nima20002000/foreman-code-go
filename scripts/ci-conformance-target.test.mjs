import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { affectedContracts } from './ci-affected-contracts.mjs'
import { nativeSelectorBinding, readAffectedRequest, validateAffectedSuite } from './ci-affected-scope.mjs'

// Public selection/compilation-plan fixtures, never native scenario execution evidence.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'conformance-target-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), value)
  }
  const source = 'conformance/src/selected.ts'
  const selector = 'apps/api/test/native.integration.test.ts'
  put(source, 'export {}\n')
  put(selector, 'export {}\n')
  const selection = { files: [source], conformanceScenarios: ['fixture.operator', 'fixture.workflow'],
    conformanceTsRequired: false, conformanceTarget: 'ts' }
  put('selected.json', JSON.stringify(selection))
  put('scripts/ci-native-selectors.json', JSON.stringify({ [selector]: { suite: 'integration', selection: 'selected.json' } }))
  return { root, put, selector, selection }
}

test('the public affected contract accepts an explicit TS-only qualification without requesting Go comparison', t => {
  const f = fixture(t)
  let request
  assert.doesNotThrow(() => { request = readAffectedRequest(f.selection, f.root) })
  assert.equal(request.conformanceTarget, 'ts')
  assert.equal(request.conformanceTsRequired, false)
  assert.deepEqual(request.conformanceScenarios, ['fixture.operator', 'fixture.workflow'])
  assert.deepEqual(validateAffectedSuite('integration', request, f.root), request)
})

test('a committed TS-only selector requires only actual TS native publications', t => {
  const f = fixture(t)
  let binding
  assert.doesNotThrow(() => { binding = nativeSelectorBinding(f.selector, f.root) })
  assert.deepEqual(binding.requiredKinds, ['conformance-ts'])
  const request = validateAffectedSuite('integration', readAffectedRequest([f.selector], f.root), f.root)
  assert.deepEqual(request.nativeReports[f.selector], { requiredKinds: ['conformance-ts'], optionalKinds: [] })
})

test('ordinary Go qualification and its explicit TS comparison retain their native requirements', t => {
  const f = fixture(t)
  const normal = { ...f.selection }
  delete normal.conformanceTarget
  for (const conformanceTsRequired of [false, true]) {
    f.put('selected.json', JSON.stringify({ ...normal, conformanceTsRequired }))
    assert.deepEqual(nativeSelectorBinding(f.selector, f.root).requiredKinds,
      conformanceTsRequired ? ['conformance-go', 'conformance-ts'] : ['conformance-go'])
  }
})

test('explicit TS qualification rejects mixed Go work, missing scenarios and contradictory target decisions', t => {
  const f = fixture(t)
  f.put('backend/runtime/runtime_test.go', 'package runtime\n')
  for (const selection of [
    { ...f.selection, conformanceTarget: 'unknown' },
    { ...f.selection, conformanceTarget: null },
    { ...f.selection, conformanceScenarios: [] },
    { ...f.selection, conformanceTsRequired: true },
    { ...f.selection, files: [...f.selection.files, 'backend/runtime/runtime_test.go'],
      goTestRoots: { './runtime': ['TestRuntime'] } },
  ]) assert.throws(() => readAffectedRequest(selection, f.root))
})

test('TS-only preparation includes the public server and credential runtime export dependencies', t => {
  const f = fixture(t)
  f.put('conformance/src/main.ts', 'export {}\n')
  f.put('apps/api/src/server.ts', "import '@foreman-code/contracts/server-runtime'\n")
  f.put('apps/api/src/cli/operatorCredentials.ts', "import '@foreman-code/contracts/credential-runtime'\n")
  f.put('packages/contracts/package.json', JSON.stringify({ exports: {
    './server-runtime': { import: './dist/server-runtime.js' },
    './credential-runtime': { import: './dist/credential-runtime.js' },
  } }))
  for (const name of ['server-runtime', 'credential-runtime']) f.put(`packages/contracts/src/${name}.ts`, 'export const ready = true\n')
  // The existing public planner accepts a normalized request. This reaches its genuine old behavior directly.
  const plan = affectedContracts(f.selection, f.root)
  assert.deepEqual(plan.entries, ['packages/contracts/src/credential-runtime.ts', 'packages/contracts/src/server-runtime.ts'])
  assert.deepEqual(plan.sources, plan.entries)
  assert.deepEqual(affectedContracts({ ...f.selection, conformanceTarget: 'go' }, f.root).entries, [])
})

test('a native adapter cannot relabel an explicit TS request as Go or add optional Go receipts', t => {
  const f = fixture(t)
  for (const binding of [{ requiredKinds: ['conformance-go'], optionalKinds: [] },
    { requiredKinds: ['conformance-ts'], optionalKinds: ['conformance-go'] }]) {
    const request = readAffectedRequest({ files: [f.selector], nativeReports: { [f.selector]: binding } }, f.root)
    assert.throws(() => validateAffectedSuite('integration', request, f.root))
  }
})
