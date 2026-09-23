import { describe, expect, it } from 'vitest'
import { RunCurrentRequestSchema, RunCurrentResponseSchema } from './runCurrent.js'

const scope = { workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'v', executionSemanticsVersion: 1 }
const current = () => ({
  kind: 'legacy-run-current', executionSemanticsVersion: 1,
  run: { id: 'run', workspaceId: 'ws', workflowId: 'wf', workflowVersionId: 'v',
    executionState: 'running', outcome: 'pending', createdAt: '2026-09-22T00:00:00.000Z' },
  executions: [{ id: 'e', runId: 'run', workflowNodeId: 'node', attempt: 1, state: 'running' }],
  executionCoverage: 'latest-attempt-per-pinned-node', cleanupPending: false,
  settlement: 'unconfirmed', history: 'not-included', asOfActivitySequence: '100000',
})

describe('FE-R2-001 shared current read contract', () => {
  it('is an explicit current response, never an empty full-history response', () => {
    expect(RunCurrentRequestSchema.parse(scope)).toEqual(scope)
    expect(RunCurrentResponseSchema.parse(current())).toEqual(current())
    for (const extension of [{ activity: [] }, { liveActivity: {} }, { result: {} }]) {
      expect(RunCurrentResponseSchema.safeParse({ ...current(), ...extension }).success).toBe(false)
    }
    expect(RunCurrentResponseSchema.safeParse({ ...current(), history: 'complete' }).success).toBe(false)
    expect(RunCurrentResponseSchema.safeParse({ ...current(), settlement: 'settled' }).success).toBe(false)
  })
  it('rejects absent, unknown and v2 requested semantics rather than treating them as legacy', () => {
    for (const executionSemanticsVersion of [undefined, null, '1', 2, 3]) {
      expect(RunCurrentRequestSchema.safeParse({ ...scope, executionSemanticsVersion }).success).toBe(false)
      expect(RunCurrentResponseSchema.safeParse({ ...current(), executionSemanticsVersion }).success).toBe(false)
    }
  })
  it('requires lifecycle/outcome coherence without turning cleanup into an outcome', () => {
    for (const cleanupPending of [false, true]) {
      const value = { ...current(), cleanupPending,
        run: { ...current().run, executionState: 'completed', outcome: 'succeeded', finishedAt: '2026-09-22T01:00:00.000Z' } }
      expect(RunCurrentResponseSchema.parse(value).settlement).toBe('unconfirmed')
    }
    expect(RunCurrentResponseSchema.safeParse({ ...current(), run: { ...current().run, outcome: 'succeeded' } }).success).toBe(false)
    expect(RunCurrentResponseSchema.safeParse({ ...current(), run: { ...current().run, executionState: 'completed' } }).success).toBe(false)
  })
  it('validates decimal high-water observations without numeric rounding or thrown BigInt conversions', () => {
    for (const asOfActivitySequence of ['0', '9007199254740993', '9223372036854775807']) {
      expect(RunCurrentResponseSchema.parse({ ...current(), asOfActivitySequence }).asOfActivitySequence).toBe(asOfActivitySequence)
    }
    for (const asOfActivitySequence of ['-1', '01', '', 'abc', '1e3', '9223372036854775808', '1'.repeat(100)]) {
      expect(RunCurrentResponseSchema.safeParse({ ...current(), asOfActivitySequence }).success).toBe(false)
    }
  })
  it('rejects duplicate nodes, duplicate execution identities and foreign-Run attempts', () => {
    const execution = current().executions[0]!
    for (const extra of [execution, { ...execution, id: 'other' }, { ...execution, runId: 'foreign' }]) {
      expect(RunCurrentResponseSchema.safeParse({ ...current(), executions: [execution, extra] }).success).toBe(false)
    }
  })
})
