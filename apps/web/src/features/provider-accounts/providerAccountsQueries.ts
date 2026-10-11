import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AccountProvider, ProviderAccount, ProviderAccountBinding, ProviderAccountCreateInput, ProviderAccountRenameInput,
  ProviderAccountCommandInput, ProviderAccountsSnapshot, ProviderAccountAuthenticationOperation,
} from '@foreman-code/contracts/provider-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { settingsExperienceKeys } from '../../shared/api/settingsExperience'
import { useRuntimeInstallationId } from '../../shared/api/runtimeIdentity'
import {
  providerAccountsClient, type ProviderAccountAction, type ProviderAccountDefaultInput,
  type ProviderAccountPrepareInput, type ProviderAccountCancelInput,
} from './providerAccountsClient'

export type ProviderAccountScope = { provider?: AccountProvider; target?: DeviceProvisioningTarget }
export const providerAccountsKey = (scope: ProviderAccountScope = {}) =>
  ['provider-accounts', sessionGeneration(), scope.target ?? null, scope.provider ?? null] as const
export const providerAccountKey = (binding: ProviderAccountBinding | undefined) =>
  [...providerAccountsKey(binding ? { target: binding.target, provider: binding.provider } : {}),
    'account', binding?.accountId ?? null, binding?.profileRef ?? null, binding?.bindingRevision ?? null,
    binding?.subject?.subject ?? null, binding?.subject?.qualificationId ?? null] as const
export const providerAuthenticationKey = (binding: ProviderAccountBinding | undefined, operationId?: string) =>
  [...providerAccountKey(binding), 'authentication', operationId ?? null] as const

function mainTarget(installationId: string): DeviceProvisioningTarget {
  return { hostRef: { kind: 'main', mainId: installationId }, applicationInstallationId: installationId,
    keyRevision: null, authorizationRevision: null }
}
export function useProviderAccountScope(scope: ProviderAccountScope = {}): ProviderAccountScope {
  const installationId = useRuntimeInstallationId()
  if (scope.target || !installationId) return scope
  return { ...scope, target: mainTarget(installationId) }
}
function assertAccountScope(account: ProviderAccount, scope: ProviderAccountScope) {
  const observationMismatch = account.binding && account.observation
    && account.binding.bindingRevision !== account.observation.bindingRevision
  if (observationMismatch || scope.provider && account.provider !== scope.provider
    || scope.target && account.binding && !sameDeviceProvisioningTarget(account.binding.target, scope.target)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Account readback belongs to another computer or harness.' })
  }
}
function assertBinding(actual: ProviderAccountBinding | undefined, binding: ProviderAccountBinding) {
  if (!actual || actual.accountId !== binding.accountId || actual.provider !== binding.provider
    || !sameDeviceProvisioningTarget(actual.target, binding.target)
    || actual.bindingRevision !== binding.bindingRevision || actual.profileRef !== binding.profileRef
    || actual.subject?.subject !== binding.subject?.subject
    || actual.subject?.qualificationId !== binding.subject?.qualificationId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The saved account binding is unavailable.' })
  }
}
function newerAccount(previous: ProviderAccount | undefined, next: ProviderAccount): ProviderAccount {
  if (!previous || previous.binding?.bindingRevision !== next.binding?.bindingRevision) return next
  const metadata = previous.revision > next.revision ? previous : next
  const old = previous.observation
  const incoming = next.observation
  const oldIsNewer = old && (!incoming || old.generation > incoming.generation
    || old.generation === incoming.generation && old.sequence >= incoming.sequence)
  const observation = oldIsNewer ? old : incoming
  if (!observation) return metadata
  return { ...metadata, status: observation.status, identity: observation.identity, observation }
}
function newerSnapshot(previous: ProviderAccountsSnapshot | undefined, next: ProviderAccountsSnapshot) {
  const metadata = previous && previous.revision > next.revision ? previous : next
  return { ...metadata, accounts: metadata.accounts.map(account => newerAccount(
    previous?.accounts.find(item => item.id === account.id),
    next.accounts.find(item => item.id === account.id) ?? account)) }
}
function newerOperation(previous: ProviderAccountAuthenticationOperation | undefined,
  next: ProviderAccountAuthenticationOperation) {
  if (previous && (previous.generation > next.generation
    || previous.generation === next.generation && previous.revision > next.revision)) return previous
  return next
}

export function useProviderAccounts(enabled = true, requestedScope: ProviderAccountScope = {}) {
  const generation = useHarnessSessionEpoch()
  const scope = useProviderAccountScope(requestedScope)
  return useQuery({
    queryKey: providerAccountsKey(scope), retry: false, enabled: enabled && !sessionIsSwitching(),
    refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      let snapshot: ProviderAccountsSnapshot
      if (scope.provider) {
        const page = await providerAccountsClient.page({ provider: scope.provider, limit: 100 }, { signal })
        if (page.nextCursor) throw new Error('The account list is incomplete. Refresh accounts before making changes.')
        snapshot = { revision: page.revision, accounts: page.accounts, defaults: page.defaults }
      } else snapshot = await providerAccountsClient.list({ signal })
      assertSession(generation)
      for (const account of snapshot.accounts) assertAccountScope(account, scope)
      return snapshot
    },
    structuralSharing: (previous, incoming) =>
      newerSnapshot(previous as ProviderAccountsSnapshot | undefined, incoming as ProviderAccountsSnapshot),
  })
}
export function useProviderAccountDetails(accountId: string | undefined, requestedScope: ProviderAccountScope = {}) {
  const generation = useHarnessSessionEpoch()
  const scope = useProviderAccountScope(requestedScope)
  return useQuery({ queryKey: [...providerAccountsKey(scope), 'detail', accountId ?? null],
    enabled: Boolean(accountId) && !sessionIsSwitching(), retry: false, refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const account = await providerAccountsClient.get(accountId!, { signal })
      assertSession(generation)
      assertAccountScope(account, scope)
      if (account.id !== accountId) throw new Error('Account readback belongs to another selection.')
      return account
    },
    structuralSharing: (previous, incoming) => newerAccount(previous as ProviderAccount | undefined, incoming as ProviderAccount),
  })
}
export function useProviderAccount(binding?: ProviderAccountBinding) {
  const generation = useHarnessSessionEpoch()
  return useQuery({ queryKey: providerAccountKey(binding), enabled: Boolean(binding) && !sessionIsSwitching(),
    retry: false, refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const account = await providerAccountsClient.get(binding!.accountId, { signal })
      assertSession(generation)
      assertBinding(account.binding, binding!)
      return account
    },
    structuralSharing: (previous, incoming) => newerAccount(previous as ProviderAccount | undefined, incoming as ProviderAccount),
  })
}
export function useProviderAccountModels(binding?: ProviderAccountBinding, observationGeneration?: number) {
  const generation = useHarnessSessionEpoch()
  return useQuery({ queryKey: [...providerAccountKey(binding), 'models', observationGeneration ?? null],
    enabled: Boolean(binding) && !sessionIsSwitching(), retry: false, refetchOnReconnect: 'always',
    queryFn: async ({ signal }) => {
      const result = await providerAccountsClient.models(binding!.accountId, { signal })
      assertSession(generation)
      assertBinding(result.binding, binding!)
      if (observationGeneration !== undefined && result.generation !== observationGeneration) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Model observation belongs to another computer connection.' })
      }
      return result
    },
    structuralSharing: (previous, incoming) => {
      const old = previous as Awaited<ReturnType<typeof providerAccountsClient.models>> | undefined
      const next = incoming as NonNullable<typeof old>
      return old && (old.generation > next.generation
        || old.generation === next.generation && old.observedAt > next.observedAt) ? old : next
    },
  })
}
export function useProviderAuthentication(binding?: ProviderAccountBinding, operationId?: string) {
  const generation = useHarnessSessionEpoch()
  return useQuery({ queryKey: providerAuthenticationKey(binding, operationId),
    enabled: Boolean(binding && operationId) && !sessionIsSwitching(), retry: false,
    refetchOnReconnect: 'always',
    refetchInterval: query => query.state.data?.nativeClosed || query.state.error ? false : 3_000,
    queryFn: async ({ signal }) => {
      const operation = await providerAccountsClient.authentication({ operationId: operationId!, target: binding!.target }, { signal })
      assertSession(generation)
      assertBinding(operation.binding, binding!)
      if (operation.id !== operationId) throw new Error('Authentication readback belongs to another operation.')
      return operation
    },
    structuralSharing: (previous, incoming) => newerOperation(previous as ProviderAccountAuthenticationOperation | undefined,
      incoming as ProviderAccountAuthenticationOperation),
  })
}

/** API keys stay in the form's memory, outside query and mutation variables. */
export type ProviderAccountWrite =
  | { action: 'create'; input: ProviderAccountCreateInput }
  | { action: 'rename'; accountId: string; input: ProviderAccountRenameInput }
  | { action: ProviderAccountAction | 'api-key'; accountId: string;
      input: ProviderAccountCommandInput | ProviderAccountDefaultInput }

export function useProviderAccountWrite(readApiKey?: () => string, requestedScope: ProviderAccountScope = {}) {
  const client = useQueryClient()
  const generation = useHarnessSessionEpoch()
  const scope = useProviderAccountScope(requestedScope)
  const key = providerAccountsKey(scope)
  return useMutation({ mutationKey: [...key, 'write'], retry: false,
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
      const value = { ...result.value, accounts: result.value.accounts.filter(account =>
        !scope.provider || account.provider === scope.provider) }
      for (const account of value.accounts) assertAccountScope(account, scope)
      client.setQueryData<ProviderAccountsSnapshot>(key, previous => newerSnapshot(previous, value))
      return result
    },
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: ['provider-accounts', generation] }),
      client.invalidateQueries({ queryKey: settingsExperienceKeys.access() }),
    ]),
  })
}
export function useProviderAuthenticationWrite(binding?: ProviderAccountBinding) {
  const client = useQueryClient()
  const generation = useHarnessSessionEpoch()
  return useMutation({ mutationKey: [...providerAccountKey(binding), 'authentication-write'], retry: false,
    mutationFn: async (write: { action: 'prepare'; input: ProviderAccountPrepareInput }
      | { action: 'cancel'; input: ProviderAccountCancelInput }) => {
      assertSession(generation)
      if (!binding) throw new Error('The account binding is unavailable.')
      const result = write.action === 'prepare' ? await providerAccountsClient.prepare(binding.accountId, write.input)
        : await providerAccountsClient.cancel(write.input)
      assertSession(generation)
      assertBinding(result.value.binding, binding)
      client.setQueryData<ProviderAccountAuthenticationOperation>(providerAuthenticationKey(binding, result.value.id),
        previous => newerOperation(previous, result.value))
      return result.value
    },
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: ['provider-accounts', generation] }),
      client.invalidateQueries({ queryKey: settingsExperienceKeys.access() }),
    ]),
  })
}
