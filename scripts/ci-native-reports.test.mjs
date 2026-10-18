import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { adoptNativeReports, beginNativeReport, expectNativeReports, finishNativeReport } from './ci-native-reports.mjs'
import { ciTestResults } from './ci-test-results.mjs'

// Synthetic converter reports verify adoption behavior. None of these cases execute Go or conformance.
const selector = 'scripts/selected-native.test.mjs'
const assertion = (fullName, status = 'passed', duration = 7) => ({ fullName, status, duration,
  ...(status === 'failed' ? { failureMessages: ['The real assertion failed.'] } : {}) })
const wrapper = (status = 'passed') => ({ testResults: [{ name: selector, status, duration: 2,
  assertionResults: [assertion('runs the public native action', status, 2)] }] })
const goReport = (tests = [assertion('TestStoredValue')], status = 'passed') => ({ testResults: [{
  name: 'backend/ciprobe', status, duration: 11, assertionResults: tests,
}] })
function session(t, requiredKinds = ['go-unit'], optionalKinds = []) {
  const repository = mkdtempSync(join(tmpdir(), 'native-case-reports-'))
  t.after(() => rmSync(repository, { recursive: true, force: true }))
  const directory = join(repository, 'publication')
  expectNativeReports({ directory, selector, requiredKinds, optionalKinds })
  let ordinal = 0
  return { repository, directory,
    begin(kind = 'go-unit') { beginNativeReport({ directory, selector, kind }) },
    finish(report, { kind = 'go-unit', exitCode = 0 } = {}) {
      const reportPath = join(repository, `native-${ordinal++}.json`)
      writeFileSync(reportPath, JSON.stringify(report))
      finishNativeReport({ directory, selector, kind, reportPath, exitCode })
    },
    adopt(report = wrapper(), wrapperExit = 0) {
      return adoptNativeReports(report, { directory, repository, selector, wrapperExit })
    },
  }
}
const names = report => report.testResults.flatMap(row => row.assertionResults.map(test => test.fullName))

test('adopts genuine named cases and measured durations while keeping unrelated JavaScript assertions', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport([assertion('TestStoredValue', 'passed', 7), assertion('TestStoredValue/roundtrip', 'passed', 3)]))
  const original = wrapper()
  original.testResults.push({ name: 'scripts/unrelated.test.mjs', status: 'passed', duration: 5,
    assertionResults: [assertion('retains an unrelated behavior', 'passed', 5)] })
  const before = structuredClone(original)
  const adopted = fixture.adopt(original)
  assert.equal(adopted.failed, false)
  assert.deepEqual(adopted.nativeCounts, { reported: 2, executed: 2, passed: 2, failed: 0, skipped: 0 })
  assert.deepEqual(names(adopted.report), ['retains an unrelated behavior', 'TestStoredValue', 'TestStoredValue/roundtrip'])
  assert.deepEqual(adopted.report.testResults.flatMap(row => row.assertionResults.map(test => test.duration)), [5, 7, 3])
  assert.deepEqual(original, before)
})

test('preserves a real failed wrapper assertion alongside passing native cases', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport())
  const original = wrapper('failed')
  original.testResults[0].assertionResults.unshift(assertion('earlier wrapper setup completed'))
  const adopted = fixture.adopt(original, 1)
  assert.equal(adopted.failed, true)
  assert.deepEqual(names(adopted.report), ['runs the public native action', 'TestStoredValue'])
  assert.deepEqual(ciTestResults([adopted.report]).summary, { passed: 1, failed: 1, skipped: 0 })
  assert.deepEqual(adopted.nativeCounts, { reported: 1, executed: 1, passed: 1, failed: 0, skipped: 0 })
})

test('a wrapper cannot swallow a native assertion failure and turn the action green', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport([assertion('TestStoredValue', 'failed')], 'failed'), { exitCode: 1 })
  const adopted = fixture.adopt()
  assert.equal(adopted.failed, true)
  assert.deepEqual(adopted.nativeCounts, { reported: 1, executed: 1, passed: 0, failed: 1, skipped: 0 })
  assert.deepEqual(ciTestResults([adopted.report]).summary, { passed: 0, failed: 1, skipped: 0 })
})

test('a zero-case native report stays zero and fails despite a passed wrapper assertion', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport([]), { exitCode: 1 })
  const adopted = fixture.adopt()
  assert.equal(adopted.failed, true)
  assert.deepEqual(adopted.nativeCounts, { reported: 0, executed: 0, passed: 0, failed: 0, skipped: 0 })
  assert.deepEqual(names(adopted.report), [])
  assert.deepEqual(ciTestResults([adopted.report]).summary, { passed: 0, failed: 0, skipped: 0 })
})

test('required missing and unfinished reports never become executed native cases', t => {
  for (const started of [false, true]) {
    const fixture = session(t)
    if (started) fixture.begin()
    const adopted = fixture.adopt()
    assert.equal(adopted.failed, true)
    assert.equal(adopted.nativeCounts.reported, 0)
    assert.equal(adopted.nativeCounts.executed, 0)
    assert.deepEqual(names(adopted.report), [])
  }
})

test('malformed native output leaves the registered action unfinished and red', t => {
  const fixture = session(t)
  fixture.begin()
  assert.throws(() => fixture.finish({ testResults: [{ name: 'backend/ciprobe', status: 'passed', assertionResults: [{}] }] }), /invalid named case/)
  assert.equal(fixture.adopt().failed, true)
  assert.equal(fixture.adopt().nativeCounts.executed, 0)
})

test('a native publication cannot be bound to a different selector or report kind', t => {
  const fixture = session(t)
  assert.throws(() => beginNativeReport({ directory: fixture.directory, selector: 'scripts/another.test.mjs', kind: 'go-unit' }), /selected adapter/)
  assert.throws(() => fixture.begin('conformance-go'), /not bound/)
  fixture.begin()
  assert.throws(() => fixture.finish({ testResults: [{ name: 'conformance/go/SKEL', status: 'passed', duration: 1,
    assertionResults: [assertion('[SKEL] fixture.health: Health response')] }] }), /namespace/)
  assert.equal(fixture.adopt().failed, true)
})

test('duplicate native action registration and completion fail explicitly', t => {
  const fixture = session(t)
  fixture.begin()
  assert.throws(() => fixture.begin())
  fixture.finish(goReport())
  assert.throws(() => fixture.finish(goReport()), /registered exactly once/)
})

test('duplicate actual native identities across publications cannot inflate accepted totals', t => {
  const fixture = session(t, ['go-unit', 'go-integration'])
  fixture.begin('go-unit')
  fixture.finish(goReport(), { kind: 'go-unit' })
  fixture.begin('go-integration')
  fixture.finish(goReport(), { kind: 'go-integration' })
  const adopted = fixture.adopt()
  assert.equal(adopted.failed, true)
  assert.match(adopted.diagnostics.join('\n'), /Duplicate native case identity/)
  assert.equal(adopted.nativeCounts.reported, 1)
  assert.equal(names(adopted.report).filter(name => name === 'TestStoredValue').length, 1)
})

test('optional conformance target results preserve target-separated cases and lane tags', t => {
  const fixture = session(t, ['conformance-go'], ['conformance-ts'])
  for (const target of ['go', 'ts']) {
    const kind = `conformance-${target}`
    fixture.begin(kind)
    fixture.finish({ testResults: [{ name: `conformance/${target}/SKEL`, status: 'passed', duration: 9,
      assertionResults: [assertion('[SKEL] fixture.health: Health response', 'passed', 9)] }] }, { kind })
  }
  const adopted = fixture.adopt()
  assert.equal(adopted.failed, false)
  assert.equal(adopted.nativeCounts.executed, 2)
  const result = ciTestResults([adopted.report])
  assert.equal(result.files.length, 2)
  assert.deepEqual(result.summary, { passed: 2, failed: 0, skipped: 0 })
  assert.ok(result.files.every(file => file.tests[0].name === '[SKEL] fixture.health: Health response'))
})

test('all-skipped native cases remain visible while zero executed cases is red', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport([assertion('TestStoredValue', 'skipped')], 'skipped'), { exitCode: 1 })
  const adopted = fixture.adopt()
  assert.equal(adopted.failed, true)
  assert.deepEqual(adopted.nativeCounts, { reported: 1, executed: 0, passed: 0, failed: 0, skipped: 1 })
  assert.deepEqual(ciTestResults([adopted.report]).summary, { passed: 0, failed: 0, skipped: 1 })
})

test('a failed benchmark remains a failure without being counted as a selected Go test', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport([assertion('BenchmarkStoredValue', 'failed')], 'failed'), { exitCode: 1 })
  const adopted = fixture.adopt()
  assert.equal(adopted.failed, true)
  assert.equal(adopted.nativeCounts.reported, 0)
  assert.equal(adopted.nativeCounts.executed, 0)
  assert.deepEqual(names(adopted.report), ['BenchmarkStoredValue'])
})

test('an ordinary JavaScript selection remains ordinary when it expects no native report', t => {
  const fixture = session(t, [])
  const original = wrapper()
  const adopted = fixture.adopt(original)
  assert.equal(adopted.failed, false)
  assert.deepEqual(adopted.report, original)
  assert.equal(adopted.nativeCounts.reported, 0)
})

test('a nonzero wrapper exit and a missing attributable wrapper result cannot pass native adoption', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport())
  assert.equal(fixture.adopt(wrapper(), 7).failed, true)
  assert.equal(fixture.adopt({ testResults: [] }).failed, true)
})

for (const [label, original] of [
  ['absent', undefined],
  ['malformed row', { testResults: [null, { name: selector, assertionResults: null }] }],
  ['malformed assertion', { testResults: [{ name: selector, status: 'passed', assertionResults: [{}] }] }],
]) {
  test(`${label} wrapper output preserves real native cases and fails without a fabricated assertion`, t => {
    const fixture = session(t)
    fixture.begin()
    fixture.finish(goReport([assertion('TestStoredValue', 'passed', 19)]))
    const adopted = adoptNativeReports(original, { directory: fixture.directory, repository: fixture.repository,
      selector, wrapperExit: 0 })
    assert.equal(adopted.failed, true)
    assert.match(adopted.diagnostics.join('\n'), /complete wrapper report/)
    assert.deepEqual(adopted.nativeCounts, { reported: 1, executed: 1, passed: 1, failed: 0, skipped: 0 })
    const results = ciTestResults([adopted.report])
    assert.deepEqual(results.summary, { passed: 1, failed: 0, skipped: 0 })
    assert.deepEqual(results.files.find(file => file.file === 'backend/ciprobe').tests,
      [{ name: 'TestStoredValue', status: 'passed', durationMs: 19 }])
    assert.deepEqual(results.files.find(file => file.file === selector).tests, [])
    assert.equal(results.files.find(file => file.file === selector).status, 'failed')
  })
}

test('one invalid wrapper assertion does not discard unrelated real JavaScript failures', t => {
  const fixture = session(t)
  fixture.begin()
  fixture.finish(goReport())
  const original = wrapper()
  original.testResults.push({ name: 'scripts/unrelated.test.mjs', status: 'failed', duration: 5,
    assertionResults: [assertion('retains the real failed behavior', 'failed', 5), null] })
  const adopted = fixture.adopt(original)
  assert.equal(adopted.failed, true)
  assert.deepEqual(names(adopted.report), ['retains the real failed behavior', 'TestStoredValue'])
  assert.deepEqual(ciTestResults([adopted.report]).summary, { passed: 1, failed: 1, skipped: 0 })
  assert.equal(adopted.nativeCounts.executed, 1)
})
