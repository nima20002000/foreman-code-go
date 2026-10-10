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
  invalidateOptions(): void { this.catalogCache.clear(); this.configurationChecks.clear(); this.identities.clear(); this.claude?.invalidate?.() }
  // Resolving the installed binary's identity costs over a second; settings reads reuse it briefly.
  private readonly identities = new Map<string, { at: number; value: Promise<string> }>()
  private identity(harness: 'codex'): Promise<string> {
    const known = this.identities.get(harness)
    if (known && Date.now() - known.at < 60_000) return known.value
    const value = this.factories.cacheIdentity(harness, this.directory)
    this.identities.set(harness, { at: Date.now(), value })
    void value.catch(() => { if (this.identities.get(harness)?.value === value) this.identities.delete(harness) })
    return value
  }
  async shutdownChecks(): Promise<void> { await Promise.all([this.catalogCache.close(), this.configurationChecks.close()]) }
  private readonly factories: NativeHarnessFactories
  constructor(codexBinary: string, private readonly directory: string, factories?: NativeHarnessFactories,
    private readonly claude?: ClaudeNativeConfigurationPort, private readonly accounts?: ProviderAccountResolver) {
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
      return await this.configurationChecks.get(JSON.stringify([identity, value]), () => this.inspectConfiguration(value))
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

  async options(harness: AgentHarness) {
    try {
      if (harness === 'claude') return await this.discoverOptions(harness)
      const identity = await this.identity(harness)
      return await this.catalogCache.get(JSON.stringify([harness, identity]), () => this.discoverOptions(harness))
    }
    catch (error) { throw qualificationError(error) }
  }

  async refreshOptions(harness: AgentHarness, refresh: 'catalog' | 'upstream' = 'catalog') {
    try {
      try {
        if (refresh === 'upstream') {
          if (harness === 'claude') throw new DomainError('CLAUDE_MODEL_REFRESH_UNSUPPORTED', 'Claude has no supported upstream model cache refresh operation.', 422)
          throw new HarnessExecutionError('CODEX_MODEL_REFRESH_UNSUPPORTED', 'Codex has no upstream catalog refresh command.')
        }
      } finally { this.invalidateOptions() }
      return await this.options(harness)
    } catch (error) { throw qualificationError(error) }
  }

  private async discoverOptions(harness: AgentHarness) {
    const signal = AbortSignal.timeout(60_000)
    if (harness === 'claude') {
      const options = await this.claudePort().discover(this.directory, signal)
      return HarnessOptionsResultSchema.parse({ harness, ...options, settings: claudeSettingSupport(),
        restrictions: ['Metadata comes from this API host’s installed SDK and the saved or detected local profile. Execution requires an exact qualified host profile.', 'Metadata discovery does not qualify execution or create a model turn.'], checkedAt: new Date().toISOString() })
    }
    const allocated = this.factories.allocate({ harness: 'codex', role: 'diagnostics',
      workingDirectory: this.directory, ownerAgentId: 'catalog-inspection', appMcpAccess: 'none' })
    if (allocated.harness !== 'codex') throw new Error('The Codex driver returned another harness.')
    const manager = allocated.manager
    try {
      const options = await manager.discoverModels(this.directory, signal)
      return HarnessOptionsResultSchema.parse({ harness, ...options, authenticated: true, nativeAgents: [],
        settings: harnessSettingSupport(), restrictions: ['Global qualification directory; workspace MCP diagnostics are separate.', 'No native session or model turn was created.'], checkedAt: new Date().toISOString() })
    } finally { await this.factories.disposeAuxiliary(manager) }
  }
}
