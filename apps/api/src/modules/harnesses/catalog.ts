import { HarnessQualificationSchema, type HarnessConfiguration, type AgentHarness, type HarnessDefaults } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSettingsRepository } from '../settings/postgres.js'
import type { HarnessConfigurationQualifier } from './port.js'
import { DomainError } from '../errors.js'

export class HarnessCatalogService {
  constructor(
    private readonly qualifier: HarnessConfigurationQualifier,
    private readonly settings: PostgresSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly qualificationDirectory: string,
  ) {}

  async list(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'harnesses:read')
    const managed = await this.settings.getManagedHarnessDefaults()
    return Promise.all((['codex', 'opencode'] as const).map((harness) => this.describe(principal, harness, managed.defaults, managed.revision)))
  }

  async get(principal: ManagementPrincipal, harness: AgentHarness) {
    requireAuthorization(principal, 'harnesses:read')
    const managed = await this.settings.getManagedHarnessDefaults()
    return this.describe(principal, harness, managed.defaults, managed.revision)
  }

  /** Native model/variant/Agent qualification shared by every defaults writer. No turn is started. */
  async qualifyConfiguration(value: HarnessConfiguration) {
    const result = HarnessQualificationSchema.parse(await this.qualifier.qualify(value, this.qualificationDirectory))
    if (!result.ready || !result.authenticated || result.harness !== value.harness) {
      throw new DomainError('HARNESS_DEFAULTS_UNQUALIFIED', 'The native provider did not qualify this configuration as ready and authenticated.', 409)
    }
    return result
  }

  async checkConfiguration(principal: ManagementPrincipal, configuration: HarnessConfiguration) {
    requireAuthorization(principal, 'harnesses:read')
    const qualification = await this.qualifyConfiguration(configuration)
    return { configuration, qualification, checkedAt: new Date().toISOString() }
  }

  private async describe(principal: ManagementPrincipal, harness: AgentHarness, defaults: HarnessDefaults, revision: number) {
    requireAuthorization(principal, 'harnesses:read')
    try {
      const capability = await this.qualifyConfiguration(defaults[harness])
      return { harness, defaults: defaults[harness], defaultsRevision: revision, capability, discoveryError: null }
    } catch (error) {
      return {
        harness, defaults: defaults[harness], defaultsRevision: revision, capability: null,
        discoveryError: { code: 'HARNESS_DISCOVERY_UNAVAILABLE', message: error instanceof Error ? error.message : 'Harness discovery failed.' },
      }
    }
  }

  async updateDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    commandId: string; expectedRevision: number; defaults: HarnessDefaults
  }) {
    requireAuthorization(principal, 'harnesses:update')
    return this.commands.execute({
      principal, source, operation: 'harness.defaults.update', commandId: input.commandId,
      targetKey: 'harness-defaults', payload: input,
      perform: async (client) => {
        // The coordinator checks the receipt before running external work.
        // This command replaces both templates, so new writes qualify both.
        const qualified = await Promise.all((['codex', 'opencode'] as const).map((harness) =>
          this.describe(principal, harness, input.defaults, input.expectedRevision)))
        const unavailable = qualified.find((entry) => entry.discoveryError)
        if (unavailable) {
          throw new DomainError(
            'HARNESS_DEFAULTS_UNQUALIFIED',
            `The ${unavailable.harness} defaults could not be qualified: ${unavailable.discoveryError?.message ?? 'unknown discovery error'}`,
            409,
          )
        }
        return this.settings.updateManagedHarnessDefaults(client, input.defaults, input.expectedRevision)
      },
    })
  }
}
