import { SessionControlRequestSchema, SessionControlStateSchema, type SessionControlRequest } from '@graphql/contracts'
import { apiClient, type RequestOptions } from './client'
import { agentChatConversationPath } from './agentChat'

function path(conversationId: string, workspaceId?: string) {
  const root = workspaceId ? agentChatConversationPath(workspaceId, conversationId)
    : `/api/operator/conversations/${encodeURIComponent(conversationId)}`
  return `${root}/session-controls`
}
export const sessionControlsApi = {
  read(conversationId: string, workspaceId?: string, options?: RequestOptions) {
    return apiClient.request(path(conversationId, workspaceId), SessionControlStateSchema, options)
  },
  change(conversationId: string, request: SessionControlRequest, workspaceId?: string) {
    return apiClient.request(path(conversationId, workspaceId), SessionControlStateSchema,
      { method: 'POST', body: SessionControlRequestSchema.parse(request) })
  },
}
