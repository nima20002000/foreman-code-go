import {
  AgentChatStateResponseSchema, SendAgentChatMessageResponseSchema,
  type AgentChatState, type SendAgentChatMessageRequest,
} from '@graphql/contracts/agent-chat'
import {
  ReadSelectedRunChatResponseSchema, SelectedRunChatSelectionSchema,
  SendSelectedRunChatRequestSchema, InterruptSelectedRunChatRequestSchema,
  type SelectedRunChatExecution, type SelectedRunChatSelection,
} from '@graphql/contracts/selected-run-chat'
import type { SelectedRunChatKey } from '@graphql/contracts/run-snapshots'
import { apiClient, ApiError, type RequestOptions } from '../../../shared/api/client'
import { agentChatRoot } from '../../../shared/api/agentChat'
import { resolvedSelectedChatKey, sameSelectedTarget } from './selectedRunChatModel'

export const selectedRunChatPath = (selection: SelectedRunChatSelection) =>
  `${agentChatRoot(selection.workspaceId)}/workflows/${encodeURIComponent(selection.workflowId)}`
  + `/runs/${encodeURIComponent(selection.runId)}/nodes/${encodeURIComponent(selection.workflowNodeId)}`

function invalid(): never {
  throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Chat identity changed.' }, 409)
}

/** Reuse the frozen response envelope to validate origin/key agreement for POST readbacks too. */
function validateState(selection: SelectedRunChatExecution, state: AgentChatState) {
  const execution = { workspaceId: selection.workspaceId, workflowId: selection.workflowId, runId: selection.runId,
    workflowNodeId: selection.workflowNodeId, executionId: selection.executionId }
  const parsed = ReadSelectedRunChatResponseSchema.safeParse({ kind: 'selected', selection: execution,
    key: resolvedSelectedChatKey(execution, state), state })
  if (!parsed.success) invalid()
}

export const selectedRunChatApi = {
  async read(input: SelectedRunChatSelection, options?: RequestOptions) {
    const selection = SelectedRunChatSelectionSchema.parse(input)
    const query = selection.executionId ? `?${new URLSearchParams({ executionId: selection.executionId })}` : ''
    const result = await apiClient.request(`${selectedRunChatPath(selection)}${query}`, ReadSelectedRunChatResponseSchema, options)
    const actual = result.kind === 'selected' ? result.selection : result.target
    // Non-selected envelopes have no execution field. They still must match the exact Run/node.
    if (!sameSelectedTarget({ ...selection, executionId: result.kind === 'selected' ? selection.executionId : undefined }, actual)) invalid()
    return result
  },
  async send(selection: SelectedRunChatExecution, input: SendAgentChatMessageRequest, options?: RequestOptions) {
    const { context: _context, ...message } = input
    void _context // Agent/context is derived by SCH-06, never sent as a second selector.
    const parsed = SendSelectedRunChatRequestSchema.parse({ selection, message })
    const { attachments, ...messageBody } = parsed.message
    const result = await apiClient.request(`${selectedRunChatPath(parsed.selection)}/messages`, SendAgentChatMessageResponseSchema,
      { ...options, method: 'POST', body: { executionId: parsed.selection.executionId, ...messageBody,
        ...(attachments.length ? { attachments } : {}) } })
    validateState(selection, result.state)
    return result
  },
  async interrupt(key: SelectedRunChatKey, request: { requestId: string; expectedNativeTurnId?: string }, options?: RequestOptions) {
    const parsed = InterruptSelectedRunChatRequestSchema.parse({ key, request })
    const result = await apiClient.request(`${selectedRunChatPath(parsed.key)}/interrupt`, AgentChatStateResponseSchema,
      { ...options, method: 'POST', body: { executionId: parsed.key.executionId, agentId: parsed.key.agentId,
        conversationId: parsed.key.conversationId, ...parsed.request } })
    validateState(parsed.key, result.state)
    if (result.state.conversation?.id !== key.conversationId) invalid()
    return result
  },
}
