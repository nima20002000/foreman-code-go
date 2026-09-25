import { randomUUID } from 'node:crypto'

import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  type Agent,
  type AgentConfigurationVersion,
  type WorkflowDefinition,
} from '@graphql/contracts'
import type pg from 'pg'
import { SavedWorkflowDefinitionSchema as WorkflowDefinitionSchema, SavedWorkflowVersionSchema as WorkflowVersionSchema,
  WorkflowDefinitionV2Schema, CompatibleWorkflowVersionSchema, type SavedWorkflowDefinition, type SavedWorkflowVersion } from '@graphql/contracts/wave25'

import { DomainError } from '../errors.js'
import { lockAgentConfigurations, saveAgentConfiguration } from '../workspaces/agentConfiguration.js'
import type { WorkflowRepository } from './port.js'
import { readImmutableWorkflowVersion, readImmutableAgentConfiguration, readSavedWorkflowDefinition, IMMUTABLE_WORKFLOW_VERSION_COLUMNS,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow } from './immutableRead.js'
import { buildExecutableWorkflowVersion, buildExecutableWorkflowVersionV2 } from './executableVersion.js'

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(workspaceId: string): Promise<SavedWorkflowDefinition[]> {
    const result = await this.pool.query<{ id: string; workspace_id: string; record: unknown }>(
      'select id,workspace_id,record from workflows where workspace_id = $1 order by created_at, id',
      [workspaceId],
    )
    return result.rows.map((row) => readSavedWorkflowDefinition(row, { workspaceId }))
  }

  async get(workspaceId: string, workflowId: string): Promise<SavedWorkflowDefinition | undefined> {
    const result = await this.pool.query<{ id: string; workspace_id: string; record: unknown }>(
      'select id,workspace_id,record from workflows where workspace_id = $1 and id = $2',
      [workspaceId, workflowId],
    )
    return result.rows[0] ? readSavedWorkflowDefinition(result.rows[0], { workspaceId, workflowId }) : undefined
  }

  /** Existing engine-facing boundary remains v1/v2 until its owner wires v3. */
  async getVersion(workflowVersionId: string) {
    const version = await this.getSavedVersion(workflowVersionId)
    return version ? CompatibleWorkflowVersionSchema.parse(version) : undefined
  }

  async getSavedVersion(workflowVersionId: string): Promise<SavedWorkflowVersion | undefined> {
    const result = await this.pool.query<ImmutableWorkflowVersionRow>(
      `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id = $1`,
      [workflowVersionId],
    )
    return result.rows[0] ? readImmutableWorkflowVersion(result.rows[0], { id: workflowVersionId }) : undefined
  }

  async getCurrentVersion(workspaceId: string, workflowId: string) {
    const version = await this.getCurrentSavedVersion(workspaceId, workflowId)
    return version ? CompatibleWorkflowVersionSchema.parse(version) : undefined
  }

  async getCurrentSavedVersion(workspaceId: string, workflowId: string): Promise<SavedWorkflowVersion | undefined> {
    const result = await this.pool.query<ImmutableWorkflowVersionRow>(
      `select version.id,version.workspace_id,version.workflow_id,version.version,version.entry_node_id,
         version.execution_semantics_version,version.record
       from workflows workflow
       join workflow_versions version on version.id = workflow.current_version_id
         and version.workspace_id=workflow.workspace_id and version.workflow_id=workflow.id
       where workflow.workspace_id = $1 and workflow.id = $2`,
      [workspaceId, workflowId],
    )
    return result.rows[0] ? readImmutableWorkflowVersion(result.rows[0], { workspaceId, workflowId }) : undefined
  }

  async getAgentConfiguration(configurationVersionId: string): Promise<AgentConfigurationVersion | undefined> {
    const result = await this.pool.query<ImmutableAgentConfigurationRow>(
      'select id,workspace_id,agent_id,version,record from agent_configuration_versions where id = $1',
      [configurationVersionId],
    )
    return result.rows[0] ? readImmutableAgentConfiguration(result.rows[0], { id: configurationVersionId }) : undefined
  }

  async assertCurrentConfigurations(version: SavedWorkflowVersion): Promise<void> {
    const result = await this.pool.query<{ id: string; current_configuration_version_id: string | null }>(
      'select id, current_configuration_version_id from agents where workspace_id = $1 and id = any($2::text[])',
      [version.workspaceId, Object.keys(version.agentConfigurationVersionIds)],
    )
    if (result.rows.length !== Object.keys(version.agentConfigurationVersionIds).length
      || result.rows.some((row) => row.current_configuration_version_id !== version.agentConfigurationVersionIds[row.id])) {
      throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Agent settings changed. Save the workflow again before starting it.', 409)
    }
  }

  async insertVersion(workflowVersion: SavedWorkflowVersion): Promise<void> {
    const parsed = WorkflowVersionSchema.parse(workflowVersion)
    if ('executionSemanticsVersion' in parsed && parsed.executionSemanticsVersion === 3) {
      throw new DomainError('REPEAT_SAVE_ADMISSION_REQUIRED', 'Use the authenticated repeat publication service.', 409)
    }
    await this.pool.query(
      `insert into workflow_versions (id, workspace_id, workflow_id, version, entry_node_id, record, execution_semantics_version)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [parsed.id, parsed.workspaceId, parsed.workflowId, parsed.version, parsed.entryNodeId, JSON.stringify(parsed), 'executionSemanticsVersion' in parsed ? parsed.executionSemanticsVersion : 1],
    )
  }

  async save(
    workspaceId: string,
    input: WorkflowDefinition,
    suppliedAgents: readonly Agent[] = [],
  ): Promise<WorkflowDefinition> {
    const definition = WorkflowDefinitionSchema.parse(input)
    if ('executionSemanticsVersion' in definition && definition.executionSemanticsVersion === 3) {
      throw new DomainError('REPEAT_SAVE_ADMISSION_REQUIRED', 'Use the authenticated repeat publication service.', 409)
    }
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
      const existing = await client.query<{ workspace_id: string; record: unknown }>(
        'select workspace_id, record from workflows where id = $1 for update', [input.id],
      )
      if (existing.rows[0] && existing.rows[0].workspace_id !== workspaceId) {
        throw new DomainError('WORKFLOW_WORKSPACE_MISMATCH', 'This workflow ID belongs to another workspace.', 409)
      }

      if (existing.rows[0]) {
        const previous = WorkflowDefinitionSchema.parse(existing.rows[0].record)
        if ('executionSemanticsVersion' in previous && previous.executionSemanticsVersion === 3) {
          throw new DomainError('REPEAT_SAVE_ADMISSION_REQUIRED', 'A repeat workflow cannot be downgraded through legacy save.', 409)
        }
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
      const acceptedRows = await client.query<{ record: unknown }>(
        'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[])',
        [workspaceId, Object.values(configurations)],
      )
      const acceptedConfigurations = acceptedRows.rows.map((row) => AgentConfigurationVersionSchema.parse(row.record))
      const selectedOrchestrator = acceptedConfigurations.find((configuration) => configuration.productRole === 'orchestrator')

      const versionResult = await client.query<{ next_version: number }>(
        'select coalesce(max(version), 0) + 1 as next_version from workflow_versions where workflow_id = $1',
        [input.id],
      )
      const version = Number(versionResult.rows[0]?.next_version ?? 1)
      const now = new Date().toISOString()
      const buildInput = {
        id: `${input.id}-v${version}-${randomUUID()}`,
        definition: input, version, configurations: acceptedConfigurations, createdAt: now,
        previousDefinition: existing.rows[0] ? WorkflowDefinitionSchema.parse(existing.rows[0].record) : undefined,
        initialApproval: !existing.rows[0] && selectedOrchestrator
          ? { handler: 'orchestrator' as const, designatedOrchestratorAgentId: selectedOrchestrator.agentId } : undefined,
      }
      const workflowVersion = 'executionSemanticsVersion' in input && input.executionSemanticsVersion === 2
        ? buildExecutableWorkflowVersionV2({ ...buildInput, definition: WorkflowDefinitionV2Schema.parse(input) })
        : buildExecutableWorkflowVersion(buildInput)
      const definition = workflowVersion.definition

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
        `insert into workflow_versions (id, workspace_id, workflow_id, version, entry_node_id, record, execution_semantics_version)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [workflowVersion.id, workspaceId, input.id, version, workflowVersion.entryNodeId, JSON.stringify(workflowVersion), 'executionSemanticsVersion' in workflowVersion ? 2 : 1],
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
