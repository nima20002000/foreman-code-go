import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'
import type { AccountProvider } from '@foreman-code/contracts/provider-accounts'
import type { ProviderAccountResolver, ResolvedProviderAccount } from '../provider-accounts/service.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { readRecord, recordObject, writeRecord } from './recovery/storage.js'
import { DomainError } from '../errors.js'

function pinnedAccount(value: unknown, provider: AccountProvider, owner: string): string | null {
  const record = recordObject(value)
  if (record.format !== 1 || record.provider !== provider || record.owner !== owner
    || record.accountId !== null && !ProviderAccountIdSchema.safeParse(record.accountId).success) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_INVALID', 'The saved runtime account selection is invalid.', 409)
  }
  return record.accountId as string | null
}

function bindingPath(provider: AccountProvider, recovery: NativeProcessRecovery): string {
  const registryRoot = resolve(recovery.root)
  const key = createHash('sha256').update(JSON.stringify([registryRoot, provider, recovery.owner])).digest('hex')
  return join(dirname(registryRoot), 'provider-account-bindings', `${key}.json`)
}

async function selectedAccount(accounts: ProviderAccountResolver, provider: AccountProvider,
  accountId: string): Promise<ResolvedProviderAccount> {
  const account = await accounts.resolve(provider, accountId)
  if (!account || account.accountId !== accountId) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
    'The saved provider account is unavailable.', 409)
  return account
}

/** Runtime recovery stores identity only, independently of immutable workflow and run records. */
export async function resolveRuntimeProviderAccount(accounts: ProviderAccountResolver | undefined,
  provider: AccountProvider, accountId?: string, recovery?: NativeProcessRecovery,
  sourceRecovery?: NativeProcessRecovery): Promise<ResolvedProviderAccount | null> {
  if (accountId && !accounts) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
    'Managed provider account execution is unavailable.', 503)
  if (accountId) return selectedAccount(accounts!, provider, accountId)
  if (!recovery) return accounts ? accounts.resolve(provider) : null
  const path = bindingPath(provider, recovery)
  const stored = readRecord(path)
  if (stored !== undefined) {
    const selected = pinnedAccount(stored, provider, recovery.owner)
    if (selected === null) return null
    if (!accounts) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The saved provider account is unavailable.', 503)
    return selectedAccount(accounts, provider, selected)
  }
  const source = sourceRecovery ? readRecord(bindingPath(provider, sourceRecovery)) : undefined
  let sourceId: string | null | undefined
  if (sourceRecovery) sourceId = source === undefined ? null : pinnedAccount(source, provider, sourceRecovery.owner)
  if (sourceId && !accounts) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
    'The source session provider account is unavailable.', 503)
  if (!accounts) return null
  let selected: ResolvedProviderAccount | null = null
  if (sourceId !== null) {
    selected = sourceId ? await selectedAccount(accounts, provider, sourceId) : await accounts.resolve(provider)
  }
  try {
    writeRecord(path, { format: 1, provider, owner: recovery.owner, accountId: selected?.accountId ?? null }, true)
    return selected
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const accepted = pinnedAccount(readRecord(path), provider, recovery.owner)
    return accepted === null ? null : selectedAccount(accounts, provider, accepted)
  }
}
