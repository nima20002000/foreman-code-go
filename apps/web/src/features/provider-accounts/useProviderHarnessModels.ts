import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { useNativeHarnessOptions } from '../../shared/api/harnessSettings'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { useProviderAccounts, useProviderAccountModels } from './providerAccountsQueries'

/** Account catalogs currently expose model names; optional model capabilities remain unknown. */
export function useProviderHarnessModels(harness: HarnessConfiguration['harness'], accountId?: string, remote = false) {
  const native = useNativeHarnessOptions(harness, !accountId && !remote)
  const accounts = useProviderAccounts(Boolean(accountId) && !remote)
  const denied = useProtectedAccessError(accounts)
  const account = !denied && !accounts.isError ? accounts.data?.accounts.find(value => value.id === accountId
    && value.provider === harness && !value.removedAt) : undefined
  const scoped = useProviderAccountModels(!remote ? account?.binding : undefined, account?.observation?.generation)
  const modelDenial = useProtectedAccessError(scoped)
  if (!accountId && !remote) return native
  const models: HarnessOptions['models'] = !modelDenial && !scoped.isError ? scoped.data?.models.map(model => ({
    ...model, reasoningEfforts: [], variants: [], serviceTiers: [],
  })) ?? [] : []
  const unsupported = remote || accounts.isSuccess && !account?.binding
  const error = denied ?? modelDenial ?? accounts.error ?? scoped.error
    ?? (unsupported ? new Error('Model discovery is unavailable for the selected account and computer.') : null)
  return { data: scoped.data && !modelDenial && !scoped.isError ? { models } : undefined,
    isSuccess: !remote && scoped.isSuccess && !modelDenial,
    isPending: !unsupported && (accounts.isPending || scoped.isPending),
    isError: Boolean(error), error, refetch: account?.binding ? scoped.refetch : accounts.refetch }
}
