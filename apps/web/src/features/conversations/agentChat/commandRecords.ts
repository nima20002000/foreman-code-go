import type { QueryClient } from '@tanstack/react-query'
import type { AgentChatState, AgentChatTurn, SendAgentChatMessageRequest, SendAgentChatMessageResponse } from '@graphql/contracts/agent-chat'

export type AgentChatCommand =
  | { kind: 'send'; input: SendAgentChatMessageRequest; clearDraft: boolean }
  | { kind: 'stop'; conversationId: string; requestId: string; expectedNativeTurnId?: string }
  | { kind: 'cancel'; conversationId: string; requestId: string; turnRequestId: string }
  | { kind: 'respond'; conversationId: string; requestId: string; nativeRequestId: string; optionId: string }

/** The query owns the full projection. Mutations keep only command/readback identity, not snapshots. */
export type AgentChatCommandResult = { conversationId?: string; turn?: AgentChatTurn; replayed?: boolean }
export type AgentChatCommandRecord = {
  command: AgentChatCommand | undefined; result: AgentChatCommandResult | undefined; error: unknown
  status: 'idle' | 'pending' | 'success' | 'error'; submittedAt: number
}
export const AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT = 20

export function compactAgentChatResult(result: SendAgentChatMessageResponse | { state: AgentChatState }): AgentChatCommandResult {
  return { conversationId: result.state.conversation?.id,
    ...('turn' in result ? { turn: result.turn, replayed: result.replayed } : {}) }
}

/** Never read a receipt from a replacement conversation, even if its request id happens to match. */
export function currentCommandReceipt(result: AgentChatCommandResult | undefined, state: AgentChatState | undefined): AgentChatTurn | undefined {
  const requestId = result?.turn?.requestId
  return requestId && result?.conversationId === state?.conversation?.id
    ? state?.turns.find((turn) => turn.requestId === requestId) : undefined
}

export function isRetirableAcknowledgement(record: Pick<AgentChatCommandRecord, 'status' | 'result'>, state?: AgentChatState): boolean {
  if (record.status !== 'success') return false
  const turn = currentCommandReceipt(record.result, state) ?? record.result?.turn
  // Keep unresolved input even after HTTP success: accepted/queued work can still become unknown.
  // A successful control has no turn; a send retires only after positive terminal readback.
  return !turn || ['completed', 'failed', 'canceled'].includes(turn.delivery)
}

/** Bound terminal acknowledgements across this QueryClient, including commands finishing while
 * the panel is closed. Pending/error/nonterminal identities are never aged out or replayed. */
export function retireAgentChatAcknowledgements(client: QueryClient): void {
  const cache = client.getMutationCache()
  const acknowledged = cache.getAll().filter((mutation) => {
    const key = mutation.options.mutationKey
    if (key?.length !== 4 || key[0] !== 'agent-chat' || key[3] !== 'command') return false
    const state = client.getQueryData<AgentChatState>([...key.slice(0, 3), 'state'])
    return isRetirableAcknowledgement({ status: mutation.state.status, result: mutation.state.data as AgentChatCommandResult | undefined }, state)
  })
  for (const mutation of acknowledged.slice(0, -AGENT_CHAT_ACKNOWLEDGEMENT_LIMIT)) cache.remove(mutation)
}
