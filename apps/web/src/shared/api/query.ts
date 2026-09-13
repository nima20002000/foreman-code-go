import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query'
import type {
  CreateMessageRequest,
  CreateMessageResponse,
  GetConversationResponse,
  SaveWorkflowRequest,
  SaveWorkflowResponse,
  WorkspaceDetailsResponse,
} from '@graphql/contracts'

import {
  apiClient,
  getConversation,
  getAgent,
  getWorkflow,
  getWorkspaceDetails,
  listAgents,
  listConversations,
  listMessages,
  listVisibleResources,
  saveGraph,
  sendUserMessage,
  type RequestOptions,
} from './client'

/**
 * Query keys deliberately carry every scope identity used by the endpoint.
 * This prevents a conversation/workspace projection from leaking across tabs.
 */
export const queryKeys = {
  all: ['workbench'] as const,
  workspace: (workspaceId: string) => ['workbench', 'workspace', workspaceId] as const,
  workspaceDetails: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'details'] as const,
  agents: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'agents'] as const,
  agent: (workspaceId: string, agentId: string) =>
    ['workbench', 'workspace', workspaceId, 'agent', agentId] as const,
  workflow: (workspaceId: string, workflowId: string) =>
    ['workbench', 'workspace', workspaceId, 'workflow', workflowId] as const,
  conversations: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'conversations'] as const,
  conversation: (workspaceId: string, conversationId: string) =>
    ['workbench', 'workspace', workspaceId, 'conversation', conversationId] as const,
  messages: (workspaceId: string, conversationId: string) =>
    ['workbench', 'workspace', workspaceId, 'conversation', conversationId, 'messages'] as const,
  resources: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'resources'] as const,
}

export const workspaceQueryKeys = queryKeys

type QueryOptions<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>

export function useWorkspaceDetailsQuery(
  workspaceId: string,
  options?: QueryOptions<WorkspaceDetailsResponse>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.workspaceDetails(workspaceId),
    queryFn: ({ signal }) => getWorkspaceDetails({ workspaceId }, { signal }),
  })
}

export const useWorkspaceQuery = useWorkspaceDetailsQuery

export function useAgentsQuery(workspaceId: string, options?: QueryOptions<Awaited<ReturnType<typeof listAgents>>>) {
  return useQuery({
    ...options,
    queryKey: queryKeys.agents(workspaceId),
    queryFn: ({ signal }) => listAgents({ workspaceId }, { signal }),
  })
}

export function useAgentQuery(
  workspaceId: string,
  agentId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof getAgent>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.agent(workspaceId, agentId),
    queryFn: ({ signal }) => getAgent({ workspaceId, agentId }, { signal }),
  })
}

export function useWorkflowQuery(
  workspaceId: string,
  workflowId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof getWorkflow>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.workflow(workspaceId, workflowId),
    queryFn: ({ signal }) => getWorkflow({ workspaceId, workflowId }, { signal }),
  })
}

export function useConversationsQuery(
  workspaceId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof listConversations>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.conversations(workspaceId),
    queryFn: ({ signal }) => listConversations({ workspaceId }, { signal }),
  })
}

export function useConversationQuery(
  workspaceId: string,
  conversationId: string,
  options?: QueryOptions<GetConversationResponse>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.conversation(workspaceId, conversationId),
    queryFn: ({ signal }) => getConversation({ workspaceId, conversationId }, { signal }),
  })
}

export function useMessagesQuery(
  workspaceId: string,
  conversationId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof listMessages>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.messages(workspaceId, conversationId),
    queryFn: ({ signal }) => listMessages({ workspaceId, conversationId }, { signal }),
  })
}

export function useVisibleResourcesQuery(
  workspaceId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof listVisibleResources>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.resources(workspaceId),
    queryFn: ({ signal }) => listVisibleResources({ workspaceId }, { signal }),
  })
}

type SaveGraphMutationOptions = Omit<
  UseMutationOptions<SaveWorkflowResponse, Error, SaveWorkflowRequest>,
  'mutationFn'
>

export function useSaveGraphMutation(options?: SaveGraphMutationOptions) {
  return useMutation({
    ...options,
    mutationFn: (input) => saveGraph(input),
  })
}

export const useSaveWorkflowMutation = useSaveGraphMutation

type UserMessageInput = Omit<CreateMessageRequest, 'role'>
type UserMessageMutationOptions = Omit<
  UseMutationOptions<CreateMessageResponse, Error, UserMessageInput>,
  'mutationFn'
>

export function useUserMessageMutation(options?: UserMessageMutationOptions) {
  return useMutation({
    ...options,
    mutationFn: (input) => sendUserMessage(input),
  })
}

// Keep these imports part of the public feature API for callers that want a
// client boundary but do not need React Query.
export { apiClient }
export type { RequestOptions }
