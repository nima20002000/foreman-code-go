import type { AgentChatContext, AgentChatState } from '@graphql/contracts/agent-chat'
import type { SelectedRunChatExecution, SelectedRunChatSelection } from '@graphql/contracts/selected-run-chat'
import type { SelectedRunChatKey } from '@graphql/contracts/run-snapshots'

/** The null conversation is a pre-creation draft address, NOT a SelectedRunChatKey. */
export function selectedChatDraftKey(selection: SelectedRunChatExecution, agentId: string, conversationId: string | null): string {
  return JSON.stringify(['selected-run-chat', selection.workspaceId, selection.workflowId, selection.runId,
    selection.workflowNodeId, selection.executionId, agentId, conversationId])
}

export function sameSelectedTarget(expected: SelectedRunChatSelection, actual: SelectedRunChatSelection): boolean {
  return expected.workspaceId === actual.workspaceId && expected.workflowId === actual.workflowId
    && expected.runId === actual.runId && expected.workflowNodeId === actual.workflowNodeId
    && (expected.executionId === undefined || expected.executionId === actual.executionId)
}

export type SelectedChatBinding = {
  selection: SelectedRunChatExecution
  key: SelectedRunChatKey | null
  visitId: string
  isCurrent(): boolean
  /** Only promotes null -> a complete key obtained from authoritative readback. */
  onConversation(state: AgentChatState): void
}

/** Same Agent is not enough. Never accept another execution, conversation, or fresh chat. */
export function stateMatchesSelectedChat(state: AgentChatState, context: AgentChatContext,
  binding: Pick<SelectedChatBinding, 'selection' | 'key'>): boolean {
  const { selection, key } = binding
  if (!sameSelectedTarget(selection, { ...context, runId: context.runId ?? '', executionId: selection.executionId })
    || !sameSelectedTarget(selection, { ...state.context, runId: state.context.runId ?? '', executionId: selection.executionId })
    || state.context.agentId !== context.agentId) return false
  const conversation = state.conversation
  if (!conversation) return key === null && !state.messages.length && !state.turns.length
    && !state.activities.length && !state.activeTurn && !state.pendingInteraction
  return conversation.workspaceId === selection.workspaceId && conversation.workflowId === selection.workflowId
    && conversation.workflowNodeId === selection.workflowNodeId && conversation.agentId === context.agentId
    && conversation.origin.kind === 'run_execution' && conversation.origin.runId === selection.runId
    && conversation.origin.executionId === selection.executionId
    && (!key || key.conversationId === conversation.id && key.agentId === conversation.agentId
      && sameSelectedTarget(selection, key))
    && state.messages.every((message) => message.conversationId === conversation.id)
}

export function resolvedSelectedChatKey(selection: SelectedRunChatExecution, state: AgentChatState): SelectedRunChatKey | null {
  return state.conversation ? { ...selection, agentId: state.conversation.agentId, conversationId: state.conversation.id } : null
}

/** A mount lease supplements the URL's visit ticket. Old callbacks cannot revive on A -> B -> A. */
export function createChatVisit(isSelected: () => boolean) {
  let epoch = 0, mounted = true
  return {
    mount() { mounted = true; return () => { mounted = false; epoch++ } },
    capture() { const ticket = epoch; return () => mounted && ticket === epoch && isSelected() },
    isCurrent() { return mounted && isSelected() },
  }
}
