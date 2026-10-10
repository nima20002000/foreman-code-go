import { useQuery } from '@tanstack/react-query'
import { ManagedRemoteExecutionSettingsSchema } from '@foreman-code/contracts/management'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useRemoteExecutionSettings() {
  useHarnessSessionEpoch()
  return useQuery({
    queryKey: ['workbench', 'remote-execution-settings', sessionGeneration()],
    enabled: !sessionIsSwitching(),
    refetchInterval: 5_000,
    retry: false,
    queryFn: ({ signal }) => apiClient.request(
      '/api/management/settings/remote-execution', ManagedRemoteExecutionSettingsSchema, { signal },
    ),
  })
}
