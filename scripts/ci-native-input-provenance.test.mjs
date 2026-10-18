import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

// Synthetic public native execution verifies receipt semantics, never actual Go or conformance qualification.
const selector = 'scripts/native-provenance.test.mjs'
const plan = 'scripts/native-provenance-selection.json'
const adapter = `import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeSelectorBinding, repositoryRoot } from './ci-affected-scope.mjs'
test('executes the selected fixture action', () => {
  const binding = nativeSelectorBinding('${selector}')
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/ci-affected-run.mjs'), binding.suite,
    '--files-from', join(repositoryRoot, binding.selection)], { cwd: repositoryRoot, env: environment, stdio: 'inherit' })
  assert.ifError(result.error)
  assert.equal(result.status, 0)
})
`

test('native input receipts preserve a transport snapshot separately from the observed tested checkout', t => {
  const checkout = '1'.repeat(40)
  const snapshot = '2'.repeat(40)
  const fixture = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '',
    FIXTURE_COMMIT_SHA: checkout, CI_SELECTION_COMMIT: snapshot })
  const root = fixture.directory
  mkdirSync(join(root, 'backend/runtime'), { recursive: true })
  writeFileSync(join(root, 'backend/runtime/runtime_test.go'), 'package runtime\n')
  writeFileSync(join(root, selector), adapter)
  writeFileSync(join(root, plan), JSON.stringify({ files: ['backend/runtime/runtime_test.go'],
    goTestRoots: { './runtime': ['TestRuntimeState'] } }))
  writeFileSync(join(root, 'scripts/ci-native-selectors.json'), JSON.stringify({
    [selector]: { suite: 'unit-api', selection: plan },
  }))
  const selection = join(root, 'selected.json')
  writeFileSync(selection, JSON.stringify([selector]))
  writeFileSync(join(root, 'ci-dispatch-inputs.json'), JSON.stringify({ commit: snapshot, files: 's:0', partition: '', slice: '' }))
  fixture.environment.CI_AFFECTED_SELECTION_FILE = selection
  // Cloud dispatch reaches the suite directly; the ordinary affected CLI intentionally clears routing fields.
  const result = fixture.run('unit')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(fixture.results().summary, { passed: 1, failed: 0, skipped: 0 })
  const collection = join(fixture.state, 'go/native-reports')
  const receipts = readdirSync(collection).flatMap(session => {
    const directory = join(collection, session)
    return readdirSync(directory).filter(file => file === 'native-input.json')
      .map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')))
  })
  // Genuine old code executes the selected fixture first, then fails this public receipt assertion.
  assert.equal(receipts.length, 1, 'The selected native execution must publish its input provenance.')
  const receipt = receipts[0]
  assert.equal(receipt.transportSnapshotCommit, snapshot)
  assert.equal(receipt.checkoutCommit, checkout)
  assert.notEqual(receipt.transportSnapshotCommit, receipt.checkoutCommit)
  assert.equal(receipt.forkSourceBinding, 'Foreman CI run provenance.sourceCommit')
  assert.equal(receipt.selector, selector)
  assert.deepEqual(receipt.selection.request.files, [selector])
  assert.deepEqual(receipt.selection.request.nativeReports[selector], { requiredKinds: ['go-unit'], optionalKinds: [] })
})
