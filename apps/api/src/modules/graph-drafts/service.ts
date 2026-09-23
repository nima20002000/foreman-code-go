import { randomUUID } from 'node:crypto'

import {
  AgentSchema,
  AgentConfigurationVersionSchema,
  projectHarnessEffort,
  type Agent,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@graphql/contracts'
import {
  GraphDraftOperationSchema,
  GraphDraftApplyInputSchema,
  GraphSaveInputSchema,
  ManagementHarnessConfigurationSchema,
  GraphValidationResultSchema,
  type GraphDraft,
  type GraphDraftOperation,
  type GraphDraftEffect,
  type ManagementPrincipal,
} from '@graphql/contracts/management'
import type pg from 'pg'

import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { GraphDraftApplyV2InputSchema, GraphDraftV2Schema, GraphSaveV2InputSchema, WorkflowVersionV2Schema, type GraphDraftOperationV2 } from '@graphql/contracts/wave25'
import { GraphDraftRecordSchema as GraphDraftSchema, WorkflowDefinitionRecordSchema as WorkflowDefinitionSchema,
  buildDraftVersion as buildExecutableWorkflowVersion, applyExecutionOperation, draftSemantics, draftEntry, promoteExecutionDefinition } from './executionOperations.js'
import { configurationInput, lockAgentConfigurations, saveAgentConfiguration } from '../workspaces/agentConfiguration.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import { normalizeHarnessDefaults } from '../settings/postgres.js'
import { readAgentForReuse } from '../workspaces/operatorAgents.js'
import { assertSourceAgentPins, restoreWorkflowDraft } from './operatorOperations.js'
import { applyApprovalOperation } from '../workflows/approvalOperations.js'
import { validateExecutableApprovalRoutes } from '../workflows/approval.js'

interface DraftRow { id: string; record: unknown; discarded_at: Date | null }
interface AgentRow { record: unknown; metadata_revision: string; current_configuration_version_id: string | null }

function replaceAgent(draft: GraphDraft, agent: Agent, baseRevision: number | null): GraphDraft {
  const stagedAgents = draft.stagedAgents.filter((item) => item.agent.id !== agent.id)
  stagedAgents.push({ agent, baseRevision })
  return GraphDraftSchema.parse({ ...draft, stagedAgents })
}

function nodeIndex(graph: WorkflowDefinition, nodeId: string): number {
  const index = graph.nodes.findIndex((node) => node.id === nodeId)
  if (index < 0) throw new DomainError('NODE_NOT_FOUND', `Node '${nodeId}' was not found in the draft.`, 404)
  return index
}

export class GraphDraftService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  private async lockActiveWorkflow(client: pg.PoolClient, workspaceId: string, workflowId: string) {
    await lockActiveWorkspace(client, workspaceId)
    const workflow = await client.query<{ record: unknown; current_version_id: string | null; archived_at: Date | null }>(
      'select record, current_version_id, archived_at from workflows where workspace_id = $1 and id = $2 for update',
      [workspaceId, workflowId],
    )
    const row = workflow.rows[0]
    if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
    if (row.archived_at) throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.', 409)
    return row
  }

  private referencedDraft(draft: GraphDraft): GraphDraft {
    const ids = new Set(draft.graph.nodes.map((node) => node.agentId))
    return GraphDraftSchema.parse({ ...draft, stagedAgents: draft.stagedAgents.filter((item) => ids.has(item.agent.id)), sourceAgentPins: draft.sourceAgentPins?.filter((item) => ids.has(item.agentId)) })
  }

  private readableDraft(principal: ManagementPrincipal, draft: GraphDraft): GraphDraft {
    const visible = this.referencedDraft(draft)
    if (visible.stagedAgents.length > 0) {
      requireAuthorization(principal, 'agents:read', { workspaceId: draft.workspaceId, workflowId: draft.workflowId })
    }
    return visible
  }

  private requireDraftAgent(draft: GraphDraft, agentId: string): void {
    if (!draft.graph.nodes.some((node) => node.agentId === agentId)) {
      throw new DomainError('AGENT_NOT_IN_DRAFT', 'The agent is not referenced by this draft.', 404)
    }
  }

  private requireConfigurationAuthorization(principal: ManagementPrincipal, draft: GraphDraft, agent: Agent): void {
    if (agent.assignedSkills?.length) requireAuthorization(principal, 'skills:read', {workspaceId: draft.workspaceId})
    if (agent.harnessConfiguration?.harness === 'codex' && agent.harnessConfiguration.sandbox === 'danger-full-access') {
      requireAuthorization(principal, 'harnesses:update', { workspaceId: draft.workspaceId, workflowId: draft.workflowId })
    }
  }

  private async authorizeAgentWrite(client: pg.PoolClient, principal: ManagementPrincipal, draft: GraphDraft, agentId: string): Promise<string[]> {
    this.requireDraftAgent(draft, agentId)
    requireAuthorization(principal, 'graph:edit', { workspaceId: draft.workspaceId, workflowId: draft.workflowId })
    const references = await client.query<{ id: string }>(
      `select id from workflows where workspace_id = $1 and exists (
        select 1 from jsonb_array_elements(record->'nodes') node where node->>'agentId' = $2
      ) order by id`, [draft.workspaceId, agentId],
    )
    for (const row of references.rows) {
      requireAuthorization(principal, 'graph:read', { workspaceId: draft.workspaceId, workflowId: row.id })
      requireAuthorization(principal, 'graph:edit', { workspaceId: draft.workspaceId, workflowId: row.id })
    }
    return references.rows.map((row) => row.id)
  }

  async open(principal: ManagementPrincipal, workspaceId: string, workflowId: string): Promise<GraphDraft> {
    requireAuthorization(principal, 'graph:read', { workspaceId, workflowId })
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const row = await this.lockActiveWorkflow(client, workspaceId, workflowId)
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`draft:${workflowId}`])
      const existing = await client.query<DraftRow>(
        'select id, record, discarded_at from graph_drafts where workspace_id = $1 and workflow_id = $2 for update',
        [workspaceId, workflowId],
      )
      if (existing.rows[0] && !existing.rows[0].discarded_at) {
        const draft = this.readableDraft(principal, GraphDraftSchema.parse(existing.rows[0].record))
        await client.query('commit')
        return draft
      }
      const draft = GraphDraftSchema.parse({
        id: `draft-${randomUUID()}`, workspaceId, workflowId, revision: 0,
        baseWorkflowVersionId: row.current_version_id,
        publishedRevision: row.current_version_id ? 0 : null,
        graph: WorkflowDefinitionSchema.parse(row.record), stagedAgents: [],
        updatedByPrincipalId: principal.id, updatedAt: new Date().toISOString(),
      })
      if (existing.rows[0]) {
        // A discarded draft is a finished instance, not an in-place graph edit.
        // Receipts/audit retain its ID as historical data, not as a draft FK.
        // Keep the workspace/workflow, advisory and row locks across replacement;
        // failure to insert rolls back the deletion as well. Same-instance writer
        // guards remain unchanged, including the prohibition on v2 downgrades.
        await client.query(
          `delete from graph_drafts where id = $1 and workspace_id = $2 and workflow_id = $3
             and discarded_at is not null`,
          [existing.rows[0].id, workspaceId, workflowId],
        )
      }
      if (draftSemantics(draft) === 2) {
        await client.query("select set_config('graphql.approval_writer','v2',true)")
      }
      await client.query(
        `insert into graph_drafts (id, workspace_id, workflow_id, revision, base_workflow_version_id, record)
         values ($1, $2, $3, 0, $4, $5::jsonb)`,
        [draft.id, workspaceId, workflowId, draft.baseWorkflowVersionId, JSON.stringify(draft)],
      )
      await client.query('commit')
      return draft
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
  }

  async get(principal: ManagementPrincipal, workspaceId: string, workflowId: string, draftId: string): Promise<GraphDraft> {
    requireAuthorization(principal, 'graph:read', { workspaceId, workflowId })
    const result = await this.pool.query<DraftRow>(
      `select id, record, discarded_at from graph_drafts
       where id = $1 and workspace_id = $2 and workflow_id = $3`, [draftId, workspaceId, workflowId],
    )
    if (!result.rows[0] || result.rows[0].discarded_at) throw new DomainError('GRAPH_DRAFT_NOT_FOUND', `Draft '${draftId}' is unavailable.`, 404)
    return this.readableDraft(principal, GraphDraftSchema.parse(result.rows[0].record))
  }

  private async loadAgent(client: pg.PoolClient, workspaceId: string, agentId: string): Promise<{ agent: Agent; revision: number }> {
    const result = await client.query<AgentRow>(
      `select record, metadata_revision, current_configuration_version_id from agents
       where workspace_id = $1 and id = $2 and archived_at is null for share`, [workspaceId, agentId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('AGENT_NOT_FOUND', `Agent '${agentId}' was not found.`, 404)
    let agent = AgentSchema.parse(row.record)
    if (row.current_configuration_version_id) {
      const saved = await client.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id = $1 and workspace_id = $2 and agent_id = $3',
        [row.current_configuration_version_id, workspaceId, agentId],
      )
      if (!saved.rows[0]) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'The saved agent configuration is unavailable.', 409)
      const configuration = AgentConfigurationVersionSchema.parse(saved.rows[0].record)
      const harness = configuration.harness
      agent = AgentSchema.parse({
        ...agent, productRole: configuration.productRole, configurationVersionId: configuration.id, harness: harness.harness,
        harnessConfiguration: harness, model: harness.model,
        effort: projectHarnessEffort(harness),
        fastMode: harness.harness === 'codex' ? harness.serviceTier === 'priority' : undefined,
        prompt: configuration.prompt, assignedSkills: configuration.assignedSkills,
      })
    }
    return { agent, revision: Number(row.metadata_revision) }
  }

  private async stageAgent(client: pg.PoolClient, draft: GraphDraft, agentId: string, principal: ManagementPrincipal) {
    this.requireDraftAgent(draft, agentId)
    requireAuthorization(principal, 'agents:read', { workspaceId: draft.workspaceId, workflowId: draft.workflowId })
    const staged = draft.stagedAgents.find((item) => item.agent.id === agentId)
    if (staged) return staged
    const existing = await this.loadAgent(client, draft.workspaceId, agentId)
    return { agent: existing.agent, baseRevision: existing.revision }
  }

  private async applyOperation(client: pg.PoolClient, draft: GraphDraft, operation: GraphDraftOperationV2, principal: ManagementPrincipal): Promise<GraphDraft> {
    const handled = await applyExecutionOperation(client, principal, draft, operation)
    if (handled) return this.referencedDraft(handled)
    if (draftSemantics(draft) === 2) {
      const approval = applyApprovalOperation(GraphDraftV2Schema.parse(draft), operation, principal)
      if (approval) return this.referencedDraft(approval)
    }
    return this.applyLegacyOperation(client, draft, GraphDraftOperationSchema.parse(operation), principal)
  }

  private async applyLegacyOperation(client: pg.PoolClient, draft: GraphDraft, operation: GraphDraftOperation, principal: ManagementPrincipal): Promise<GraphDraft> {
    const graph = structuredClone(draft.graph)
    switch (operation.type) {
      case 'workflow.set_execution_condition':
        graph.executionCondition = operation.executionCondition
        return GraphDraftSchema.parse({ ...draft, graph })
      case 'workflow.restore_version':
        return restoreWorkflowDraft(client, principal, draft, operation.versionId)
      case 'agent.attach': {
        if (graph.nodes.some((node) => node.id === operation.nodeId)) throw new DomainError('NODE_ID_CONFLICT', 'The node ID already exists.', 409)
        const source = await readAgentForReuse(client, principal, draft.workspaceId, operation.agentId)
        if (source.baseRevision !== operation.expectedAgentRevision || source.agent.configurationVersionId !== operation.expectedConfigurationVersionId) {
          throw new DomainError('AGENT_SOURCE_CONFLICT', 'The source Agent changed since it was selected.', 409)
        }
        this.requireConfigurationAuthorization(principal, draft, source.agent)
        graph.nodes.push({id: operation.nodeId,agentId: operation.agentId,name: operation.name ?? source.agent.name,
          ...(operation.position ? {position: operation.position} : {})})
        const sourceAgentPins = [...(draft.sourceAgentPins ?? []).filter((pin) => pin.agentId !== operation.agentId),
          {agentId: operation.agentId,metadataRevision: source.baseRevision,configurationVersionId: source.agent.configurationVersionId!}]
        return GraphDraftSchema.parse({ ...draft, graph, sourceAgentPins })
      }
      case 'agent.add':
      case 'agent.add_from_template': {
        if (graph.nodes.some((node) => node.id === operation.nodeId)) throw new DomainError('NODE_ID_CONFLICT', 'The node ID already exists.', 409)
        const existing = await client.query('select id from agents where id = $1', [operation.agentId])
        if (existing.rows[0] || draft.stagedAgents.some((item) => item.agent.id === operation.agentId)) {
          throw new DomainError('AGENT_ID_CONFLICT', 'The agent ID already exists.', 409)
        }
        const defaults = await new PostgresFoundationSettingsRepository(this.pool).getAgentDefaults(client)
        const role = operation.type === 'agent.add_from_template' ? operation.template : operation.productRole ?? 'coder'
        const template = defaults.value[role]
        let selected = operation.configuration ?? template.harness
        if (operation.type === 'agent.add' && !operation.configuration && operation.harness
          && defaults.versionId === null && operation.harness !== selected.harness) {
          // Legacy clients explicitly choose a provider. Preserve that choice and their
          // old defaults until a matching role template is persisted. Do not mix providers.
          const legacy = await client.query<{ record: unknown }>('select record from application_settings where key = $1', ['harness-defaults'])
          selected = normalizeHarnessDefaults(legacy.rows[0]?.record)[operation.harness]
        }
        if (operation.type === 'agent.add' && operation.harness && operation.harness !== selected.harness) {
          throw new DomainError('AGENT_TEMPLATE_HARNESS_MISMATCH', 'The requested harness differs from the role template. Supply an explicit matching configuration.', 409)
        }
        const configuration = ManagementHarnessConfigurationSchema.parse(selected)
        const agent = AgentSchema.parse({
          id: operation.agentId, name: operation.name, productRole: role, harness: configuration.harness,
          model: configuration.model,
          effort: projectHarnessEffort(configuration),
          fastMode: configuration.harness === 'codex' ? configuration.serviceTier === 'priority' : undefined,
          harnessConfiguration: configuration, prompt: operation.prompt ?? {}, assignedSkills: operation.assignedSkills ?? [],
          description: operation.description, role: operation.role,
        })
        this.requireConfigurationAuthorization(principal, draft, agent)
        graph.nodes.push({ id: operation.nodeId, agentId: agent.id, name: operation.nodeName ?? operation.name, ...(operation.position ? { position: operation.position } : {}) })
        return replaceAgent(GraphDraftSchema.parse({ ...draft, graph }), agent, null)
      }
      case 'agent.rename': {
        const staged = await this.stageAgent(client, draft, operation.agentId, principal)
        if (staged.baseRevision !== null && staged.baseRevision !== operation.expectedAgentRevision) {
          throw new DomainError('AGENT_REVISION_CONFLICT', 'The agent metadata changed since it was read.', 409, { currentRevision: staged.baseRevision })
        }
        return replaceAgent(draft, AgentSchema.parse({ ...staged.agent, name: operation.name }), staged.baseRevision)
      }
      case 'agent.configure': {
        const staged = await this.stageAgent(client, draft, operation.agentId, principal)
        if (staged.baseRevision !== null && staged.baseRevision !== operation.expectedAgentRevision) {
          throw new DomainError('AGENT_REVISION_CONFLICT', 'The agent metadata changed since it was read.', 409, { currentRevision: staged.baseRevision })
        }
        const configuration = operation.configuration
        const agent = AgentSchema.parse({
          ...staged.agent, harness: configuration.harness, model: configuration.model,
          effort: projectHarnessEffort(configuration),
          fastMode: configuration.harness === 'codex' ? configuration.serviceTier === 'priority' : undefined,
          harnessConfiguration: configuration,
          ...(operation.prompt !== undefined ? { prompt: operation.prompt } : {}),
          ...(operation.assignedSkills !== undefined ? { assignedSkills: operation.assignedSkills } : {}),
          ...(operation.description !== undefined ? { description: operation.description ?? undefined } : {}),
          ...(operation.role !== undefined ? { role: operation.role ?? undefined } : {}),
        })
        return replaceAgent(draft, agent, staged.baseRevision)
      }
      case 'agent.clone': {
        if (graph.nodes.some((node) => node.id === operation.nodeId)) throw new DomainError('NODE_ID_CONFLICT', 'The node ID already exists.', 409)
        const existing = await client.query('select id from agents where id = $1', [operation.agentId])
        if (existing.rows[0] || draft.stagedAgents.some((item) => item.agent.id === operation.agentId)) {
          throw new DomainError('AGENT_ID_CONFLICT', 'The clone agent ID already exists.', 409)
        }
        const source = draft.graph.nodes.some((node) => node.agentId === operation.sourceAgentId)
          ? await this.stageAgent(client, draft, operation.sourceAgentId, principal)
          : await readAgentForReuse(client, principal, draft.workspaceId, operation.sourceAgentId)
        if (operation.expectedSourceConfigurationVersionId !== undefined
          && operation.expectedSourceConfigurationVersionId !== (source.agent.configurationVersionId ?? null)) {
          throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'The copied source configuration changed. Copy it again before saving.', 409)
        }
        if (operation.expectedSourceAgentRevision !== undefined && operation.expectedSourceAgentRevision !== source.baseRevision) {
          throw new DomainError('AGENT_REVISION_CONFLICT', 'The copied source agent changed. Copy it again before saving.', 409)
        }
        const clone = AgentSchema.parse({
          ...source.agent, id: operation.agentId, name: operation.name,
          configurationVersionId: undefined, createdAt: undefined, updatedAt: undefined,
          activeRunId: undefined, executionState: undefined, status: undefined, harnessSummary: undefined,
        })
        this.requireConfigurationAuthorization(principal, draft, clone)
        graph.nodes.push({ id: operation.nodeId, agentId: clone.id, name: operation.name })
        return replaceAgent(GraphDraftSchema.parse({ ...draft, graph }), clone, null)
      }
      case 'node.replace': {
        const index = nodeIndex(graph, operation.node.id)
        if (graph.nodes[index]!.agentId !== operation.node.agentId) {
          throw new DomainError('AGENT_REFERENCE_CHANGE_UNSUPPORTED', 'Replacing node metadata cannot change its agent. Add an authorized clone instead.', 409)
        }
        graph.nodes[index] = operation.node
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'nodes.reorder': {
        const byId = new Map(graph.nodes.map((node) => [node.id, node]))
        if (operation.nodeIds.length !== graph.nodes.length || new Set(operation.nodeIds).size !== graph.nodes.length
          || operation.nodeIds.some((id) => !byId.has(id))) {
          throw new DomainError('NODE_ORDER_INVALID', 'The order must include every draft node exactly once.', 400)
        }
        graph.nodes = operation.nodeIds.map((id) => byId.get(id)!)
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'edges.reorder': {
        const byId = new Map(graph.edges.map((edge) => [edge.id, edge]))
        if (operation.edgeIds.length !== graph.edges.length || new Set(operation.edgeIds).size !== graph.edges.length
          || operation.edgeIds.some((id) => !byId.has(id))) {
          throw new DomainError('EDGE_ORDER_INVALID', 'The order must include every draft edge exactly once.', 400)
        }
        graph.edges = operation.edgeIds.map((id) => byId.get(id)!)
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'edge.put': {
        const edge = operation.edge
        if (edge.source === edge.target) throw new DomainError('SELF_EDGE_UNSUPPORTED', 'A node cannot connect to itself.', 400)
        nodeIndex(graph, edge.source); nodeIndex(graph, edge.target)
        if (graph.edges.some((item) => item.id !== edge.id && item.source === edge.source && item.target === edge.target)) {
          throw new DomainError('EDGE_CONFLICT', 'The edge already exists.', 409)
        }
        const index = graph.edges.findIndex((item) => item.id === edge.id)
        if (index < 0) graph.edges.push(edge)
        else graph.edges[index] = edge
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'workflow.set_approval':
        graph.approval = operation.approval
        return GraphDraftSchema.parse({ ...draft, graph })
      case 'workflow.reset_execution_limits':
        delete graph.executionPolicy
        return GraphDraftSchema.parse({ ...draft, graph })
      case 'workflow.reset_required_agent_count':
        delete graph.requiredAgentCount
        return GraphDraftSchema.parse({ ...draft, graph })
      case 'node.rename': {
        const index = nodeIndex(graph, operation.nodeId)
        graph.nodes[index] = { ...graph.nodes[index]!, name: operation.name }
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'node.set_initial_prompt': {
        const index = nodeIndex(graph, operation.nodeId)
        const node = graph.nodes[index]!
        graph.nodes[index] = operation.initialPrompt === null
          ? { ...node, initialPrompt: undefined }
          : { ...node, initialPrompt: operation.initialPrompt }
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'node.move': {
        const index = nodeIndex(graph, operation.nodeId)
        graph.nodes[index] = { ...graph.nodes[index]!, position: operation.position }
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'node.remove': {
        nodeIndex(graph, operation.nodeId)
        graph.nodes = graph.nodes.filter((node) => node.id !== operation.nodeId)
        graph.edges = graph.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId)
        return this.referencedDraft(GraphDraftSchema.parse({ ...draft, graph }))
      }
      case 'edge.connect': {
        if (operation.sourceNodeId === operation.targetNodeId) throw new DomainError('SELF_EDGE_UNSUPPORTED', 'A node cannot connect to itself.', 400)
        nodeIndex(graph, operation.sourceNodeId)
        nodeIndex(graph, operation.targetNodeId)
        if (graph.edges.some((edge) => edge.id === operation.edgeId
          || (edge.source === operation.sourceNodeId && edge.target === operation.targetNodeId))) {
          throw new DomainError('EDGE_CONFLICT', 'The edge already exists.', 409)
        }
        graph.edges.push({ id: operation.edgeId, source: operation.sourceNodeId, target: operation.targetNodeId })
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'edge.disconnect': {
        if (!graph.edges.some((edge) => edge.id === operation.edgeId)) throw new DomainError('EDGE_NOT_FOUND', `Edge '${operation.edgeId}' was not found.`, 404)
        graph.edges = graph.edges.filter((edge) => edge.id !== operation.edgeId)
        return GraphDraftSchema.parse({ ...draft, graph })
      }
      case 'workflow.set_execution_limits':
        graph.executionPolicy = { maxParallelism: operation.maxParallelism, maxNodeExecutions: operation.maxNodeExecutions }
        return GraphDraftSchema.parse({ ...draft, graph })
      case 'workflow.set_required_agent_count':
        graph.requiredAgentCount = operation.requiredAgentCount
        return GraphDraftSchema.parse({ ...draft, graph })
    }
  }

  async apply(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; draftId: string; commandId: string;
    expectedRevision: number; operations: GraphDraftOperationV2[]; executionSemanticsVersion?: 2
  }) {
    input = input.executionSemanticsVersion === 2 ? GraphDraftApplyV2InputSchema.parse(input) : GraphDraftApplyInputSchema.parse(input)
    requireAuthorization(principal, 'graph:edit', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'graph.apply', commandId: input.commandId,
      targetKey: `draft:${input.draftId}`, payload: input,
      perform: async (client) => {
        await this.lockActiveWorkflow(client, input.workspaceId, input.workflowId)
        const current = await client.query<DraftRow>(
          `select id, record, discarded_at from graph_drafts
           where id = $1 and workspace_id = $2 and workflow_id = $3 for update`,
          [input.draftId, input.workspaceId, input.workflowId],
        )
        if (!current.rows[0] || current.rows[0].discarded_at) throw new DomainError('GRAPH_DRAFT_NOT_FOUND', `Draft '${input.draftId}' is unavailable.`, 404)
        let draft = this.referencedDraft(GraphDraftSchema.parse(current.rows[0].record))
        if (draft.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The graph draft changed since it was read.', 409, { currentRevision: draft.revision })
        }
        if (draftSemantics(draft) === 2 && input.executionSemanticsVersion !== 2) {
          throw new DomainError('EXECUTION_SEMANTICS_MISMATCH', 'Use the explicit v2 mutation boundary for this draft.', 409)
        }
        if (input.executionSemanticsVersion === 2 && draftSemantics(draft) === 1) {
          draft = GraphDraftSchema.parse({ ...draft,
            graph: await promoteExecutionDefinition(client, principal, draft.graph, draft.baseWorkflowVersionId) })
        }
        const effects: GraphDraftEffect[] = []
        for (const operation of input.operations) {
          requireAuthorization(principal, 'graph:edit', { workspaceId: input.workspaceId, workflowId: input.workflowId })
          if (operation.type === 'agent.configure' && operation.configuration.harness === 'codex'
            && operation.configuration.sandbox === 'danger-full-access') {
            requireAuthorization(principal, 'harnesses:update', { workspaceId: input.workspaceId, workflowId: input.workflowId })
          }
          if ((operation.type === 'agent.rename' || operation.type === 'agent.configure')
            && !effects.some((effect) => effect.code === 'SHARED_AGENT_CHANGED' && effect.agentId === operation.agentId)) {
            const workflowIds = await this.authorizeAgentWrite(client, principal, draft, operation.agentId)
            if (workflowIds.length > 1) effects.push({
              code: 'SHARED_AGENT_CHANGED', agentId: operation.agentId, workflowIds,
            })
          }
          const previousEntry = draftEntry(draft)
          draft = await this.applyOperation(client, draft, operation, principal)
          if (operation.type === 'workflow.restore_version' || operation.type === 'workflow.restore_version_v2') {
            for (const staged of draft.stagedAgents) {
              const workflowIds = await this.authorizeAgentWrite(client, principal, draft, staged.agent.id)
              if (workflowIds.length > 1) effects.push({code: 'SHARED_AGENT_CHANGED', agentId: staged.agent.id, workflowIds})
              this.requireConfigurationAuthorization(principal, draft, staged.agent)
            }
          }
          const nextEntry = draftEntry(draft)
          if (previousEntry && previousEntry !== nextEntry && (operation.type === 'node.remove' || operation.type === 'nodes.reorder' || operation.type === 'workflow.restore_version' || operation.type === 'workflow.restore_version_v2' || operation.type === 'workflow.set_entry')) {
            effects.push({ code: 'ENTRY_NODE_CHANGED', previousEntryNodeId: previousEntry, nextEntryNodeId: nextEntry ?? null })
          }
        }
        draft = GraphDraftSchema.parse({
          ...draft, revision: draft.revision + 1,
          updatedByPrincipalId: principal.id, updatedAt: new Date().toISOString(),
        })
        if (draftSemantics(draft) === 2) {
          await client.query("select set_config('graphql.approval_writer','v2',true)")
        }
        await client.query(
          'update graph_drafts set revision = $2, record = $3::jsonb, updated_at = now() where id = $1',
          [draft.id, draft.revision, JSON.stringify(draft)],
        )
        return { draft: this.readableDraft(principal, draft), effects }
      },
    })
  }

  private async validateWithClient(client: pg.PoolClient, draft: GraphDraft, previousDefinition?: WorkflowDefinition): Promise<{ result: ReturnType<typeof GraphValidationResultSchema.parse>; version?: WorkflowVersion }> {
    try {
      const now = new Date().toISOString()
      const configurations = []
      for (const agentId of new Set(draft.graph.nodes.map((node) => node.agentId))) {
        const staged = draft.stagedAgents.find((item) => item.agent.id === agentId)
        const agent = staged?.agent ?? (await this.loadAgent(client, draft.workspaceId, agentId)).agent
        const saved = agent.configurationVersionId ? await client.query<{ record: unknown }>(
          'select record from agent_configuration_versions where id=$1 and workspace_id=$2 and agent_id=$3',
          [agent.configurationVersionId, draft.workspaceId, agentId],
        ) : undefined
        const current = saved?.rows[0] ? AgentConfigurationVersionSchema.parse(saved.rows[0].record) : undefined
        if (!current && staged?.baseRevision !== null) {
          throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', `Agent '${agentId}' has no persisted configuration.`, 409)
        }
        // Use the same merge rules as the eventual write, including legacy projections.
        configurations.push(AgentConfigurationVersionSchema.parse({
          ...configurationInput(draft.workspaceId, agent, current),
          id: staged ? `pending:${agentId}` : current!.id,
          version: current?.version ?? 1, contentHash: 'validation', createdAt: now,
        }))
      }
      if (!previousDefinition) {
        const previous = await client.query<{ record: unknown }>(
          'select record from workflows where workspace_id=$1 and id=$2', [draft.workspaceId, draft.workflowId],
        )
        if (!previous.rows[0]) throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow was not found in this workspace.', 404)
        previousDefinition = WorkflowDefinitionSchema.parse(previous.rows[0].record)
      }
      const version = buildExecutableWorkflowVersion({
        id: 'validation-version', definition: draft.graph, previousDefinition,
        version: 1, configurations, createdAt: now,
      })
      return { result: GraphValidationResultSchema.parse({ valid: true, issues: [] }), version }
    } catch (error) {
      return { result: GraphValidationResultSchema.parse({
        valid: false,
        issues: [{ code: error instanceof DomainError ? error.code : 'GRAPH_INVALID', message: error instanceof Error ? error.message : 'The graph is invalid.' }],
      }) }
    }
  }

  async validate(principal: ManagementPrincipal, workspaceId: string, workflowId: string, draftId: string) {
    requireAuthorization(principal, 'graph:read', { workspaceId, workflowId })
    const draft = await this.get(principal, workspaceId, workflowId, draftId)
    const client = await this.pool.connect()
    try { return (await this.validateWithClient(client, draft)).result } finally { client.release() }
  }

  async save(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; draftId: string; commandId: string; expectedRevision: number; executionSemanticsVersion?: 2
  }) {
    input = input.executionSemanticsVersion === 2 ? GraphSaveV2InputSchema.parse(input) : GraphSaveInputSchema.parse(input)
    requireAuthorization(principal, 'graph:save', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'graph.save', commandId: input.commandId,
      targetKey: `draft:${input.draftId}`, payload: input,
      perform: async (client) => {
        const workflowRow = await this.lockActiveWorkflow(client, input.workspaceId, input.workflowId)
        const current = await client.query<DraftRow>(
          `select id, record, discarded_at from graph_drafts
           where id = $1 and workspace_id = $2 and workflow_id = $3 for update`,
          [input.draftId, input.workspaceId, input.workflowId],
        )
        if (!current.rows[0] || current.rows[0].discarded_at) throw new DomainError('GRAPH_DRAFT_NOT_FOUND', `Draft '${input.draftId}' is unavailable.`, 404)
        let draft = this.referencedDraft(GraphDraftSchema.parse(current.rows[0].record))
        if (draft.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The graph draft changed since it was read.', 409, { currentRevision: draft.revision })
        if (draftSemantics(draft) !== (input.executionSemanticsVersion ?? 1)) throw new DomainError('EXECUTION_SEMANTICS_MISMATCH', 'Save using the exact draft execution semantics.', 409)
        if (workflowRow.current_version_id !== draft.baseWorkflowVersionId) throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The saved workflow changed since this draft was opened.', 409)
        const agentIdsToLock = [...new Set(draft.graph.nodes.map((node) => node.agentId))].sort()
        await lockAgentConfigurations(client, agentIdsToLock)
        await assertSourceAgentPins(client, draft, principal)
        const validation = await this.validateWithClient(client, draft, WorkflowDefinitionSchema.parse(workflowRow.record))
        if (!validation.result.valid) throw new DomainError('GRAPH_INVALID', 'The graph is not executable.', 409, { issues: validation.result.issues })

        for (const staged of [...draft.stagedAgents].sort((left, right) => left.agent.id < right.agent.id ? -1 : left.agent.id > right.agent.id ? 1 : 0)) {
          await this.authorizeAgentWrite(client, principal, draft, staged.agent.id)
          this.requireConfigurationAuthorization(principal, draft, staged.agent)
          if (staged.baseRevision !== null) {
            const row = await client.query<{ metadata_revision: string }>(
              'select metadata_revision from agents where workspace_id = $1 and id = $2 for update',
              [input.workspaceId, staged.agent.id],
            )
            if (Number(row.rows[0]?.metadata_revision) !== staged.baseRevision) {
              throw new DomainError('AGENT_REVISION_CONFLICT', `Agent '${staged.agent.id}' changed since the draft was edited.`, 409)
            }
          }
          const savedAgent = await saveAgentConfiguration(client, input.workspaceId, staged.agent)
          // A legacy projection may inherit settings from its saved version.
          // This check is still inside the transaction, so failure rolls back.
          this.requireConfigurationAuthorization(principal, draft, savedAgent)
          if (staged.baseRevision !== null) {
            await client.query('update agents set metadata_revision = metadata_revision + 1 where id = $1', [staged.agent.id])
          }
        }
        const agentIds = [...new Set(draft.graph.nodes.map((node) => node.agentId))]
        const configRows = await client.query<{ record: unknown }>(
          `select versions.record from agents
           join agent_configuration_versions versions on versions.id = agents.current_configuration_version_id
           where agents.workspace_id = $1 and agents.id = any($2::text[]) order by agents.id for share of agents`,
          [input.workspaceId, agentIds],
        )
        const configurations = configRows.rows.map((row) => AgentConfigurationVersionSchema.parse(row.record))
        const versionNumber = Number((await client.query<{ next: string }>(
          'select coalesce(max(version), 0) + 1 as next from workflow_versions where workflow_id = $1', [input.workflowId],
        )).rows[0]?.next ?? 1)
        const now = new Date().toISOString()
        const metadata = WorkflowDefinitionSchema.parse(workflowRow.record)
        const version = buildExecutableWorkflowVersion({
          id: `${input.workflowId}-v${versionNumber}-${randomUUID()}`,
          definition: { ...draft.graph, name: metadata.name, description: metadata.description },
          previousDefinition: metadata, version: versionNumber, configurations, createdAt: now,
        })
        if (draftSemantics(draft) === 2) {
          validateExecutableApprovalRoutes(WorkflowVersionV2Schema.parse(version), configurations)
          await client.query("select set_config('graphql.approval_writer','v2',true)")
        }
        const definition = version.definition
        await client.query(
          `insert into workflow_versions (id, workspace_id, workflow_id, version, entry_node_id, record, execution_semantics_version)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [version.id, version.workspaceId, version.workflowId, version.version, version.entryNodeId, JSON.stringify(version), draftSemantics(draft)],
        )
        await client.query(
          `update workflows set current_version_id = $3, record = $4::jsonb, revision = revision + 1
           where workspace_id = $1 and id = $2`, [input.workspaceId, input.workflowId, version.id, JSON.stringify(definition)],
        )
        draft = GraphDraftSchema.parse({
          ...draft, revision: draft.revision + 1, baseWorkflowVersionId: version.id,
          publishedRevision: draft.revision + 1,
          graph: definition, stagedAgents: [], sourceAgentPins: [], updatedByPrincipalId: principal.id, updatedAt: now,
        })
        await client.query(
          `update graph_drafts set revision = $2, base_workflow_version_id = $3, record = $4::jsonb, updated_at = now()
           where id = $1`, [draft.id, draft.revision, version.id, JSON.stringify(draft)],
        )
        const publishedAgents: Array<{ agent: Agent; metadataRevision: number }> = []
        if (isAuthorized(principal, 'agents:read', { workspaceId: input.workspaceId, workflowId: input.workflowId })) {
          for (const agentId of [...agentIds].sort()) {
            const persisted = await this.loadAgent(client, input.workspaceId, agentId)
            publishedAgents.push({ agent: persisted.agent, metadataRevision: persisted.revision })
          }
        }
        return { draft, version, agents: publishedAgents }
      },
    })
  }

  async discard(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; draftId: string; commandId: string; expectedRevision: number
  }) {
    requireAuthorization(principal, 'graph:edit', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'graph.discard', commandId: input.commandId,
      targetKey: `draft:${input.draftId}`, payload: input,
      perform: async (client) => {
        await this.lockActiveWorkflow(client, input.workspaceId, input.workflowId)
        const current = await client.query<DraftRow>(
          `select id, record, discarded_at from graph_drafts
           where id = $1 and workspace_id = $2 and workflow_id = $3 for update`,
          [input.draftId, input.workspaceId, input.workflowId],
        )
        if (!current.rows[0] || current.rows[0].discarded_at) throw new DomainError('GRAPH_DRAFT_NOT_FOUND', `Draft '${input.draftId}' is unavailable.`, 404)
        const draft = GraphDraftSchema.parse(current.rows[0].record)
        if (draft.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'The graph draft changed since it was read.', 409, { currentRevision: draft.revision })
        await client.query('update graph_drafts set discarded_at = now(), updated_at = now() where id = $1', [draft.id])
        return { discarded: true, draftId: draft.id, revision: draft.revision }
      },
    })
  }
}
