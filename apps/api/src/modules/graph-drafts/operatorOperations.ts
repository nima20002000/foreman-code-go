import type pg from 'pg'
import { AgentConfigurationVersionSchema, AgentSchema } from '@graphql/contracts'
import { type GraphDraft, type ManagementPrincipal } from '@graphql/contracts/management'
import { CompatibleWorkflowVersionSchema as WorkflowVersionSchema, WorkflowVersionV2Schema } from '@graphql/contracts/wave25'
import { GraphDraftRecordSchema as GraphDraftSchema, draftSemantics } from './executionOperations.js'
import { migrateSavedWorkflowDefinition } from '../workflows/executableVersion.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { agentWithConfiguration, readAgentForReuse } from '../workspaces/operatorAgents.js'

export async function assertSourceAgentPins(client: pg.ClientBase, draft: GraphDraft, principal: ManagementPrincipal): Promise<void> {
  for (const pin of draft.sourceAgentPins ?? []) {
    await readAgentForReuse(client, principal, draft.workspaceId, pin.agentId)
    const rows = await client.query<{metadata_revision:string;current_configuration_version_id:string|null;archived_at:Date|null}>(
      'select metadata_revision,current_configuration_version_id,archived_at from agents where workspace_id=$1 and id=$2 for share',[draft.workspaceId,pin.agentId],
    )
    const current = rows.rows[0]
    if (!current || current.archived_at || Number(current.metadata_revision) !== pin.metadataRevision || current.current_configuration_version_id !== pin.configurationVersionId) {
      throw new DomainError('AGENT_SOURCE_CONFLICT','An attached or restored Agent changed. Reload its version before publishing.',409)
    }
  }
}

/** Restore into a draft. Historical workflow/configuration records are never rewritten. */
export async function restoreWorkflowDraft(client: pg.ClientBase, principal: ManagementPrincipal, draft: GraphDraft, versionId: string): Promise<GraphDraft> {
  requireAuthorization(principal,'workflows:read',{workspaceId:draft.workspaceId,workflowId:draft.workflowId})
  requireAuthorization(principal,'graph:edit',{workspaceId:draft.workspaceId,workflowId:draft.workflowId})
  const rows = await client.query<{record:unknown}>('select record from workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',[draft.workspaceId,draft.workflowId,versionId])
  if (!rows.rows[0]) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND','The saved workflow version was not found.',404)
  const version = WorkflowVersionSchema.parse(rows.rows[0].record)
  if (version.workflowId !== draft.workflowId || version.workspaceId !== draft.workspaceId || version.id !== versionId) throw new DomainError('WORKFLOW_VERSION_INVALID','The historical workflow identity does not match.',409)
  const versionIsV2 = 'executionSemanticsVersion' in version && version.executionSemanticsVersion === 2
  if (versionIsV2 && draftSemantics(draft) !== 2) throw new DomainError('EXECUTION_SEMANTICS_MISMATCH', 'Restore this version using the explicit v2 draft operation.', 409)
  const definition = draftSemantics(draft) === 2
    ? versionIsV2 ? WorkflowVersionV2Schema.parse(version).definition : migrateSavedWorkflowDefinition(version)
    : version.definition
  const stagedAgents: GraphDraft['stagedAgents'] = []
  const sourceAgentPins: NonNullable<GraphDraft['sourceAgentPins']> = []
  for (const agentId of [...new Set(version.definition.nodes.map((node) => node.agentId))].sort()) {
    const source = await readAgentForReuse(client,principal,draft.workspaceId,agentId)
    const configurations = await client.query<{record:unknown}>(
      'select record from agent_configuration_versions where workspace_id=$1 and agent_id=$2 and id=$3',
      [draft.workspaceId,agentId,version.agentConfigurationVersionIds[agentId]],
    )
    if (!configurations.rows[0]) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE','A historical Agent configuration is missing.',409)
    const configuration = AgentConfigurationVersionSchema.parse(configurations.rows[0].record)
    const agent = agentWithConfiguration(AgentSchema.parse({...source.agent,productRole:configuration.productRole,
      prompt:configuration.prompt,assignedSkills:configuration.assignedSkills}),configuration.harness)
    stagedAgents.push({agent,baseRevision:source.baseRevision})
    sourceAgentPins.push({agentId,metadataRevision:source.baseRevision,configurationVersionId:source.agent.configurationVersionId!})
  }
  return GraphDraftSchema.parse({...draft, graph:{...definition,
    name:draft.graph.name,description:draft.graph.description,createdAt:draft.graph.createdAt,updatedAt:draft.graph.updatedAt},
    stagedAgents,sourceAgentPins})
}
