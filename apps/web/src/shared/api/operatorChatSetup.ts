import { useQuery } from '@tanstack/react-query'
import { OperatorChatSetupSchema } from '@graphql/contracts'
import { apiClient } from './client'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useOperatorChatSetup(enabled: boolean, revision?: number) {
  return useQuery({ queryKey: ['operator-chat', 'setup', sessionGeneration(), revision],
    enabled: enabled && !sessionIsSwitching(), retry: false, staleTime: 30_000, refetchInterval: 30_000,
    queryFn: ({ signal }) => apiClient.request('/api/operator/setup', OperatorChatSetupSchema, { signal }),
  })
}
