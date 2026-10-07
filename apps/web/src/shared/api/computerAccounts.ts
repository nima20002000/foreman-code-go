import { useQuery } from '@tanstack/react-query'
import { ComputerAccountsListSchema } from '@foreman-code/contracts/computer-accounts'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useComputerAccounts() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['computer-accounts', sessionGeneration()], enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 60_000, staleTime: 30_000,
    queryFn: ({ signal }) => apiClient.request('/api/management/computers/accounts', ComputerAccountsListSchema, { signal }) })
}
