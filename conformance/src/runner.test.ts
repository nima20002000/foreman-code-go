import { describe, expect, it } from 'vitest'
import { runScenarios } from './runner.js'
import type { Scenario } from './scenario.js'

const scenarios: Scenario[] = [
  { id: 'health.live', title: 'Liveness', lane: 'SKEL', run: async () => undefined },
  { id: 'workspace.create', title: 'Workspace creation', lane: 'A2', run: async () => undefined },
]

describe('conformance runner continuation', () => {
  it('retains every selected outcome when target setup fails', async () => {
    const attempted: string[] = []
    const results = await runScenarios(scenarios, {
      async launch(scenario) {
        attempted.push(scenario.id)
        throw new Error('Go target binary is unavailable')
      },
    })
    expect(attempted).toEqual(['health.live', 'workspace.create'])
    expect(results.map(({ id, status, phase, executed }) => ({ id, status, phase, executed })))
      .toEqual(scenarios.map(({ id }) => ({ id, status: 'failed', phase: 'setup', executed: false })))
    expect(results.every(result => result.error?.message === 'Go target binary is unavailable')).toBe(true)
  })

  it('does not mistake an empty rejection reason for a passing setup', async () => {
    const results = await runScenarios(scenarios, { launch: () => Promise.reject() })
    expect(results.every(result => result.status === 'failed' && !result.executed)).toBe(true)
    expect(results.map(result => result.error?.message)).toEqual(['undefined', 'undefined'])
  })
})
