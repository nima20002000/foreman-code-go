import { useMutation, useQuery, useQueryClient, useQueries, type QueryFunctionContext } from '@tanstack/react-query'
import { BuildComputerStatusSchema, BuildComputerUpdateSchema, BuildComputerBatchUpdateSchema, BuildComputerBatchResultSchema,
  type BuildComputerUpdate, type BuildComputerBatchUpdate, type BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { useBuildComputerCommand } from './buildComputerCommands'

export const buildComputerKeys = {
  root: ['build-computers'] as const,
  computer: (target: DeviceProvisioningTarget, generation = sessionGeneration()) => ['build-computers', generation, target] as const,
}
function verifyTarget(value: import('@foreman-code/contracts/build-computers').BuildComputerStatus, target: DeviceProvisioningTarget) {
  if (!sameDeviceProvisioningTarget(value.preference.target, target)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Build settings belong to another computer installation.' })
  }
  return value
}
export function buildComputerQuery(target: DeviceProvisioningTarget) {
  const generation = sessionGeneration()
  return { queryKey: buildComputerKeys.computer(target), enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 5_000,
    queryFn: async ({ signal }: QueryFunctionContext) => {
      assertSession(generation)
      const result = await apiClient.request('/api/management/settings/build-computers/read',
        BuildComputerStatusSchema, { method: 'POST', body: { target }, signal })
      assertSession(generation)
      return verifyTarget(result, target)
    } }
}
function optimisticStatus(status: BuildComputerStatus | undefined, pending: BuildComputerBatchUpdate | undefined) {
  if (!status) return status
  const change = pending?.updates.find(input => sameDeviceProvisioningTarget(input.target, status.preference.target))
  if (!change) return status
  return { ...status, preference: { ...status.preference, buildEnabled: change.buildEnabled,
    buildPriority: change.buildPriority, buildRole: change.buildRole ?? status.preference.buildRole,
    buildAllowancePercent: change.buildAllowancePercent ?? status.preference.buildAllowancePercent } }
}
export function useBuildComputer(target: DeviceProvisioningTarget) {
  useHarnessSessionEpoch()
  const command = useBuildComputerCommand(target.hostRef.mainId)
  return useQuery({ ...buildComputerQuery(target), refetchInterval: command.pending ? false : 5_000,
    refetchOnWindowFocus: !command.pending, select: status => optimisticStatus(status, command.pending)! })
}
export function useBuildComputers(targets: readonly DeviceProvisioningTarget[]) {
  useHarnessSessionEpoch()
  const command = useBuildComputerCommand(targets[0]!.hostRef.mainId)
  return useQueries({ queries: targets.map(target => ({ ...buildComputerQuery(target),
    refetchInterval: command.pending ? false as const : 5_000, refetchOnWindowFocus: !command.pending,
    select: (status: BuildComputerStatus) => optimisticStatus(status, command.pending)! })) })
}
export async function updateBuildComputers(input: BuildComputerBatchUpdate, generation: number) {
  assertSession(generation)
  const result = await apiClient.request('/api/management/settings/build-computers/batch-update',
    BuildComputerBatchResultSchema, { method: 'POST', body: BuildComputerBatchUpdateSchema.parse(input) })
  assertSession(generation)
  if (result.computers.length !== input.updates.length) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Could not verify every saved computer.' })
  }
  result.computers.forEach((status, index) => verifyTarget(status, input.updates[index]!.target))
  return result.computers
}
export async function updateBuildComputer(input: BuildComputerUpdate, generation = sessionGeneration()) {
  assertSession(generation)
  const result = await apiClient.request('/api/management/settings/build-computers/update',
    BuildComputerStatusSchema, { method: 'POST', body: BuildComputerUpdateSchema.parse(input) })
  assertSession(generation)
  return verifyTarget(result, input.target)
}
export function useUpdateBuildComputer() {
  const cache = useQueryClient()
  const save = useMutation({ retry: false,
    mutationFn: ({ input, generation }: { input: BuildComputerUpdate; generation: number }) => updateBuildComputer(input, generation),
    onSuccess: async (value, { generation }) => {
      if (generation !== sessionGeneration()) return
      cache.setQueryData(buildComputerKeys.computer(value.preference.target, generation), value)
      await cache.invalidateQueries({ queryKey: ['build-computers', generation] })
    },
    onError: (error, { generation }) => {
      if (generation === sessionGeneration() && error instanceof ApiError && error.status === 409) {
        void cache.invalidateQueries({ queryKey: ['build-computers', generation] })
      }
    },
  })
  return { ...save,
    mutate: (input: BuildComputerUpdate) => save.mutate({ input, generation: sessionGeneration() }),
    mutateAsync: (input: BuildComputerUpdate) => save.mutateAsync({ input, generation: sessionGeneration() }),
  }
}
