import type { AgentChatState, AgentChatTurn } from '@graphql/contracts/agent-chat'
import type { AgentChatCommandRecord } from './useAgentChat'

type Command = NonNullable<AgentChatCommandRecord['command']>
// Only remembers a local side effect, not request/server state. Weak keys retire with mutations.
const reconciledDrafts = new WeakSet<Command>()

/** Match the actual admitted request, never just equal text or a neighboring conversation. */
export function receiptForCommand(state: AgentChatState | undefined, command: Command | undefined): AgentChatTurn | undefined {
  if (!state?.conversation || command?.kind !== 'send') return undefined
  const input = command.input, context = state.context
  if (input.context.workflowId !== context.workflowId || input.context.workflowNodeId !== context.workflowNodeId
    || input.context.agentId !== context.agentId || input.context.runId !== context.runId
    || input.expectedConversationId !== null && input.expectedConversationId !== state.conversation.id) return undefined
  return state.turns.find((turn) => turn.requestId === input.requestId)
}

/** Reconcile an unchanged draft once, including GET/SSE readback after a lost POST response. */
export function claimDraftReadback(command: Command | undefined, receipt: AgentChatTurn | undefined): boolean {
  if (command?.kind !== 'send' || !command.clearDraft || !receipt || receipt.requestId !== command.input.requestId
    || receipt.delivery === 'unknown' || receipt.delivery === 'failed' || reconciledDrafts.has(command)) return false
  reconciledDrafts.add(command)
  return true
}
