import { AgentDefaultsSchema, withAdvancedDefaults, CodexSessionCompatibilitySchema, validateHarnessWorkflowCompatibility, type AgentDefaults, type WorkflowDefaults } from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { isDeepStrictEqual } from 'node:util'

import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import type { HarnessCatalogService } from '../harnesses/catalog.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresFoundationSettingsRepository } from './foundation.js'
import type { PostgresOperatorRepository } from '../operators/postgres.js'

export class FoundationSettingsManagementService {
  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly harnesses?: Pick<HarnessCatalogService, 'qualifyConfiguration'>,
    private readonly operators?: PostgresOperatorRepository,
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
        const previous = await this.settings.getAgentDefaults(client)
        if (previous.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Agent defaults changed since they were read.', 409)
        for (const role of ['orchestrator', 'coder', 'operator'] as const) {
          const configuration = value[role].harness
          // Even unchanged legacy defaults must satisfy Operator chat's resumability boundary.
          // Validate before the unchanged-configuration shortcut or any persistent write.
          if (role === 'operator' && configuration.harness === 'codex') {
            CodexSessionCompatibilitySchema.parse({ configuration, requiresResume: true })
          }
          if (isDeepStrictEqual(withAdvancedDefaults(previous.value[role].harness), withAdvancedDefaults(configuration))) continue
          if (!this.harnesses) throw new DomainError('HARNESS_QUALIFICATION_UNAVAILABLE', 'Native qualification is unavailable; changed configurations were not saved.', 503)
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
        const operators = this.operators
        const operatorChanged = !isDeepStrictEqual(withAdvancedDefaults(previous.value.operator.harness), withAdvancedDefaults(value.operator.harness))
        const current = operatorChanged ? await operators?.ensureWithClient(client) : undefined
        const result = await this.settings.updateManagedAgentDefaults(client, value, input.expectedRevision)
        if (operators && current && !isDeepStrictEqual(current.configuration.harness, value.operator.harness)) {
          await operators.updateWithClient(
            client, value.operator.harness, current.operator.currentConfigurationVersionId,
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
