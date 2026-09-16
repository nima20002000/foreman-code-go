import type { AgentDefaults, WorkflowDefaults } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'

import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from './foundation.js'

export class FoundationSettingsManagementService {
  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
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
      perform: (client) => this.settings.updateManagedAgentDefaults(client, input.value, input.expectedRevision),
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
