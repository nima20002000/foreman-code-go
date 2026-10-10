import { useCallback, useSyncExternalStore } from 'react'
import { RuntimeIdentitySchema, type RuntimeIdentity } from '@foreman-code/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

function runtimeIdentityKey(generation: number) {
  return ['workbench', 'runtime-identity', generation] as const
}

export function useRuntimeInstallationId() {
  const generation = useHarnessSessionEpoch()
  const client = useQueryClient()
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client])
  const snapshot = useCallback(() => client.getQueryData<RuntimeIdentity>(runtimeIdentityKey(generation))?.installationId,
    [client, generation])
  // Installation ownership must update before batched query observer notifications.
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useRuntimeIdentityQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: runtimeIdentityKey(sessionGeneration()),
    retry: (_failureCount, error) => ApiError.is(error)
      && (error.code === 'NETWORK_ERROR' || error.status >= 500),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
    enabled: !sessionIsSwitching(), staleTime: 0, refetchInterval: 60_000,
    queryFn: ({ signal }) => apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal }) })
}
