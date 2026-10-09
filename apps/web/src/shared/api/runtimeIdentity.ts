import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { useQuery } from '@tanstack/react-query'
import { ApiError, apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useRuntimeIdentityQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['workbench', 'runtime-identity', sessionGeneration()],
    retry: (_failureCount, error) => ApiError.is(error)
      && (error.code === 'NETWORK_ERROR' || error.status >= 500),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
    enabled: !sessionIsSwitching(), staleTime: 0, refetchInterval: 60_000,
    queryFn: ({ signal }) => apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal }) })
}
