import { useQueries, type QueryFunctionContext } from '@tanstack/react-query'
import { ComputerAccountsListSchema, ComputerAccountsReadInputSchema } from '@foreman-code/contracts/computer-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { ApiError, apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useComputerAccounts(targets: readonly DeviceProvisioningTarget[]) {
  useHarnessSessionEpoch()
  return useQueries({ queries: targets.map(target => ({
    queryKey: ['computer-accounts', sessionGeneration(), target], enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 60_000, staleTime: 30_000,
    queryFn: async ({ signal }: QueryFunctionContext) => {
      const result = await apiClient.request('/api/management/computers/accounts/read',
        ComputerAccountsListSchema, { method: 'POST', body: ComputerAccountsReadInputSchema.parse({ target }), signal })
      if (result.computers.length !== 1 || !sameDeviceProvisioningTarget(result.computers[0]!.target, target)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Accounts belong to another computer installation.' })
      }
      return result.computers[0]!.accounts
    },
  })) })
}
