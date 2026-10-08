import { useQuery } from '@tanstack/react-query'
import { ComputerAccountsListSchema, type ComputerAccountsList } from '@foreman-code/contracts/computer-accounts'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useComputerAccounts() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['computer-accounts', sessionGeneration()], enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 60_000, staleTime: 30_000,
    queryFn: async ({ signal }): Promise<ComputerAccountsList> => {
      const computers: ComputerAccountsList['computers'] = []
      let cursor: string | undefined
      do {
        const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
        const page = await apiClient.request(`/api/management/computers/accounts${query}`,
          ComputerAccountsListSchema, { signal })
        computers.push(...page.computers)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { computers }
    } })
}
