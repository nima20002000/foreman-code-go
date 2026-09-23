import { describe, expect, it } from 'vitest'
import { keepLatestRunCurrent } from './legacyCurrent'
import { legacyCurrent } from './fe-r2-001.fixtures'

describe('FE-R2-001 compact Query acceptance guards', () => {
  it('checks observation order before promoting completion and preserves exact decimal order', () => {
    const previous = legacyCurrent('9007199254740993')
    const next = legacyCurrent('9007199254740992')
    next.run = { ...next.run, executionState: 'completed', outcome: 'succeeded', finishedAt: '2026-09-22T01:00:00.000Z' }
    expect(keepLatestRunCurrent(previous, next)).toBe(previous)
  })
  it('allows equal-observation cleanup changes without certifying settlement', () => {
    const previous = legacyCurrent('10', true)
    const next = legacyCurrent('10', false)
    expect(keepLatestRunCurrent(previous, next)).toBe(next)
    expect(next.settlement).toBe('unconfirmed')
  })
  it('preserves terminal outcome and interruption independently of polling', () => {
    const previous = legacyCurrent()
    previous.run = { ...previous.run, executionState: 'completed', outcome: 'succeeded', finishedAt: '2026-09-22T01:00:00.000Z' }
    expect(keepLatestRunCurrent(previous, legacyCurrent('11'))).toBe(previous)
    const interrupted = legacyCurrent()
    interrupted.run.executionState = 'interrupted'
    expect(keepLatestRunCurrent(interrupted, legacyCurrent('11'))).toBe(interrupted)
  })
  it('rejects different immutable scope', () => {
    const next = legacyCurrent()
    next.run.workflowVersionId = 'different-version'
    expect(() => keepLatestRunCurrent(legacyCurrent(), next)).toThrow('GRAPH_SCOPE_MISMATCH')
  })
})
