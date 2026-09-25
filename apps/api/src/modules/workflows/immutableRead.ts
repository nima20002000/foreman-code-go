import { createHash } from 'node:crypto'
import { AgentConfigurationVersionSchema, type AgentConfigurationVersion } from '@graphql/contracts'
import { SavedWorkflowVersionSchema, SavedWorkflowDefinitionSchema, canonicalGraphJson, type SavedWorkflowVersion } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'

/** Physical columns are authority too. A valid JSON body cannot impersonate a
 * different immutable row or be silently interpreted under another semantics. */
export interface ImmutableWorkflowVersionRow {
  id: string
  workspace_id: string
  workflow_id: string
  version: number
  entry_node_id: string
  execution_semantics_version: number
  record: unknown
}
export interface ImmutableAgentConfigurationRow {
  id: string
  workspace_id: string
  agent_id: string
  version: number
  record: unknown
}
export const IMMUTABLE_WORKFLOW_VERSION_COLUMNS = 'id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record'

export function readImmutableWorkflowVersion(row: ImmutableWorkflowVersionRow,
  expected: { id?: string; workspaceId?: string; workflowId?: string } = {}): SavedWorkflowVersion {
  const parsed = SavedWorkflowVersionSchema.safeParse(row.record)
  if (!parsed.success) throw new DomainError('WORKFLOW_VERSION_RECORD_INVALID', 'The immutable workflow version is invalid.', 409)
  const version = parsed.data
  const semantics = 'executionSemanticsVersion' in version ? version.executionSemanticsVersion : 1
  if (version.id !== row.id || version.workspaceId !== row.workspace_id || version.workflowId !== row.workflow_id
    || version.version !== row.version || version.entryNodeId !== row.entry_node_id || semantics !== row.execution_semantics_version
    || expected.id !== undefined && version.id !== expected.id
    || expected.workspaceId !== undefined && version.workspaceId !== expected.workspaceId
    || expected.workflowId !== undefined && version.workflowId !== expected.workflowId) {
    throw new DomainError('WORKFLOW_VERSION_PIN_MISMATCH', 'The immutable workflow version does not match its persisted identity.', 409)
  }
  if (semantics === 3) {
    // Exact repeat-authoring hash payload. Never recompute a legacy hash using a
    // new algorithm, or replace/relabel a stored version to make a read succeed.
    const digest = `sha256:${createHash('sha256').update(canonicalGraphJson({
      definition: version.definition, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
    })).digest('hex')}`
    if (digest !== version.contentHash) throw new DomainError('WORKFLOW_VERSION_HASH_MISMATCH', 'The immutable workflow version content hash does not match.', 409)
  }
  return version
}

export function readImmutableAgentConfiguration(row: ImmutableAgentConfigurationRow,
  expected: { id?: string; workspaceId?: string; agentId?: string } = {}): AgentConfigurationVersion {
  const parsed = AgentConfigurationVersionSchema.safeParse(row.record)
  if (!parsed.success || parsed.data.id !== row.id || parsed.data.workspaceId !== row.workspace_id
    || parsed.data.agentId !== row.agent_id || parsed.data.version !== row.version
    || expected.id !== undefined && parsed.data.id !== expected.id
    || expected.workspaceId !== undefined && parsed.data.workspaceId !== expected.workspaceId
    || expected.agentId !== undefined && parsed.data.agentId !== expected.agentId) {
    throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'An immutable configuration does not match its persisted identity.', 409)
  }
  return parsed.data
}

export function readSavedWorkflowDefinition(row: { id: string; workspace_id: string; record: unknown },
  expected: { workspaceId: string; workflowId?: string }) {
  const parsed = SavedWorkflowDefinitionSchema.safeParse(row.record)
  if (!parsed.success || parsed.data.id !== row.id || parsed.data.workspaceId !== row.workspace_id
    || row.workspace_id !== expected.workspaceId || expected.workflowId !== undefined && row.id !== expected.workflowId) {
    throw new DomainError('WORKFLOW_RECORD_INVALID', 'The workflow definition does not match its persisted scope.', 409)
  }
  return parsed.data
}
