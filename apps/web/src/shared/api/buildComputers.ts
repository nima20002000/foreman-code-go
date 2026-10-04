import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BuildComputerStatusSchema, BuildComputerUpdateSchema, type BuildComputerUpdate } from '@foreman-code/contracts/build-computers'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const buildComputerKeys = {
  root: ['build-computers'] as const,
  computer: (target: DeviceProvisioningTarget) => ['build-computers', sessionGeneration(), target] as const,
}
function verifyTarget(value: import('@foreman-code/contracts/build-computers').BuildComputerStatus, target: DeviceProvisioningTarget) {
  if (!sameDeviceProvisioningTarget(value.preference.target, target)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Build settings belong to another computer installation.' })
  }
  return value
}
export function useBuildComputer(target: DeviceProvisioningTarget) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: buildComputerKeys.computer(target), enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }) => verifyTarget(await apiClient.request('/api/management/settings/build-computers/read',
      BuildComputerStatusSchema, { method: 'POST', body: { target }, signal }), target) })
}
export function useUpdateBuildComputer() {
  const cache = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: async (input: BuildComputerUpdate) => verifyTarget(await apiClient.request(
      '/api/management/settings/build-computers/update', BuildComputerStatusSchema,
      { method: 'POST', body: BuildComputerUpdateSchema.parse(input) }), input.target),
    onSuccess: async value => {
      cache.setQueryData(buildComputerKeys.computer(value.preference.target), value)
      await cache.invalidateQueries({ queryKey: buildComputerKeys.root })
    },
    onError: error => { if (error instanceof ApiError && error.status === 409) void cache.invalidateQueries({ queryKey: buildComputerKeys.root }) },
  })
}
