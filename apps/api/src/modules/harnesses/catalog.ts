import { randomUUID } from 'node:crypto'

import { AgentConfigurationVersionSchema, type AgentHarness, type HarnessDefaults } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSettingsRepository } from '../settings/postgres.js'
import type { HarnessResolver } from './port.js'
import { DomainError } from '../errors.js'

export class HarnessCatalogService {
  constructor(
    private readonly resolver: HarnessResolver,
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

  private async describe(principal: ManagementPrincipal, harness: AgentHarness, defaults: HarnessDefaults, revision: number) {
    requireAuthorization(principal, 'harnesses:read')
    const now = new Date().toISOString()
    const configuration = AgentConfigurationVersionSchema.parse({
      id: `qualification-${randomUUID()}`, workspaceId: 'qualification', agentId: 'qualification',
      version: 1, prompt: {}, assignedSkills: [], harness: defaults[harness],
      contentHash: 'qualification', createdAt: now,
    })
    try {
      const capability = await this.resolver.resolve(harness).qualify({
        executionId: `qualification-${randomUUID()}`, runId: 'qualification', workspaceId: 'qualification',
        workflowNodeId: 'qualification', workingDirectory: this.qualificationDirectory,
        runtimeDirectory: this.qualificationDirectory,
        configuration, input: {},
      })
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
