import { createHash, randomUUID } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  HarnessConfigurationSchema,
  WorkspaceDetailsResponseSchema,
  WorkspaceSchema,
  type Agent,
  type WorkspaceDetailsResponse,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'

export class PostgresWorkspaceRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    private readonly runs: PostgresRunRepository,
  ) {}

  async listAgents(workspaceId: string): Promise<Agent[]> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agents where workspace_id = $1 order by created_at, id',
      [workspaceId],
    )
    return result.rows.map((row) => AgentSchema.parse(row.record))
  }

  async getAgent(workspaceId: string, agentId: string): Promise<Agent | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agents where workspace_id = $1 and id = $2',
      [workspaceId, agentId],
    )
    return result.rows[0] ? AgentSchema.parse(result.rows[0].record) : undefined
  }

  async saveAgent(workspaceId: string, agentId: string, input: Agent): Promise<Agent> {
    if (input.id !== agentId) throw new DomainError('INVALID_AGENT', 'The agent ID does not match the requested agent.', 400)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const found = await client.query<{ record: unknown; current_configuration_version_id: string | null }>(
        'select record, current_configuration_version_id from agents where workspace_id = $1 and id = $2 for update',
        [workspaceId, agentId],
      )
      const row = found.rows[0]
      if (!row) throw new DomainError('AGENT_NOT_FOUND', `Agent '${agentId}' was not found.`, 404)
      const current = AgentSchema.parse(row.record)
      if (input.configurationVersionId !== row.current_configuration_version_id) {
        throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'These agent settings are out of date. Reload the agent before saving.', 409)
      }
      const previousRows = await client.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id = $1 and workspace_id = $2 and agent_id = $3',
        [row.current_configuration_version_id, workspaceId, agentId],
      )
      if (!previousRows.rows[0]) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'This agent has no persisted configuration to edit.', 409)
      const previous = AgentConfigurationVersionSchema.parse(previousRows.rows[0].record)
      const selectedHarness = input.harness ?? previous.harness.harness
      const harness = HarnessConfigurationSchema.parse(selectedHarness === 'codex' ? {
        harness: 'codex',
        model: input.model,
        reasoningEffort: input.effort,
        sandbox: previous.harness.harness === 'codex' ? previous.harness.sandbox : 'read-only',
        serviceTier: input.fastMode ? 'priority' : 'standard',
      } : {
        harness: 'opencode',
        model: input.model,
        variant: input.effort,
        nativeAgent: previous.harness.harness === 'opencode' ? previous.harness.nativeAgent : 'build',
        thinking: previous.harness.harness === 'opencode' ? previous.harness.thinking : false,
        autoApprove: previous.harness.harness === 'opencode' ? previous.harness.autoApprove : false,
      })
      const content = {
        prompt: input.prompt ?? previous.prompt,
        assignedSkills: input.assignedSkills ?? previous.assignedSkills,
        harness,
      }
      const now = new Date().toISOString()
      const configuration = AgentConfigurationVersionSchema.parse({
        ...content,
        id: `${agentId}-config-${randomUUID()}`,
        workspaceId,
        agentId,
        version: previous.version + 1,
        contentHash: `sha256:${createHash('sha256').update(JSON.stringify(content)).digest('hex')}`,
        createdAt: now,
      })
      // Operational state is server-owned; only editable settings are replaced.
      const agent = AgentSchema.parse({
        ...current,
        name: input.name,
        description: input.description,
        role: input.role,
        harness: harness.harness,
        model: harness.model,
        effort: harness.harness === 'codex' ? harness.reasoningEffort : harness.variant,
        fastMode: harness.harness === 'codex' ? harness.serviceTier === 'priority' : undefined,
        configurationVersionId: configuration.id,
        prompt: configuration.prompt,
        assignedSkills: configuration.assignedSkills,
        updatedAt: now,
      })
      await client.query(
        `insert into agent_configuration_versions (id, workspace_id, agent_id, version, record)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [configuration.id, workspaceId, agentId, configuration.version, JSON.stringify(configuration)],
      )
      await client.query(
        'update agents set current_configuration_version_id = $3, record = $4::jsonb where workspace_id = $1 and id = $2',
        [workspaceId, agentId, configuration.id, JSON.stringify(agent)],
      )
      await client.query('commit')
      return agent
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }

  async getDetails(workspaceId: string): Promise<WorkspaceDetailsResponse | undefined> {
    const result = await this.pool.query<{ record: unknown }>('select record from workspaces where id = $1', [workspaceId])
    if (!result.rows[0]) return undefined
    return WorkspaceDetailsResponseSchema.parse({
      workspace: WorkspaceSchema.parse(result.rows[0].record),
      agents: await this.listAgents(workspaceId),
      workflows: await this.workflows.list(workspaceId),
      runs: await this.runs.listSummaries(workspaceId),
      resources: [],
      runners: [{
        id: 'runner-local',
        name: 'Local Runner',
        health: { status: 'healthy', checkedAt: new Date().toISOString() },
      }],
    })
  }
}
