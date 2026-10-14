import { useQueries } from '@tanstack/react-query'
import { HarnessMcpListResultSchema } from '@foreman-code/contracts/management'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionIsSwitching } from './sessionBoundary'

export function useDeviceMcp(targets: DeviceProvisioningTarget[]) {
  const epoch = useHarnessSessionEpoch()
  return useQueries({ queries: targets.flatMap(target => (['codex', 'claude'] as const).map(harness => ({
    queryKey: ['workbench', 'management', 'device-mcp', epoch, target, harness] as const,
    enabled: target.hostRef.kind === 'device' && !sessionIsSwitching(), retry: false,
    refetchInterval: 30_000,
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const query = new URLSearchParams({ hostRef: JSON.stringify(target.hostRef) })
      return apiClient.request(`/api/management/harnesses/${harness}/mcp?${query}`, HarnessMcpListResultSchema, { signal })
    },
  }))) })
}
