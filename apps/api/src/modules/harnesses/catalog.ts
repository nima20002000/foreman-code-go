import { isDeepStrictEqual } from 'node:util'
import { canonical } from './codexProtocol.js'
import { QualificationCache } from './qualificationCache.js'
import { qualificationError } from './qualificationErrors.js'

import { HarnessDefaultsSchema, HarnessQualificationSchema, withAdvancedDefaults, type HarnessConfiguration, type AgentHarness, type HarnessDefaults } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSettingsRepository } from '../settings/postgres.js'
import type { HarnessConfigurationQualifier } from './port.js'
import { DomainError } from '../errors.js'
import { ClaudeSetupOptionsSchema } from '@foreman-code/contracts/claude'

export class HarnessCatalogService {
  private readonly checks = new QualificationCache<{ qualification: ReturnType<typeof HarnessQualificationSchema.parse>; checkedAt: string }>()
  invalidateChecks(): void { this.checks.clear() }
  async shutdownChecks(): Promise<void> { await this.checks.close() }

  /** Run once after native runtime ownership is acquired. No model turn is created. */
  async warmup(): Promise<void> {
    const managed = await this.settings.getManagedHarnessDefaults()
    const unavailable = new Set(managed.unavailable ?? [])
    await Promise.allSettled((['codex', 'opencode', 'claude'] as const).flatMap((harness) =>
      managed.defaults[harness] && !unavailable.has(harness) ? [this.qualifyConfiguration(managed.defaults[harness]!)] : []))
  }

  private async inspectConfiguration(value: HarnessConfiguration) {
    try {
      return await this.checks.get(canonical(withAdvancedDefaults(value)), async () => {
        const qualification = HarnessQualificationSchema.parse(await this.qualifier.qualify(value, this.qualificationDirectory, AbortSignal.timeout(60_000)))
        if (!qualification.ready || !qualification.authenticated || qualification.harness !== value.harness) {
          throw new DomainError('HARNESS_DEFAULTS_UNQUALIFIED', 'Sign in to the native harness and check this selection again.', 409)
        }
        return { qualification, checkedAt: new Date().toISOString() }
      })
    } catch (error) { throw qualificationError(error) }
  }

  constructor(
    private readonly qualifier: HarnessConfigurationQualifier,
    private readonly settings: PostgresSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly qualificationDirectory: string,
    private readonly appMcpEndpoint?: string,
  ) {}

  claudeSetupOptions(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'harnesses:read')
    return ClaudeSetupOptionsSchema.parse({ graphqlMcp: this.appMcpEndpoint ? { type: 'http', url: this.appMcpEndpoint } : null })
  }

  async list(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'harnesses:read')
    const managed = await this.settings.getManagedHarnessDefaults()
    const unavailable = new Set(managed.unavailable ?? [])
    return Promise.all((['codex', 'opencode', 'claude'] as const).filter((harness) => managed.defaults[harness] !== undefined)
      .map((harness) => this.describe(principal, harness, managed.defaults, managed.revision, unavailable)))
  }

  async get(principal: ManagementPrincipal, harness: AgentHarness) {
    requireAuthorization(principal, 'harnesses:read')
    const managed = await this.settings.getManagedHarnessDefaults()
    const unavailable = new Set(managed.unavailable ?? [])
    return this.describe(principal, harness, managed.defaults, managed.revision, unavailable)
  }

  /** Native model/variant/Agent qualification shared by every defaults writer. No turn is started. */
  async qualifyConfiguration(value: HarnessConfiguration) {
    return (await this.inspectConfiguration(value)).qualification
  }

  async checkConfiguration(principal: ManagementPrincipal, configuration: HarnessConfiguration) {
    requireAuthorization(principal, 'harnesses:read')
    return { configuration, ...await this.inspectConfiguration(configuration) }
  }

  private async describe(principal: ManagementPrincipal, harness: AgentHarness, defaults: HarnessDefaults, revision: number,
    unavailable: ReadonlySet<AgentHarness>) {
    requireAuthorization(principal, 'harnesses:read')
    const configuration = defaults[harness]
    if (!configuration) throw new DomainError('HARNESS_PROFILE_REQUIRED', 'Save a Claude preset with an actual host-local profile, model, authentication and sandbox choice in Claude settings. Installation alone does not create this app configuration.', 409)
    if (unavailable.has(harness)) {
      return { harness, defaults: configuration, defaultsRevision: revision, capability: null,
        discoveryError: { code: 'HARNESS_MODEL_DEFAULT_UNAVAILABLE',
          message: 'No default model is configured. Choose a native model in Settings.' } }
    }
    try {
      const capability = await this.qualifyConfiguration(configuration)
      return { harness, defaults: configuration, defaultsRevision: revision, capability, discoveryError: null }
    } catch (error) {
      return {
        harness, defaults: configuration, defaultsRevision: revision, capability: null,
        discoveryError: { code: error instanceof DomainError ? error.code : 'HARNESS_DISCOVERY_UNAVAILABLE', message: error instanceof Error ? error.message : 'Harness discovery failed.' },
      }
    }
  }

  async updateDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    commandId: string; expectedRevision: number; defaults: HarnessDefaults; configure?: AgentHarness[] | undefined
  }) {
    requireAuthorization(principal, 'harnesses:update')
    const defaults = HarnessDefaultsSchema.parse(input.defaults)
    return this.commands.execute({
      principal, source, operation: 'harness.defaults.update', commandId: input.commandId,
      targetKey: 'harness-defaults', payload: input,
      perform: async (client) => {
        const current = await this.settings.getManagedHarnessDefaults(client)
        const unavailable = new Set(current.unavailable ?? [])
        const configure = new Set(input.configure ?? [])
        if (current.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409)
        for (const harness of ['codex', 'opencode', 'claude'] as const) {
          const next = defaults[harness], previous = current.defaults[harness]
          if (!next && configure.has(harness)) throw new DomainError('HARNESS_PROFILE_REQUIRED',
            'Choose a complete preset before selecting its default.', 409)
          if (!next || (previous && !configure.has(harness)
            && isDeepStrictEqual(withAdvancedDefaults(previous), withAdvancedDefaults(next)))) continue
          // Claude presets are configuration templates, like unqualified host
          // overrides. Exact-host proof is required separately at admission;
          // the model-free defaults checker cannot produce that native proof.
          if (harness !== 'claude') await this.qualifyConfiguration(next)
          unavailable.delete(harness)
        }
        return this.settings.updateManagedHarnessDefaults(client, defaults, input.expectedRevision,
          { unavailable: [...unavailable].sort() })
      },
    })
  }
}
