import { useQuery } from '@tanstack/react-query'
import { ComputerActivityListSchema } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { TELEMETRY_LIMITS, TelemetrySelectorResultSchema } from '@foreman-code/contracts/resource-telemetry'
import { apiClient, ApiError } from './client'
import { readResourceTelemetry } from './resourceTelemetry'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function computerKey(target: Pick<DeviceProvisioningTarget, 'hostRef'>) {
  const host = target.hostRef
  return `${host.mainId}:${host.kind === 'main' ? 'main' : host.deviceId}`
}
export function useComputerActivity() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['computer-activity', sessionGeneration()], enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => apiClient.request('/api/management/computers/activity', ComputerActivityListSchema, { signal }) })
}
export function useComputerUtilization(target: DeviceProvisioningTarget, online: boolean) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['computer-utilization', sessionGeneration(), target],
    enabled: online && !sessionIsSwitching(), retry: false, gcTime: 0, refetchInterval: TELEMETRY_LIMITS.intervalMs,
    queryFn: async ({ signal }) => {
      const resolved = await apiClient.request('/api/management/resource-telemetry/selector',
        TelemetrySelectorResultSchema, { method: 'POST', signal,
          body: { schemaVersion: 1, scope: 'computer', mainId: target.hostRef.mainId, hostRef: target.hostRef } })
      if (resolved.kind !== 'selector') return null
      const selector = resolved.selector
      if (selector.scope !== 'computer' || computerKey(selector.host) !== computerKey(target)
        || selector.host.applicationInstallationId !== target.applicationInstallationId
        || selector.host.keyRevision !== target.keyRevision
        || selector.host.authorizationRevision !== target.authorizationRevision) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Utilization belongs to another computer.' })
      }
      return readResourceTelemetry(selector, { signal })
    } })
}
