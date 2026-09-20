import { useQuery } from '@tanstack/react-query'
import { OperatorChatSetupSchema, OperatorChatSetupQuerySchema, type OperatorChatSetupQuery } from '@graphql/contracts'
import { apiClient } from './client'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useOperatorChatSetup(enabled: boolean, revision?: number, target: OperatorChatSetupQuery = {}) {
  const query = { ...target, ...(revision === undefined ? {} : { expectedDefaultsRevision: revision }) }
  return useQuery({ queryKey: ['operator-chat', 'setup', sessionGeneration(), query],
    enabled: enabled && !sessionIsSwitching(), retry: false, staleTime: 30_000, refetchInterval: 30_000,
    queryFn: ({ signal }) => {
      const parsed = OperatorChatSetupQuerySchema.parse(query)
      const parameters = new URLSearchParams()
      for (const [key, value] of Object.entries(parsed)) if (value !== undefined) parameters.set(key, String(value))
      return apiClient.request(`/api/operator/setup?${parameters}`, OperatorChatSetupSchema, { signal })
    },
  })
}
