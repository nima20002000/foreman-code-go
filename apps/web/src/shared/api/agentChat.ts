import { z } from 'zod'
import {
  AgentChatContextSchema, AgentChatHistoryPageSchema, AgentChatQuerySchema, AgentChatStateSchema,
  AgentChatStateResponseSchema, CancelQueuedAgentChatTurnRequestSchema, InterruptAgentChatRequestSchema,
  RespondAgentChatInteractionRequestSchema, SendAgentChatMessageRequestSchema, SendAgentChatMessageResponseSchema,
  type AgentChatContext, type SendAgentChatMessageRequest,
} from '@foreman-code/contracts/agent-chat'
import { OperatorActivityCursorSchema } from '@foreman-code/contracts'
import { apiClient, ApiError, type RequestOptions } from './client'

const path = encodeURIComponent
export const agentChatRoot = (workspaceId: string) => `/api/workspaces/${path(workspaceId)}/agent-chat`
export const agentChatConversationPath = (workspaceId: string, conversationId: string) =>
  `${agentChatRoot(workspaceId)}/conversations/${path(conversationId)}`

/** All chat HTTP goes through the browser's authenticated, MSW-interceptable client. */
export const agentChatApi = {
  read(context: AgentChatContext, options?: RequestOptions) {
    const { workspaceId, ...query } = AgentChatContextSchema.parse(context)
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(AgentChatQuerySchema.parse(query))) if (value !== undefined) params.set(key, value)
    return apiClient.request(`${agentChatRoot(workspaceId)}?${params}`, AgentChatStateSchema, options)
  },
  send(workspaceId: string, input: SendAgentChatMessageRequest, options?: RequestOptions) {
    return apiClient.request(`${agentChatRoot(workspaceId)}/messages`, SendAgentChatMessageResponseSchema,
      { ...options, method: 'POST', body: SendAgentChatMessageRequestSchema.parse(input) })
  },
  interrupt(workspaceId: string, conversationId: string, input: z.infer<typeof InterruptAgentChatRequestSchema>, options?: RequestOptions) {
    return apiClient.request(`${agentChatConversationPath(workspaceId, conversationId)}/interrupt`, AgentChatStateResponseSchema,
      { ...options, method: 'POST', body: InterruptAgentChatRequestSchema.parse(input) })
  },
  cancelQueued(workspaceId: string, conversationId: string, turnRequestId: string,
    input: z.infer<typeof CancelQueuedAgentChatTurnRequestSchema>, options?: RequestOptions) {
    return apiClient.request(`${agentChatConversationPath(workspaceId, conversationId)}/turns/${path(turnRequestId)}/cancel`, AgentChatStateResponseSchema,
      { ...options, method: 'POST', body: CancelQueuedAgentChatTurnRequestSchema.parse(input) })
  },
  respond(workspaceId: string, conversationId: string, input: z.infer<typeof RespondAgentChatInteractionRequestSchema>, options?: RequestOptions) {
    return apiClient.request(`${agentChatConversationPath(workspaceId, conversationId)}/responses`, AgentChatStateResponseSchema,
      { ...options, method: 'POST', body: RespondAgentChatInteractionRequestSchema.parse(input) })
  },
  async history(workspaceId: string, conversationId: string, before?: string, options?: RequestOptions) {
    const params = new URLSearchParams({ limit: '50' })
    if (before !== undefined) params.set('before', OperatorActivityCursorSchema.parse(before))
    const result = await apiClient.request(`${agentChatConversationPath(workspaceId, conversationId)}/history?${params}`, AgentChatHistoryPageSchema, options)
    if (result.conversationId !== conversationId || result.messages.some((message) => message.conversationId !== conversationId)) {
      throw new ApiError({ code: 'AGENT_CHAT_CONTEXT_STALE', message: 'The history does not belong to this conversation.' }, 409)
    }
    return result
  },
}
