import { AgentDefaultsSchema, CodexSessionCompatibilitySchema, validateHarnessWorkflowCompatibility, type AgentDefaults, type WorkflowDefaults } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { HarnessCatalogService } from '../harnesses/catalog.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from './foundation.js'

export class FoundationSettingsManagementService {
  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly harnesses?: Pick<HarnessCatalogService, 'qualifyConfiguration'>,
  ) {}

  getAgentDefaults(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getAgentDefaults()
  }

  getWorkflowDefaults(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    return this.settings.getWorkflowDefaults()
  }

  updateAgentDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    commandId: string; expectedRevision: number; value: AgentDefaults
  }) {
    requireAuthorization(principal, 'settings:update')
    return this.commands.execute({
      principal, source, operation: 'agent.defaults.update', commandId: input.commandId,
      targetKey: 'agent-defaults-v1', payload: input,
      perform: async (client) => {
        const value = AgentDefaultsSchema.parse(input.value)
        if (!this.harnesses) throw new DomainError('HARNESS_QUALIFICATION_UNAVAILABLE', 'Native provider qualification is not configured; these defaults were not saved.', 503)
        for (const role of ['orchestrator', 'coder', 'operator'] as const) {
          const configuration = value[role].harness
          if (role !== 'operator') {
            validateHarnessWorkflowCompatibility(configuration, 'user')
            if (configuration.harness === 'codex') CodexSessionCompatibilitySchema.parse({ configuration, requiresResume: true })
          }
          if (configuration.harness === 'opencode' && configuration.autoApprove) {
            throw new DomainError('OPENCODE_SERVER_AUTO_CONFLICT', 'Native auto approval is not supported by the managed OpenCode server; choose routed review.', 409)
          }
          try { await this.harnesses.qualifyConfiguration(configuration) } catch (error) {
            throw new DomainError('AGENT_DEFAULTS_UNQUALIFIED', `The ${role} template was not saved: ${error instanceof Error ? error.message : 'Native qualification failed.'}`, 409)
          }
        }
        return this.settings.updateManagedAgentDefaults(client, value, input.expectedRevision)
      },
    })
  }

  updateWorkflowDefaults(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    commandId: string; expectedRevision: number; value: WorkflowDefaults
  }) {
    requireAuthorization(principal, 'settings:update')
    return this.commands.execute({
      principal, source, operation: 'workflow.defaults.update', commandId: input.commandId,
      targetKey: 'workflow-defaults-v1', payload: input,
      perform: (client) => this.settings.updateManagedWorkflowDefaults(client, input.value, input.expectedRevision),
    })
  }
}
