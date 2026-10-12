import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ComputerSyncStatusSchema, ComputerSyncUpdateInputSchema,
  type ComputerSyncUpdateInput } from '@foreman-code/contracts/computer-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useComputerSync(target: DeviceProvisioningTarget) {
  useHarnessSessionEpoch()
  const generation = sessionGeneration()
  const queryKey = ['computer-sync', generation, target] as const
  const cache = useQueryClient()
  const status = useQuery({ queryKey, retry: false, refetchInterval: 10_000,
    enabled: !sessionIsSwitching(),
    queryFn: async ({ signal }) => {
      const result = await apiClient.request('/api/management/computers/sync/status', ComputerSyncStatusSchema,
        { method: 'POST', body: { target }, signal })
      if (!sameDeviceProvisioningTarget(result.target, target)) throw new Error('Sync status belongs to another computer.')
      return result
    },
  })
  const update = useMutation({
    mutationKey: [...queryKey, 'update'], retry: false,
    mutationFn: async (input: ComputerSyncUpdateInput) => {
      const result = await apiClient.request('/api/management/computers/sync/update', ComputerSyncStatusSchema,
        { method: 'POST', body: ComputerSyncUpdateInputSchema.parse(input) })
      if (!sameDeviceProvisioningTarget(result.target, target)) throw new Error('Sync result belongs to another computer.')
      return result
    },
    onSuccess: result => {
      if (sessionGeneration() !== generation) return
      cache.setQueryData(queryKey, result)
    },
  })
  const change = (workspaceId: string, enabled: boolean, expectedRevision: number) => {
    const input = { target, workspaceId, enabled, expectedRevision, commandId: crypto.randomUUID() }
    update.mutate(input)
  }
  const uncertain = update.isError && (!(update.error instanceof ApiError)
    || update.error.status === 0 || update.error.status >= 500)
  useEffect(() => {
    if (update.isError && !uncertain && status.isSuccess
      && status.dataUpdatedAt > update.submittedAt) update.reset()
  }, [update, uncertain, status.isSuccess, status.dataUpdatedAt])
  const refresh = async () => {
    const result = await status.refetch()
    if (!result.isError && update.isError && !uncertain) update.reset()
  }
  return { status, update, change, uncertain, refresh, retry: () => {
    if (update.variables) update.mutate(update.variables)
  } }
}
import { useEffect } from 'react'
