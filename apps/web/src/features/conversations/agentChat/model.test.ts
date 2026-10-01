import { describe, expect, it } from 'vitest'
import { agentChatFixtures, openCodeChatCapabilities, type AgentChatState } from '@graphql/contracts/agent-chat'
import { acceptAgentChatState, agentChatContextKey, approvalReplyAvailable, intentUnavailable, mergeChatMessages, stateBelongsToContext } from './model'
import { approvalState } from './testSupport'

describe('Agent chat identity and state projection', () => {
  it.each(Object.entries(agentChatFixtures))('accepts the exact context of fixture %s', (_name, state) => {
    expect(stateBelongsToContext(state, state.context)).toBe(true)
  })
  it('keys all five identities and never collapses absent Run into a real Run', () => {
    const context = agentChatFixtures.empty.context
    const keys = [agentChatContextKey(context), ...(['workspaceId', 'workflowId', 'workflowNodeId', 'agentId', 'runId'] as const)
      .map((key) => agentChatContextKey({ ...context, [key]: 'other' }))]
    expect(new Set(keys).size).toBe(6)
    expect(agentChatContextKey({ ...context, workflowId: 'x:y', workflowNodeId: 'z' }))
      .not.toBe(agentChatContextKey({ ...context, workflowId: 'x', workflowNodeId: 'y:z' }))
  })
  it('rejects another key, an inconsistent conversation, a wrong Run origin, and foreign messages', () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.active)
    expect(stateBelongsToContext(state, { ...state.context, agentId: 'other' })).toBe(false)
    state.conversation!.agentId = 'other'; expect(stateBelongsToContext(state, state.context)).toBe(false)
    state.conversation!.agentId = state.context.agentId
    state.context.runId = 'some-run'; expect(stateBelongsToContext(state, state.context)).toBe(false)
    delete state.context.runId
    state.messages[0]!.conversationId = 'foreign'; expect(stateBelongsToContext(state, state.context)).toBe(false)
  })
  it('an old GET or out-of-order snapshot cannot undo a receipt or completed reply', () => {
    const newer = agentChatFixtures.idleAfterCompletion
    expect(acceptAgentChatState(newer, agentChatFixtures.active)).toBe(newer)
    expect(acceptAgentChatState(newer, agentChatFixtures.empty)).toBe(newer)
    const partial: AgentChatState = { ...structuredClone(agentChatFixtures.active), revision: newer.revision }
    expect(acceptAgentChatState(newer, partial).messages[1]?.nativeMessageComplete).toBe(true)
  })
  it('overlapping history pages and replayed messages appear exactly once', () => {
    const messages = agentChatFixtures.idleAfterCompletion.messages
    expect(mergeChatMessages(messages, messages, messages)).toEqual(messages)
    expect(mergeChatMessages(messages, agentChatFixtures.active.messages).find((message) => message.role === 'assistant')?.content)
      .toBe('It is a workflow engine.')
  })
  it('orders turn sequences as decimal integers, not lexically or floating point', () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.activeWithQueue)
    state.turns[0]!.sequence = '9007199254740993'
    state.turns[1]!.sequence = '9007199254740992'
    state.turns[2]!.sequence = '9'
    expect(acceptAgentChatState(undefined, state).turns.map((turn) => turn.requestId)).toEqual(['request-3', 'request-2', 'request-1'])
  })
  it('gates first send, continuation, steering and queueing from capabilities', () => {
    expect(intentUnavailable(agentChatFixtures.empty, 'next_turn')).toBeUndefined()
    expect(intentUnavailable(agentChatFixtures.idleAfterCompletion, 'next_turn')).toBeUndefined()
    expect(intentUnavailable(agentChatFixtures.runActive, 'next_turn')).toBe(agentChatFixtures.runActive.availability.message)
    expect(intentUnavailable(agentChatFixtures.sessionMissing, 'next_turn')).toBe(agentChatFixtures.sessionMissing.availability.message)
    expect(intentUnavailable(agentChatFixtures.steerUnavailable, 'steer')).toBe(agentChatFixtures.steerUnavailable.capabilities.unavailable.steer)
    const state: AgentChatState = structuredClone(agentChatFixtures.active)
    delete state.activeTurn!.nativeTurnId
    expect(intentUnavailable(state, 'steer')).toMatch(/native turn identity/)
    state.capabilities = openCodeChatCapabilities
    expect(intentUnavailable(state, 'steer')).toBeUndefined()
    state.capabilities = { ...state.capabilities, queueNextTurn: false, unavailable: { queueNextTurn: 'Queue is full.' } }
    expect(intentUnavailable(state, 'next_turn')).toBe('Queue is full.')
  })
  it('requires the authorized native request/session/turn identities for approval replies', () => {
    const state = approvalState(); expect(approvalReplyAvailable(state)).toBe(true)
    state.pendingInteraction!.turn.nativeTurnId = 'wrong-turn'; expect(approvalReplyAvailable(state)).toBe(false)
    state.pendingInteraction!.turn.nativeTurnId = 'turn-1'
    delete state.pendingInteraction!.turn.nativeRequestId; expect(approvalReplyAvailable(state)).toBe(false)
  })
})

describe('equal-revision canonical readback', () => {
  it('cannot erase active A, queued B or elevate capabilities from a cached receipt at the same revision', () => {
    const current = agentChatFixtures.activeWithQueue
    const cached = { ...agentChatFixtures.idleAfterCompletion, revision: current.revision,
      capabilities: { ...current.capabilities, queueNextTurn: true } }
    expect(acceptAgentChatState(current, cached)).toBe(current)
  })
  it('cannot replace a completed message with a legacy partial field omitted', () => {
    const complete = agentChatFixtures.idleAfterCompletion.messages[1]!
    const partial = { ...complete, nativeMessageComplete: undefined, content: 'partial' }
    expect(mergeChatMessages([complete], [partial])).toEqual([complete])
  })
})
