import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AgentSchema,
  GetAgentRequestSchema,
  GetAgentResponseSchema,
  type Agent,
  type ListAgentsResponse,
  type WorkspaceDetailsResponse,
} from '@graphql/contracts'

import { apiClient } from './client'
import { queryKeys } from './query'

export async function saveAgent(workspaceId: string, agent: Agent) {
  const scope = GetAgentRequestSchema.parse({ workspaceId, agentId: agent.id })
  return apiClient.request(
    `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/agents/${encodeURIComponent(scope.agentId)}`,
    GetAgentResponseSchema,
    { method: 'PUT', body: AgentSchema.parse(agent) },
  )
}

export function useSaveAgentMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ workspaceId, agent }: { workspaceId: string; agent: Agent }) => saveAgent(workspaceId, agent),
    onSuccess: ({ agent }, { workspaceId }) => {
      client.setQueryData(queryKeys.agent(workspaceId, agent.id), { agent })
      client.setQueryData<ListAgentsResponse>(queryKeys.agents(workspaceId), (current) => current ? {
        ...current, agents: current.agents.map((entry) => entry.id === agent.id ? agent : entry),
      } : current)
      client.setQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails(workspaceId), (current) => current ? {
        ...current, agents: current.agents.map((entry) => entry.id === agent.id ? agent : entry),
      } : current)
    },
  })
}
