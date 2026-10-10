import { dirname } from 'node:path'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { ProviderAccountResolver, ResolvedProviderAccount } from '../provider-accounts/service.js'
import { DomainError } from '../errors.js'
import { providerAccountEnvironment } from '../provider-accounts/environment.js'
import type { HostHarnessOverrideService } from './instanceSettings/service.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { resolveRuntimeProviderAccount } from './providerAccountRuntime.js'

export class ProviderAccountConfigurationService {
  private profiles?: Pick<HostHarnessOverrideService, 'selectionForConfiguration' | 'prepareOperatorConfiguration'>
  constructor(private readonly accounts: ProviderAccountResolver) {}

  bindProfiles(profiles: Pick<HostHarnessOverrideService, 'selectionForConfiguration' | 'prepareOperatorConfiguration'>): void {
    this.profiles = profiles
  }

  async profile(input: { principal: ManagementPrincipal; source: 'http' | 'mcp'; configuration: HarnessConfiguration;
    selection?: HarnessProfileSelection | undefined; commandId: string; client: pg.PoolClient; check?: boolean }): Promise<HarnessProfileSelection | undefined> {
    if (input.configuration.harness !== 'claude' || !input.configuration.accountId) return input.selection
    if (!this.profiles) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE',
      'Managed Claude accounts require local harness profile setup.', 503)
    const selected = await this.profiles.selectionForConfiguration(input.principal, input.configuration, input.client)
    if (selected) return selected
    if (input.check) return this.profiles.prepareOperatorConfiguration(input.principal, input.source,
      input.configuration, input.commandId)
    throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
      'Save and check a local harness profile for this Claude account before saving the Agent.', 409)
  }

  async resolve(configuration: HarnessConfiguration, selection?: HarnessProfileSelection,
    options?: { sql: GraphSqlClient }): Promise<HarnessConfiguration> {
    if (configuration.harness === 'opencode') return configuration
    const account = await this.accounts.resolve(configuration.harness, configuration.accountId, options)
    if (!account) return configuration
    if (selection?.target.hostRef.kind === 'device') {
      throw new DomainError('PROVIDER_ACCOUNT_LOCAL_ONLY',
        'Managed provider accounts can run only on the computer where they were added.', 409)
    }
    if (configuration.harness === 'claude') {
      return { ...configuration, accountId: account.accountId,
        configDirectory: account.homePath, authMode: account.authMode }
    }
    return { ...configuration, accountId: account.accountId }
  }
}

export function harnessSessionChanged(left: HarnessConfiguration, right: HarnessConfiguration): boolean {
  if (left.harness !== right.harness) return true
  if (left.harness === 'opencode' || right.harness === 'opencode') return false
  return left.accountId !== right.accountId
}

/** A managed account cannot inherit provider authentication or provider routing from the API process. */
export function managedProviderEnvironment(source: NodeJS.ProcessEnv, account: ResolvedProviderAccount,
  provider: 'codex' | 'claude'): NodeJS.ProcessEnv {
  const environment = { ...source }
  for (const key of Object.keys(environment)) {
    if (/^(?:OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|AZURE_|VERTEX_|BEDROCK_)/.test(key)) {
      delete environment[key]
    }
  }
  const selected = providerAccountEnvironment(provider, account.homePath, dirname(account.homePath), environment)
  if (provider === 'claude') {
    if (account.authMode === 'api-key') {
      if (!account.apiKey) throw new DomainError('CLAUDE_API_KEY_REQUIRED', 'The selected account has no API key.', 409)
      selected.ANTHROPIC_API_KEY = account.apiKey
    }
  }
  return selected
}

export function pinnedCodexAccountEnvironment(accounts: ProviderAccountResolver | undefined, accountId: string | undefined,
  recovery?: NativeProcessRecovery, sourceRecovery?: NativeProcessRecovery) {
  let selected: ResolvedProviderAccount | null | undefined
  let pending: Promise<void> | undefined
  return {
    prepare(): Promise<void> {
      pending ??= Promise.resolve().then(async () => {
        selected = await resolveRuntimeProviderAccount(accounts, 'codex', accountId, recovery, sourceRecovery)
      })
      return pending
    },
    environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      if (selected === undefined) throw new DomainError('PROVIDER_ACCOUNT_NOT_RESOLVED',
        'Resolve the selected account before starting the harness.', 500)
      return selected ? managedProviderEnvironment(source, selected, 'codex') : source
    },
  }
}
