import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ciTestResults, writeCiTestResults } from './ci-test-results.mjs'

// These reports model the public converter output. They are not Go or conformance execution receipts.
const nativeReport = (name, fullName, status, duration = 5) => ({ testResults: [{
  name, status, duration, assertionResults: [{ fullName, status, duration,
    ...(status === 'failed' ? { failureMessages: ['The recorded value did not match.'] } : {}) }],
}] })

test('keeps every distinct named Go case when separate reports share the same package', () => {
  const result = ciTestResults([
    nativeReport('backend/ciprobe', 'TestStoredValue', 'passed', 7),
    nativeReport('backend/ciprobe', 'TestRejectedValue', 'failed', 11),
  ])
  assert.deepEqual(result.summary, { passed: 1, failed: 1, skipped: 0 })
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].status, 'failed')
  assert.equal(result.files[0].durationMs, 18)
  assert.deepEqual(result.files[0].tests, [
    { name: 'TestStoredValue', status: 'passed', durationMs: 7 },
    { name: 'TestRejectedValue', status: 'failed', durationMs: 11, message: 'The recorded value did not match.' },
  ])
  assert.equal(result.truncated, false)
})

test('rejects repeated native case identities before publishing an inflated result', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-result-merge-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const inputs = ['first.json', 'second.json'].map(name => join(directory, name))
  for (const input of inputs) writeFileSync(input, JSON.stringify(nativeReport('backend/ciprobe', 'TestStoredValue', 'passed')))
  const output = join(directory, 'published.json')
  assert.throws(() => writeCiTestResults(output, inputs), /Duplicate native test result/)
  assert.equal(existsSync(output), false)
})

test('retains conformance target and lane identities while merging distinct cases of one lane', () => {
  const result = ciTestResults([
    nativeReport('conformance/go/SKEL', '[SKEL] fixture.live: Liveness', 'passed', 13),
    nativeReport('conformance/go/SKEL', '[SKEL] fixture.ready: Readiness', 'passed', 17),
    nativeReport('conformance/ts/SKEL', '[SKEL] fixture.live: Liveness', 'passed', 19),
    nativeReport('conformance/go/E', '[E] fixture.run: Run result', 'failed', 23),
  ])
  assert.deepEqual(result.summary, { passed: 3, failed: 1, skipped: 0 })
  assert.equal(result.files.length, 3)
  const go = result.files.find(file => file.tests.some(item => item.name.includes('fixture.ready')))
  assert.equal(go.durationMs, 30)
  assert.deepEqual(go.tests.map(item => [item.name, item.durationMs]), [
    ['[SKEL] fixture.live: Liveness', 13], ['[SKEL] fixture.ready: Readiness', 17],
  ])
  assert.equal(result.files.filter(file => file.tests.some(item => item.name.includes('fixture.live'))).length, 2)
})

test('combines retained JavaScript cases without replacing native cases or treating a mixed file as skipped', () => {
  const result = ciTestResults([
    nativeReport('backend/ciprobe', 'TestStoredValue', 'passed'),
    nativeReport('scripts/selected.test.mjs', 'runs its public action', 'passed', 2),
    nativeReport('scripts/selected.test.mjs', 'optional assertion', 'skipped', 3),
  ])
  assert.deepEqual(result.summary, { passed: 2, failed: 0, skipped: 1 })
  const javascript = result.files.find(file => file.tests.some(item => item.name === 'runs its public action'))
  assert.equal(javascript.status, 'passed')
  assert.equal(javascript.tests.length, 2)
  assert.equal(javascript.durationMs, 5)
  assert.ok(result.files.some(file => file.tests.some(item => item.name === 'TestStoredValue')))
})

test('a duplicate conformance case is rejected within its original target and lane', () => {
  const report = nativeReport('conformance/go/SKEL', '[SKEL] fixture.live: Liveness', 'passed')
  assert.throws(() => ciTestResults([report, structuredClone(report)]), /Duplicate native test result/)
})
