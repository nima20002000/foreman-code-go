import { isDeepStrictEqual } from 'node:util'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import { AcceptedProviderAccountBindingSchema, type AcceptedProviderAccountBinding,
  type ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { ProviderAccountResolver } from './service.js'

export type AccountBindingOwner = 'run-node' | 'operator-command' | 'agent-conversation'

export function legacyProviderAccountBinding(configuration: HarnessConfiguration,
  selection?: HarnessProfileSelection): AcceptedProviderAccountBinding | undefined {
  if (configuration.harness === 'opencode') return undefined
  return { kind: 'legacy-profile', provider: configuration.harness, target: selection?.target.hostRef.kind === 'main' ? {
    hostRef: selection.target.hostRef, applicationInstallationId: selection.target.applicationInstallationId,
    keyRevision: null, authorizationRevision: null,
  } : null, profileRef: selection?.instanceId ?? null, historicalSubject: 'unknown',
  ...(configuration.accountId ? { accountId: configuration.accountId } : {}) }
}

export async function readProviderAccountBinding(sql: GraphSqlClient, kind: AccountBindingOwner,
  id: string): Promise<AcceptedProviderAccountBinding | undefined> {
  const row = (await sql.query<{ binding: unknown }>(
    'select binding from provider_account_accepted_bindings where owner_kind=$1 and owner_id=$2',
    [kind, id])).rows[0]
  return row ? AcceptedProviderAccountBindingSchema.parse(row.binding) : undefined
}

export async function saveProviderAccountBinding(sql: GraphSqlClient, kind: AccountBindingOwner,
  id: string, binding: AcceptedProviderAccountBinding): Promise<AcceptedProviderAccountBinding> {
  const parsed = AcceptedProviderAccountBindingSchema.parse(binding)
  await sql.query(`insert into provider_account_accepted_bindings(owner_kind,owner_id,binding,account_id)
    values($1,$2,$3::jsonb,$4) on conflict(owner_kind,owner_id) do nothing`,
  [kind, id, JSON.stringify(parsed), parsed.accountId ?? null])
  const stored = await readProviderAccountBinding(sql, kind, id)
  if (!isDeepStrictEqual(parsed, stored)) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work already uses another account/profile.', 409)
  }
  return parsed
}

export function assertAccountConfiguration(binding: ProviderAccountBinding, configuration: HarnessConfiguration,
  selection?: HarnessProfileSelection): void {
  if (binding.provider !== configuration.harness
    || ('accountId' in configuration && configuration.accountId && configuration.accountId !== binding.accountId)) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The saved configuration names another account.', 409)
  }
  if (selection && (selection.target.hostRef.mainId !== binding.target.hostRef.mainId
    || selection.target.hostRef.kind !== binding.target.hostRef.kind
    || selection.target.applicationInstallationId !== binding.target.applicationInstallationId
    || (selection.target.hostRef.kind === 'device' && binding.target.hostRef.kind === 'device'
      && selection.target.hostRef.deviceId !== binding.target.hostRef.deviceId))) {
    throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The account belongs to another installation.', 409)
  }
}

export class AcceptedProviderAccountBindings {
  constructor(private readonly accounts: ProviderAccountResolver) {}

  async prepare(configuration: HarnessConfiguration, selection?: HarnessProfileSelection) {
    if (configuration.harness === 'opencode') return undefined
    if (!configuration.accountId) return legacyProviderAccountBinding(configuration, selection)
    const selected = await this.accounts.resolve(configuration.harness, configuration.accountId, { allowDefault: false })
    if (!selected?.binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE',
      'The selected account has no qualified binding.', 409)
    if (selected.observation && selected.observation.status !== 'signed-in') {
      throw new DomainError('PROVIDER_ACCOUNT_SIGN_IN_REQUIRED', 'Sign in to the selected account before accepting work.', 409)
    }
    assertAccountConfiguration(selected.binding, configuration, selection)
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'device'
      && (!selection || configuration.authMode !== selected.authMode)) {
      throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED', 'Select the qualified Claude profile on the owning Worker.', 409)
    }
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'main'
      && (configuration.configDirectory !== selected.homePath
      || configuration.authMode !== selected.authMode)) throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED',
      'Select and qualify a Claude profile for this account before starting work.', 409)
    return selected.binding
  }

  async accept(sql: GraphSqlClient, kind: AccountBindingOwner, id: string,
    configuration: HarnessConfiguration, selection?: HarnessProfileSelection,
    options: { source?: AcceptedProviderAccountBinding | undefined;
      prepared?: AcceptedProviderAccountBinding | undefined } = {}): Promise<AcceptedProviderAccountBinding | undefined> {
    const { source, prepared } = options
    const prior = await readProviderAccountBinding(sql, kind, id)
    if (prior) return prior
    if (configuration.harness === 'opencode') return undefined
    if (source) {
      if (source.provider !== configuration.harness) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The source belongs to another provider.', 409)
      }
      if (source.kind === 'slot') {
        assertAccountConfiguration(source, configuration, selection)
        await this.accounts.resolve(configuration.harness, source.accountId, { sql, allowDefault: false,
          acceptedBinding: source })
      } else if (configuration.accountId && configuration.accountId !== source.accountId) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The source uses an original native profile.', 409)
      }
      return saveProviderAccountBinding(sql, kind, id, source)
    }
    if (!configuration.accountId) {
      return saveProviderAccountBinding(sql, kind, id, legacyProviderAccountBinding(configuration, selection)!)
    }
    const selected = await this.accounts.resolve(configuration.harness, configuration.accountId,
      { sql, allowDefault: false, ...(prepared ? { acceptedBinding: prepared } : {}) })
    if (!selected?.binding) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The selected account has no canonical binding.', 409)
    }
    assertAccountConfiguration(selected.binding, configuration, selection)
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'device'
      && (!selection || configuration.authMode !== selected.authMode)) {
      throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED', 'Select the qualified Claude profile on the owning Worker.', 409)
    }
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'main'
      && (configuration.configDirectory !== selected.homePath
      || configuration.authMode !== selected.authMode)) {
      throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED',
        'Select and qualify a Claude profile for this account before starting work.', 409)
    }
    return saveProviderAccountBinding(sql, kind, id, selected.binding)
  }
}
