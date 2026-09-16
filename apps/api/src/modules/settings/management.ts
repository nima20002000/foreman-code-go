import type { AgentDefaults, WorkflowDefaults } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { isDeepStrictEqual } from 'node:util'

import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from './foundation.js'
import type { PostgresOperatorRepository } from '../operators/postgres.js'

export class FoundationSettingsManagementService {
  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly operators: PostgresOperatorRepository,
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
        const current = await this.operators.ensureWithClient(client)
        const result = await this.settings.updateManagedAgentDefaults(client, input.value, input.expectedRevision)
        if (!isDeepStrictEqual(current.configuration.harness, input.value.operator.harness)) {
          await this.operators.updateWithClient(
            client, input.value.operator.harness, current.operator.currentConfigurationVersionId,
          )
        }
        return result
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
