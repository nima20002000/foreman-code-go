import { createHash, randomUUID } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  WorkflowDefinitionSchema,
  WorkflowVersionSchema,
  validateHarnessWorkflowCompatibility,
  type Agent,
  type AgentConfigurationVersion,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import { validateExecutableTopology } from '../runs/topology.js'
import { lockAgentConfigurations, saveAgentConfiguration } from '../workspaces/agentConfiguration.js'
import type { WorkflowRepository } from './port.js'
import { validateWorkflowApproval } from './approval.js'

function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(workspaceId: string): Promise<WorkflowDefinition[]> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from workflows where workspace_id = $1 order by created_at, id',
      [workspaceId],
    )
    return result.rows.map((row) => WorkflowDefinitionSchema.parse(row.record))
  }

  async get(workspaceId: string, workflowId: string): Promise<WorkflowDefinition | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from workflows where workspace_id = $1 and id = $2',
      [workspaceId, workflowId],
    )
    return result.rows[0] ? WorkflowDefinitionSchema.parse(result.rows[0].record) : undefined
  }

  async getVersion(workflowVersionId: string): Promise<WorkflowVersion | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from workflow_versions where id = $1',
      [workflowVersionId],
    )
    return result.rows[0] ? WorkflowVersionSchema.parse(result.rows[0].record) : undefined
  }

  async getCurrentVersion(workspaceId: string, workflowId: string): Promise<WorkflowVersion | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      `select version.record
       from workflows workflow
       join workflow_versions version on version.id = workflow.current_version_id
       where workflow.workspace_id = $1 and workflow.id = $2`,
      [workspaceId, workflowId],
    )
    return result.rows[0] ? WorkflowVersionSchema.parse(result.rows[0].record) : undefined
  }

  async getAgentConfiguration(configurationVersionId: string): Promise<AgentConfigurationVersion | undefined> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where id = $1',
      [configurationVersionId],
    )
    return result.rows[0] ? AgentConfigurationVersionSchema.parse(result.rows[0].record) : undefined
  }

  async assertCurrentConfigurations(version: WorkflowVersion): Promise<void> {
    const result = await this.pool.query<{ id: string; current_configuration_version_id: string | null }>(
      'select id, current_configuration_version_id from agents where workspace_id = $1 and id = any($2::text[])',
      [version.workspaceId, Object.keys(version.agentConfigurationVersionIds)],
    )
    if (result.rows.length !== Object.keys(version.agentConfigurationVersionIds).length
      || result.rows.some((row) => row.current_configuration_version_id !== version.agentConfigurationVersionIds[row.id])) {
      throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Agent settings changed. Save the workflow again before starting it.', 409)
    }
  }

  async insertVersion(workflowVersion: WorkflowVersion): Promise<void> {
    const parsed = WorkflowVersionSchema.parse(workflowVersion)
    await this.pool.query(
      `insert into workflow_versions (id, workspace_id, workflow_id, version, entry_node_id, record)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [parsed.id, parsed.workspaceId, parsed.workflowId, parsed.version, parsed.entryNodeId, JSON.stringify(parsed)],
    )
  }

  async save(
    workspaceId: string,
    input: WorkflowDefinition,
    suppliedAgents: readonly Agent[] = [],
  ): Promise<WorkflowDefinition> {
    if (input.workspaceId !== workspaceId) {
      throw new DomainError('INVALID_WORKFLOW', 'The workflow does not belong to this workspace.', 400)
    }
    const entryNode = input.nodes[0]
    if (!entryNode) {
      throw new DomainError(
        'WORKFLOW_HAS_NO_ENTRY_POINT',
        'Add at least one Agent before saving an executable workflow.',
        400,
      )
    }
    if (input.executionPolicy && input.executionPolicy.maxNodeExecutions < input.nodes.length) {
      throw new DomainError('WORKFLOW_EXECUTION_LIMIT', `This graph has ${input.nodes.length} steps but its execution limit is ${input.executionPolicy.maxNodeExecutions}. Review the execution limit before saving.`, 409)
    }

    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workflow:${input.id}`])
      const existing = await client.query<{ workspace_id: string }>(
        'select workspace_id from workflows where id = $1 for update', [input.id],
      )
      if (existing.rows[0] && existing.rows[0].workspace_id !== workspaceId) {
        throw new DomainError('WORKFLOW_WORKSPACE_MISMATCH', 'This workflow ID belongs to another workspace.', 409)
      }

      const workspace = await client.query('select id from workspaces where id = $1', [workspaceId])
      if (!workspace.rows[0]) {
        throw new DomainError('WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' was not found.`, 404)
      }

      const uniqueAgentIds = [...new Set(input.nodes.map((node) => node.agentId))].sort()
      const suppliedById = new Map(suppliedAgents.map((agent) => [agent.id, AgentSchema.parse(agent)]))
      // Lock reads as well as writes in a stable order: two boards may update
      // different agents while pinning both of their configurations.
      await lockAgentConfigurations(client, uniqueAgentIds)
      for (const agentId of uniqueAgentIds) {
        const supplied = suppliedById.get(agentId)
        if (supplied) await saveAgentConfiguration(client, workspaceId, supplied)
      }
      const agentRows = await client.query<{ id: string; current_configuration_version_id: string | null }>(
        `select id, current_configuration_version_id
         from agents where workspace_id = $1 and id = any($2::text[]) for share`,
        [workspaceId, uniqueAgentIds],
      )
      const configurations = Object.fromEntries(
        agentRows.rows
          .filter((row): row is { id: string; current_configuration_version_id: string } => Boolean(row.current_configuration_version_id))
          .map((row) => [row.id, row.current_configuration_version_id]),
      )
      const missingAgentIds = uniqueAgentIds.filter((agentId) => !configurations[agentId])
      if (missingAgentIds.length > 0) {
        throw new DomainError(
          'AGENT_CONFIGURATION_UNAVAILABLE',
          'Every workflow Agent requires a persisted configuration version.',
          409,
          { agentIds: missingAgentIds },
        )
      }
      const authorityRows = await client.query<{ record: unknown }>(
        'select record from agents where workspace_id=$1 and id=any($2::text[])', [workspaceId, uniqueAgentIds],
      )
      const authorityAgents = authorityRows.rows.map((row) => AgentSchema.parse(row.record))
      const selectedOrchestrator = authorityAgents.find((agent) => agent.productRole === 'orchestrator')
      const approval = input.approval ?? (!existing.rows[0] && selectedOrchestrator
        ? { handler: 'orchestrator' as const, designatedOrchestratorAgentId: selectedOrchestrator.id }
        : undefined)
      const acceptedApproval = approval ? validateWorkflowApproval(input, approval, authorityAgents) : undefined
      if (acceptedApproval) {
        const acceptedConfigurations = await client.query<{ record: unknown }>(
          'select record from agent_configuration_versions where id=any($1::text[])', [Object.values(configurations)],
        )
        for (const row of acceptedConfigurations.rows) {
          validateHarnessWorkflowCompatibility(AgentConfigurationVersionSchema.parse(row.record).harness, acceptedApproval.handler)
        }
      }

      const versionResult = await client.query<{ next_version: number }>(
        'select coalesce(max(version), 0) + 1 as next_version from workflow_versions where workflow_id = $1',
        [input.id],
      )
      const version = Number(versionResult.rows[0]?.next_version ?? 1)
      const now = new Date().toISOString()
      const definition = WorkflowDefinitionSchema.parse({
        ...input,
        ...(acceptedApproval ? { approval: acceptedApproval } : {}),
        version,
        // Ordinary editor connections mean an all-input dependency, not an
        // implicit threshold/any join. Explicit unsupported modes remain errors.
        nodes: input.nodes.map((node) => ({
          ...node,
          ...(input.edges.filter((edge) => edge.target === node.id).length > 1 && !node.join
            ? { join: { mode: 'all' } } : {}),
        })),
        edges: input.edges.map((edge) => ({
          ...edge,
          route: edge.route ?? { outcomes: ['succeeded'] },
        })),
        executionPolicy: input.executionPolicy ?? {
          maxParallelism: Math.max(1, input.nodes.length),
          maxNodeExecutions: input.nodes.length,
        },
        createdAt: input.createdAt ?? now,
        updatedAt: now,
      })
      const workflowVersion = WorkflowVersionSchema.parse({
        id: `${input.id}-v${version}-${randomUUID()}`,
        workspaceId,
        workflowId: input.id,
        version,
        entryNodeId: entryNode.id,
        definition,
        agentConfigurationVersionIds: configurations,
        ...(acceptedApproval ? { approval: acceptedApproval } : {}),
        contentHash: contentHash({ definition, configurations, entryNodeId: entryNode.id }),
        createdAt: now,
      })
      validateExecutableTopology(workflowVersion)

      const saved = await client.query(
        `insert into workflows (id, workspace_id, current_version_id, record)
         values ($1, $2, $3, $4::jsonb)
         on conflict (id) do update set
           current_version_id = excluded.current_version_id,
           record = excluded.record
         where workflows.workspace_id = excluded.workspace_id
         returning id`,
        [input.id, workspaceId, workflowVersion.id, JSON.stringify(definition)],
      )
      if (saved.rowCount !== 1) {
        throw new DomainError('WORKFLOW_WORKSPACE_MISMATCH', 'The scoped workflow could not be updated.', 409)
      }
      await client.query(
        `insert into workflow_versions (id, workspace_id, workflow_id, version, entry_node_id, record)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [workflowVersion.id, workspaceId, input.id, version, entryNode.id, JSON.stringify(workflowVersion)],
      )
      await client.query('commit')
      return definition
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}
