import { describe, expect, it } from 'vitest'
import { createChatVisit, resolvedSelectedChatKey, selectedChatDraftKey, stateMatchesSelectedChat } from './selectedRunChatModel'
import { context, execution, historicalState } from './sch10.testSupport'

describe('SCH-10 complete chat identity', () => {
  it.each(['workspaceId', 'workflowId', 'runId', 'workflowNodeId', 'executionId'] as const)('partitions %s', (field) => {
    const a = execution('run-a'), b = { ...a, [field]: `${a[field]}-other` }
    expect(selectedChatDraftKey(a, 'agent', 'conversation')).not.toBe(selectedChatDraftKey(b, 'agent', 'conversation'))
  })
  it('partitions Agent, conversation and pre-creation drafts', () => {
    const target = execution('run-a')
    expect(new Set([selectedChatDraftKey(target, 'a', null), selectedChatDraftKey(target, 'a', 'c'),
      selectedChatDraftKey(target, 'a', 'd'), selectedChatDraftKey(target, 'b', 'c')]).size).toBe(4)
  })
  it('validates conversation origin, not just equal Agent and Run', () => {
    const state = historicalState('run-a'), selection = execution('run-a'), key = resolvedSelectedChatKey(selection, state)
    expect(stateMatchesSelectedChat(state, context('run-a'), { selection, key })).toBe(true)
    if (state.conversation!.origin.kind !== 'run_execution') throw new Error('fixture')
    state.conversation!.origin.executionId = 'other'
    expect(stateMatchesSelectedChat(state, context('run-a'), { selection, key })).toBe(false)
  })
  it('drops captures across a disposed/remounted visit even when the Run again matches', () => {
    let selected = true
    const visit = createChatVisit(() => selected), close = visit.mount(), old = visit.capture()
    expect(old()).toBe(true)
    selected = false; expect(old()).toBe(false)
    close(); selected = true; const closeAgain = visit.mount()
    expect(old()).toBe(false)
    expect(visit.capture()()).toBe(true)
    closeAgain(); expect(visit.isCurrent()).toBe(false)
  })
})
