import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { GetRunResponse } from '@graphql/contracts'
import { keepLatestRunResponse } from './runLiveCache'

function snapshot(sequence: string, eventCount = sequence, state = 'running', runId = 'run'): GetRunResponse {
  return {
    run: { id: runId, workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', executionState: state },
    executions: [], activity: [], liveActivity: { runId, workspaceId: 'workspace', workflowId: 'workflow',
      workflowVersionId: 'version', active: state !== 'completed', sequence, eventCount, nodes: [] },
  } as unknown as GetRunResponse
}

describe('live Run React Query cache ordering', () => {
  it('accepts the first snapshot', () => {
    const next = snapshot('1')
    assert.equal(keepLatestRunResponse(undefined, next), next)
  })
  it('rejects a late older response', () => {
    const current = snapshot('12', '9'), stale = snapshot('11', '8')
    assert.equal(keepLatestRunResponse(current, stale), current)
  })
  it('uses exact bigint cursors beyond Number precision', () => {
    const current = snapshot('9007199254740993', '10'), stale = snapshot('9007199254740992', '10')
    assert.equal(keepLatestRunResponse(current, stale), current)
  })
  it('accepts an event with lower sequence that committed after the previous snapshot', () => {
    const current = snapshot('50', '20'), next = snapshot('50', '21')
    assert.equal(keepLatestRunResponse(current, next), next)
    assert.equal(keepLatestRunResponse(next, current), next)
  })
  it('keeps a terminal snapshot terminal', () => {
    const current = snapshot('20', '20', 'completed')
    assert.equal(keepLatestRunResponse(current, snapshot('19')), current)
  })
  it('accepts newly confirmed terminal state', () => {
    const terminal = snapshot('10', '10', 'completed')
    assert.equal(keepLatestRunResponse(snapshot('9'), terminal), terminal)
  })
  it('never carries a previous Run into a newly selected Run', () => {
    const next = snapshot('1', '1', 'running', 'new-run')
    assert.equal(keepLatestRunResponse(snapshot('100'), next), next)
  })
  it('refuses to change an immutable version within one Run', () => {
    const current = snapshot('1'), wrong = snapshot('2')
    wrong.run.workflowVersionId = 'other-version'
    assert.equal(keepLatestRunResponse(current, wrong), current)
  })
  it('does not replace a verified snapshot with a response missing live evidence', () => {
    const current = snapshot('1'), missing = snapshot('2')
    delete missing.liveActivity
    assert.equal(keepLatestRunResponse(current, missing), current)
  })
})

it('rejects a stale cleanup/cause snapshot using its persisted lifecycle event', () => {
  const old = { ...snapshot('50', '10', 'completed'), cleanupPending: true }
  const next = { ...snapshot('51', '11', 'completed'), cleanupPending: false }
  assert.equal(keepLatestRunResponse(old, next), next)
  assert.equal(keepLatestRunResponse(next, old), next)
})
