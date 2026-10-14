import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import {
  HarnessConfigurationSchema, HarnessQualificationSchema, type AgentHarness, type HarnessConfiguration,
} from '@foreman-code/contracts'
import { HarnessOptionsResultSchema } from '@foreman-code/contracts/management'
import { QualificationCache } from './qualificationCache.js'
import { qualificationError } from './qualificationErrors.js'
import { NativeHarnessFactories } from './runtimeFactory.js'
import { harnessSettingSupport } from './operatorOptions.js'
import { HarnessExecutionError } from './errors.js'
import { DomainError } from '../errors.js'
import { claudeSettingSupport, type ClaudeNativeConfigurationPort } from './claudeSdk/nativeConfiguration.js'
import { requireClaudeProductionCredentialDelivery } from './claudeSdk/productionCredentials.js'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'

export class NativeConfigurationService {
  private readonly catalogCache = new QualificationCache<ReturnType<typeof HarnessOptionsResultSchema.parse>>(300_000, 128, Date.now, true)
  private readonly configurationChecks = new QualificationCache<Awaited<ReturnType<NativeConfigurationService['inspectConfiguration']>>>()
  invalidateOptions(): void { this.catalogCache.clear(); this.configurationChecks.clear(); this.claude?.invalidate?.() }
  async shutdownChecks(): Promise<void> { await Promise.all([this.catalogCache.close(), this.configurationChecks.close()]) }
  private readonly factories: NativeHarnessFactories
  constructor(codexBinary: string, private readonly directory: string, factories?: NativeHarnessFactories,
    private readonly claude?: ClaudeNativeConfigurationPort & {
      discoverAccount?(directory: string, signal: AbortSignal, binding: ProviderAccountBinding):
        ReturnType<ClaudeNativeConfigurationPort['discover']>
    }, private readonly accounts?: ProviderAccountResolver) {
    this.factories = factories ?? new NativeHarnessFactories({ codexBinary })
  }

  async qualifyConfiguration(input: HarnessConfiguration) {
    const value = HarnessConfigurationSchema.parse(input)
    if (value.harness === 'opencode') throw new DomainError('HARNESS_RETIRED',
      RETIRED_OPENCODE_MESSAGE, 409)
    try {
      // The selected Claude host/profile proof must be rechecked on every read.
      if (value.harness === 'claude') return await this.inspectConfiguration(value)
      const identity = await this.factories.cacheIdentity(value.harness, this.directory, value)
      const qualification = await this.configurationChecks.get(JSON.stringify([identity, value]), () => this.inspectConfiguration(value))
      if (identity !== await this.factories.cacheIdentity(value.harness, this.directory, value)) throw new DomainError(
        'PROVIDER_OBSERVATION_STALE', 'The account installation changed during qualification.', 409)
      return qualification
    }
    catch (error) { throw qualificationError(error) }
  }

  private async inspectConfiguration(value: HarnessConfiguration) {
    const signal = AbortSignal.timeout(60_000)
    if (value.harness === 'claude') {
      await requireClaudeProductionCredentialDelivery(value, this.accounts)
      const qualification = HarnessQualificationSchema.parse(await this.claudePort().qualify(value, this.directory, signal))
      if (qualification.harness !== 'claude') throw new DomainError('CLAUDE_QUALIFICATION_MISMATCH', 'The selected Claude profile returned another harness.', 503)
      return qualification
    }
    return this.factories.qualifyConfiguration(value, this.directory, signal)
  }

  private claudePort(): ClaudeNativeConfigurationPort {
    if (!this.claude) throw new DomainError('CLAUDE_PROFILE_SELECTION_REQUIRED', 'Claude metadata requires an explicitly selected current host profile and discovery provider.', 409)
    return this.claude
  }

  async options(harness: AgentHarness, accountBinding?: ProviderAccountBinding) {
    try {
      if (accountBinding && accountBinding.provider !== harness) throw new DomainError(
        'PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The requested catalog names another harness.', 409)
      if (harness === 'claude') return await this.discoverOptions(harness, accountBinding)
      const identity = await this.factories.cacheIdentity(harness, this.directory, undefined, accountBinding)
      const value = await this.catalogCache.get(JSON.stringify([harness, identity, accountBinding]),
        () => this.discoverOptions(harness, accountBinding))
      if (identity !== await this.factories.cacheIdentity(harness, this.directory, undefined, accountBinding)) {
        throw new DomainError('PROVIDER_OBSERVATION_STALE', 'The account installation changed during discovery.', 409)
      }
      return value
    }
    catch (error) {
      logIgnoredError('harness', `discover ${harness} native options`, error)
      throw qualificationError(error)
    }
  }

  async refreshOptions(harness: AgentHarness, refresh: 'catalog' | 'upstream' = 'catalog',
    accountBinding?: ProviderAccountBinding) {
    try {
      try {
        if (refresh === 'upstream') {
          if (harness === 'claude') throw new DomainError('CLAUDE_MODEL_REFRESH_UNSUPPORTED', 'Claude has no supported upstream model cache refresh operation.', 422)
          throw new HarnessExecutionError('CODEX_MODEL_REFRESH_UNSUPPORTED', 'Codex has no upstream catalog refresh command.')
        }
      } finally { this.invalidateOptions() }
      return await this.options(harness, accountBinding)
    } catch (error) { throw qualificationError(error) }
  }

  private async discoverOptions(harness: AgentHarness, accountBinding?: ProviderAccountBinding) {
    const signal = AbortSignal.timeout(60_000)
    if (harness === 'claude') {
      if (accountBinding && !this.claude?.discoverAccount) throw new DomainError(
        'PROVIDER_MODELS_UNAVAILABLE', 'Account-scoped Claude discovery is unavailable.', 409)
      const options = accountBinding
        ? await this.claude!.discoverAccount!(this.directory, signal, accountBinding)
        : await this.claudePort().discover(this.directory, signal)
      return HarnessOptionsResultSchema.parse({ harness, ...options, settings: claudeSettingSupport(),
        restrictions: ['Metadata comes from this API host’s installed SDK and the saved or detected local profile. Execution requires an exact qualified host profile.', 'Metadata discovery does not qualify execution or create a model turn.'], checkedAt: new Date().toISOString() })
    }
    const allocated = this.factories.allocate({ harness: 'codex', role: 'diagnostics',
      workingDirectory: this.directory, ownerAgentId: 'catalog-inspection', appMcpAccess: 'none',
      ...(accountBinding ? { accountBinding } : {}) })
    if (allocated.harness !== 'codex') throw new Error('The Codex driver returned another harness.')
    const manager = allocated.manager
    try {
      const options = await manager.discoverModels(this.directory, signal)
      return HarnessOptionsResultSchema.parse({ harness, ...options, authenticated: true, nativeAgents: [],
        settings: harnessSettingSupport(), restrictions: ['Global qualification directory; workspace MCP diagnostics are separate.', 'No native session or model turn was created.'], checkedAt: new Date().toISOString() })
    } finally { await this.factories.disposeAuxiliary(manager) }
  }
}
