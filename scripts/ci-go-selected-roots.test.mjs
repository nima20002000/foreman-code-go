import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { writeGoTestResults } from './ci-go-test-results.mjs'

// Synthetic Go JSON exercises the existing public converter, never actual Go execution.
const modulePath = 'github.com/nima20002000/foreman-code-go/backend'
function packageEvents(path, cases) {
  const Package = `${modulePath}/${path}`
  return [{ Action: 'start', Package }, ...cases.flatMap(([Test, Action = 'pass']) => [
    { Action: 'run', Package, Test }, { Action, Package, Test, Elapsed: 0.007 },
  ]), { Action: cases.some(([, action]) => action === 'fail') ? 'fail' : 'pass', Package, Elapsed: 0.015 }]
}
async function convert(t, events, selection) {
  const directory = mkdtempSync(join(tmpdir(), 'selected-go-roots-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, 'actual-report.json')
  const input = Readable.from(events.map(event => `${JSON.stringify(event)}\n`))
  const result = await writeGoTestResults(input, { modulePath, output, selection })
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), result.report)
  return result
}

test('a passing package cannot hide a selected Go root with no actual outcome', async t => {
  const result = await convert(t, packageEvents('first', [['TestStoredValue']]), {
    './first': ['TestStoredValue'], './second': ['TestRequiredValue'],
  })
  assert.equal(result.failed, true)
  assert.equal(result.selected, 1)
  assert.equal(result.executed, 1)
  assert.deepEqual(result.report.testResults.flatMap(row => row.assertionResults.map(item => item.fullName)), ['TestStoredValue'])
})

test('a passing root cannot hide another explicitly selected root in the same Go package', async t => {
  const result = await convert(t, packageEvents('first', [['TestStoredValue']]), {
    './first': ['TestStoredValue', 'TestRequiredValue'],
  })
  assert.equal(result.failed, true)
  assert.equal(result.selected, 1)
  assert.equal(result.executed, 1)
})

test('true subtests preserve their names and durations without satisfying a different selected root', async t => {
  const Package = `${modulePath}/first`
  const result = await convert(t, [
    { Action: 'start', Package }, { Action: 'run', Package, Test: 'TestStoredValue' },
    { Action: 'run', Package, Test: 'TestStoredValue/roundtrip' },
    { Action: 'pass', Package, Test: 'TestStoredValue/roundtrip', Elapsed: 0.003 },
    { Action: 'pass', Package, Test: 'TestStoredValue', Elapsed: 0.007 }, { Action: 'pass', Package, Elapsed: 0.015 },
  ], {
    './first': ['TestStoredValue'],
  })
  assert.equal(result.failed, false)
  assert.equal(result.selected, 2)
  assert.equal(result.executed, 2)
  assert.deepEqual(result.report.testResults[0].assertionResults.map(item => [item.fullName, item.duration]), [
    ['TestStoredValue', 7], ['TestStoredValue/roundtrip', 3],
  ])
  const prefix = await convert(t, packageEvents('first', [['TestStoredValues']]), { './first': ['TestStoredValue'] })
  assert.equal(prefix.failed, true)
})

test('a skipped required root remains visible and fails even beside another executed root', async t => {
  const result = await convert(t, packageEvents('first', [['TestStoredValue'], ['TestRequiredValue', 'skip']]), {
    './first': ['TestStoredValue', 'TestRequiredValue'],
  })
  assert.equal(result.failed, true)
  assert.equal(result.selected, 2)
  assert.equal(result.executed, 1)
  assert.equal(result.report.testResults[0].assertionResults[1].status, 'skipped')
})

test('an unexpected package or named root cannot broaden the accepted Go selection', async t => {
  for (const extra of [packageEvents('second', [['TestStoredValue']]), packageEvents('first', [['TestOtherValue']])]) {
    const events = extra[0].Package.endsWith('/first') ? extra : [...packageEvents('first', [['TestStoredValue']]), ...extra]
    const result = await convert(t, events, { './first': ['TestStoredValue'] })
    assert.equal(result.failed, true)
  }
})

test('a real package with no matching case retains zero actual counts and a failing selected-root guard', async t => {
  const result = await convert(t, packageEvents('first', []), { './first': ['TestRequiredValue'] })
  assert.equal(result.failed, true)
  assert.equal(result.selected, 0)
  assert.equal(result.executed, 0)
  assert.deepEqual(result.report.testResults[0].assertionResults, [])
})

test('the converter default remains usable without an affected selection contract', async t => {
  const result = await convert(t, packageEvents('first', [['TestStoredValue']]))
  assert.equal(result.failed, false)
  assert.equal(result.selected, 1)
  assert.equal(Object.hasOwn(result, 'selection'), false)
})
