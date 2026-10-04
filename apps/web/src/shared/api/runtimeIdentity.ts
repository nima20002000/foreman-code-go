import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useRuntimeIdentityQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['workbench', 'runtime-identity', sessionGeneration()], retry: false,
    enabled: !sessionIsSwitching(), staleTime: 0, refetchInterval: 60_000,
    queryFn: ({ signal }) => apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal }) })
}
