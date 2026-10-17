import { describe, expect, it } from 'vitest'
import { createReport, describeFailure, setupFailureOutcomes } from './report.js'
import { LANES, type RunIdentity, type ScenarioOutcome } from './types.js'

const identity: RunIdentity = {
  repository: 'nima20002000/foreman-code-go',
  baselineSha: '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f',
  commitSha: '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f',
  commitSource: 'git',
}
const startedAt = new Date('2026-10-17T00:00:00.000Z')
const finishedAt = new Date('2026-10-17T00:00:01.000Z')

function report(scenarios: ScenarioOutcome[], setupError?: unknown) {
  return createReport({ identity, target: 'go', startedAt, finishedAt, scenarios, setupError })
}

describe('conformance result reporting', () => {
  it('retains both the actual target error and a subsequent cleanup error', () => {
    const result = describeFailure(new AggregateError([
      new Error('Route returned 501'), new Error('Database process did not stop'),
    ], 'Scenario and target cleanup failed'))
    expect(result.causes).toEqual([
      { name: 'Error', message: 'Route returned 501' },
      { name: 'Error', message: 'Database process did not stop' },
    ])
  })
  it('counts actual outcomes overall and in all eight lanes', () => {
    const result = report([
      { id: 'health.live', title: 'Liveness', lane: 'SKEL', status: 'passed', phase: 'scenario', executed: true, durationMs: 15 },
      { id: 'workspace.create', title: 'Create workspace', lane: 'A2', status: 'failed', phase: 'scenario', executed: true, durationMs: 21,
        error: { name: 'AssertionError', message: 'Expected 201, received 404' } },
    ])
    expect(result.totals).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 })
    expect(Object.keys(result.lanes)).toEqual([...LANES])
    expect(result.lanes.SKEL).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 })
    expect(result.lanes.A2).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0 })
    expect(result.lanes.H).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 })
    expect(result.status).toBe('failed')
  })

  it('attributes an unavailable target to each selected scenario and records setup separately', () => {
    const failure = new Error('Go target binary is unavailable')
    const scenarios = [
      { id: 'health.live', title: 'Liveness', lane: 'SKEL' as const },
      { id: 'workflow.start', title: 'Start workflow', lane: 'E' as const },
    ]
    const result = report(setupFailureOutcomes(scenarios, failure), failure)
    expect(result.status).toBe('failed')
    expect(result.totals).toEqual({ total: 2, passed: 0, failed: 2, skipped: 0 })
    expect(result.setupError).toEqual({ name: 'Error', message: failure.message })
    expect(result.scenarios.every(scenario => scenario.phase === 'setup' && !scenario.executed)).toBe(true)
    expect(result.scenarios.map(scenario => [scenario.id, scenario.status])).toEqual([
      ['health.live', 'failed'], ['workflow.start', 'failed'],
    ])
  })

  it('never reports an empty selection as passing', () => {
    expect(report([]).status).toBe('failed')
  })

  it('rejects duplicate scenario identities instead of inflating the denominator', () => {
    const scenario: ScenarioOutcome = {
      id: 'health.live', title: 'Liveness', lane: 'SKEL', status: 'passed', phase: 'scenario', executed: true, durationMs: 1,
    }
    expect(() => report([scenario, scenario])).toThrow('Duplicate conformance scenario ID: health.live')
  })

  it('records cleanup failures even when every scenario passed', () => {
    const result = createReport({ identity, target: 'ts', startedAt, finishedAt,
      scenarios: [{ id: 'health.live', title: 'Liveness', lane: 'SKEL', status: 'passed', phase: 'scenario', executed: true, durationMs: 1 }],
      cleanupError: new Error('PostgreSQL did not stop'),
    })
    expect(result.status).toBe('failed')
    expect(result.totals.passed).toBe(1)
    expect(result.cleanupError?.message).toBe('PostgreSQL did not stop')
  })

  it('refuses a passing claim for an unexecuted scenario', () => {
    expect(() => report([{ id: 'health.live', title: 'Liveness', lane: 'SKEL',
      status: 'passed', phase: 'setup', executed: false, durationMs: 0,
    }])).toThrow('Unexecuted scenario cannot pass: health.live')
  })
})
