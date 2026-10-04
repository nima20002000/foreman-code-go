import { useQuery } from '@tanstack/react-query'
import { WorkerExecutionSettingsSchema } from '@foreman-code/contracts/management'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useWorkerExecutionSettings() {
  useHarnessSessionEpoch()
  return useQuery({
    queryKey: ['worker-execution-settings', sessionGeneration()],
    enabled: !sessionIsSwitching(),
    retry: false,
    queryFn: ({ signal }) => apiClient.request(
      '/api/management/settings/worker-execution',
      WorkerExecutionSettingsSchema,
      { signal },
    ),
  })
}
