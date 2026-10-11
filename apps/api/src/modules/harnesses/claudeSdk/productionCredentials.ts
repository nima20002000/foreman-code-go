import type { HarnessConfiguration } from '@foreman-code/contracts'
import { DomainError } from '../../errors.js'
import type { ProviderAccountResolver } from '../../provider-accounts/service.js'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'

export function requireClaudeApiKey(configuration: HarnessConfiguration, apiKey?: string): string | undefined {
  if (configuration.harness !== 'claude' || configuration.authMode !== 'api-key') return undefined
  if (!apiKey?.trim()) throw new DomainError('CLAUDE_API_KEY_DELIVERY_UNAVAILABLE',
    'Select a managed Claude account with a locally provisioned API key before running this profile.', 409)
  return apiKey
}

/** Secrets are resolved locally after the immutable account configuration is checked. */
export async function requireClaudeProductionCredentialDelivery(configuration: HarnessConfiguration,
  accounts?: ProviderAccountResolver, host?: CanonicalMachineReference): Promise<string | undefined> {
  if (configuration.harness === 'opencode') return undefined
  if (host?.kind === 'device') {
    if (configuration.accountId) throw new DomainError('PROVIDER_ACCOUNT_LOCAL_ONLY',
      'Managed provider accounts can run only on the computer where they were added.', 409)
    requireClaudeApiKey(configuration)
    return undefined
  }
  const account = configuration.accountId ? await accounts?.resolve(configuration.harness, configuration.accountId) : null
  if (configuration.accountId && !account) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
    'The selected managed provider account is unavailable.', 409)
  if (configuration.harness === 'claude' && account
    && (account.accountId !== configuration.accountId || account.homePath !== configuration.configDirectory
      || account.authMode !== configuration.authMode)) {
    throw new DomainError('PROVIDER_ACCOUNT_CONFIGURATION_CONFLICT',
      'Save the selected account settings before running this Claude profile.', 409)
  }
  if (configuration.harness === 'claude' && configuration.authMode === 'api-key') {
    return requireClaudeApiKey(configuration,
      configuration.accountId && account?.authMode === 'api-key' ? account.apiKey : undefined)
  }
  return undefined
}
