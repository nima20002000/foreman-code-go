import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ProviderAccountCreateInput, ProviderAccountRenameInput,
  ProviderAccountCommandInput, ProviderAccountsSnapshot,
} from '@foreman-code/contracts/provider-accounts'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { providerAccountsClient, type ProviderAccountAction } from './providerAccountsClient'

export const providerAccountsKey = () => ['provider-accounts', sessionGeneration()] as const

export function useProviderAccounts(enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({
    queryKey: providerAccountsKey(), retry: false, enabled: enabled && !sessionIsSwitching(),
    queryFn: ({ signal }) => providerAccountsClient.list({ signal }),
    structuralSharing: (previous: unknown, incoming: unknown) => {
      const old = previous as ProviderAccountsSnapshot | undefined
      const next = incoming as ProviderAccountsSnapshot
      return old && old.revision > next.revision ? old : next
    },
  })
}

/** API keys stay in the form's memory, outside query and mutation variables. */
export type ProviderAccountWrite =
  | { action: 'create'; input: ProviderAccountCreateInput }
  | { action: 'rename'; accountId: string; input: ProviderAccountRenameInput }
  | { action: ProviderAccountAction | 'api-key'; accountId: string; input: ProviderAccountCommandInput }

export function useProviderAccountWrite(readApiKey?: () => string) {
  const client = useQueryClient()
  const generation = useHarnessSessionEpoch()
  const key = providerAccountsKey()
  return useMutation({
    mutationKey: [...key, 'write'], retry: false,
    mutationFn: async (write: ProviderAccountWrite) => {
      assertSession(generation)
      await client.cancelQueries({ queryKey: key, exact: true })
      let result
      if (write.action === 'create') result = await providerAccountsClient.create(write.input)
      else if (write.action === 'rename') result = await providerAccountsClient.rename(write.accountId, write.input)
      else if (write.action === 'api-key') {
        result = await providerAccountsClient.apiKey(write.accountId, { ...write.input, apiKey: readApiKey?.() ?? '' })
      } else result = await providerAccountsClient.action(write.accountId, write.action, write.input)
      assertSession(generation)
      client.setQueryData<ProviderAccountsSnapshot>(key, previous =>
        previous && previous.revision > result.value.revision ? previous : result.value)
      return result
    },
    onSettled: () => client.invalidateQueries({ queryKey: key, exact: true }),
  })
}
