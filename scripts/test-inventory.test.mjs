import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { removedTests, testDefinitions } from './test-inventory.mjs'

describe('test definitions', () => {
  it('lists tests with their suite path, including modified and parameterized tests', () => {
    const source = [
      "describe('runs', () => {",
      "  describe('stop', () => {",
      "    it('stops a run', () => {})",
      "    it.skipIf(!postgres)('persists the stop', () => {})",
      '  })',
      "  test.each([1, 2])('retries %s times', () => {})",
      "  it(`handles ${kind}`, () => {})",
      '})',
    ].join('\n')
    assert.deepEqual(testDefinitions('runs.test.ts', source), [
      'runs > stop > stops a run',
      'runs > stop > persists the stop',
      'runs > retries %s times',
      'runs > `handles ${kind}`',
    ])
  })

  it('parses TSX and plain JavaScript tests', () => {
    assert.deepEqual(testDefinitions('Board.test.tsx', "it('renders', () => { render(<Board />) })"), ['renders'])
    assert.deepEqual(testDefinitions('cli.test.mjs', "test('prints help', () => {})"), ['prints help'])
  })
})

describe('removed tests', () => {
  const before = new Map([['a.test.ts', ['runs > stops a run', 'runs > retries']], ['b.test.ts', ['saves']]])

  it('reports deleted and renamed tests', () => {
    const after = new Map([['a.test.ts', ['runs > stops a run']], ['b.test.ts', ['saves the draft']]])
    assert.deepEqual(removedTests(before, after), ['a.test.ts: runs > retries', 'b.test.ts: saves'])
  })

  it('ignores tests that moved to another file and newly added tests', () => {
    const after = new Map([
      ['a.test.ts', ['runs > stops a run']],
      ['c.test.ts', ['runs > retries', 'saves', 'loads']],
    ])
    assert.deepEqual(removedTests(before, after), [])
  })

  it('reports one of two tests with the same title when only one remains', () => {
    const duplicated = new Map([['a.test.ts', ['runs', 'runs']]])
    assert.deepEqual(removedTests(duplicated, new Map([['a.test.ts', ['runs']]])), ['a.test.ts: runs'])
  })
})
