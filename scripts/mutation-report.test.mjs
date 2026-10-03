import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mutationVerdict, summarizeMutationReport } from './mutation-report.mjs'

const mutant = (status, line, mutatorName = 'ConditionalExpression', replacement = 'true') =>
  ({ status, mutatorName, replacement, location: { start: { line, column: 1 }, end: { line, column: 5 } } })

const report = {
  files: {
    'src/runs/engine.ts': { mutants: [mutant('Killed', 3), mutant('Timeout', 4), mutant('Survived', 9, 'EqualityOperator', 'a !== b')] },
    'src/runs/stop.ts': { mutants: [mutant('NoCoverage', 2), mutant('CompileError', 5), mutant('Killed', 6)] },
  },
}

describe('mutation report', () => {
  it('counts outcomes, scores covered mutants and lists survivors', () => {
    assert.deepEqual(summarizeMutationReport(report, 'apps/api'), {
      pkg: 'apps/api',
      counts: { detected: 3, survived: 1, noCoverage: 1, other: 1 },
      coveredScore: 75,
      survivors: ['apps/api/src/runs/engine.ts:9 EqualityOperator -> a !== b'],
    })
  })

  it('has no covered score when no test executes a mutant', () => {
    const uncovered = { files: { 'src/a.ts': { mutants: [mutant('NoCoverage', 1)] } } }
    assert.equal(summarizeMutationReport(uncovered, 'apps/api').coveredScore, undefined)
  })
})

describe('mutation verdict', () => {
  const summary = (detected, survived) => ({ counts: { detected, survived, noCoverage: 0, other: 0 } })

  it('combines packages and compares with the minimum', () => {
    assert.deepEqual(mutationVerdict([summary(6, 1), summary(1, 2)], 70), { coveredScore: 70, pass: true })
    assert.deepEqual(mutationVerdict([summary(6, 1), summary(0, 3)], 70), { coveredScore: 60, pass: false })
  })

  it('passes when nothing covered was mutated', () => {
    assert.deepEqual(mutationVerdict([], 70), { coveredScore: undefined, pass: true })
  })
})
