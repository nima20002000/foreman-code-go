import { AgentConfigurationVersionSchema, WorkflowVersionSchema } from '@graphql/contracts'
import { GraphDraftV2Schema, canonicalGraphJson, type GraphDraftV2 } from '@graphql/contracts/wave25'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { deriveLegacyApprovalRelationships } from './approvalMigration.js'

/** Called by the existing graph draft command transaction, after its v2 structural
 * conversion. This lane only materializes legacy-authorized approval pairs.
 * Command receipt/audit ownership remains with the shared command coordinator. */
export async function persistLegacyApprovalRelationships(client: pg.PoolClient, principal: ManagementPrincipal, input: {
  workspaceId: string; workflowId: string; draftId: string; expectedRevision: number; sourceVersionId: string
}): Promise<GraphDraftV2> {
  requireAuthorization(principal, 'graph:read', input)
  requireAuthorization(principal, 'graph:edit', input)
  requireAuthorization(principal, 'workflows:read', input)
  const saved = (await client.query<{ record: unknown }>(`select record from workflow_versions
    where id=$1 and workspace_id=$2 and workflow_id=$3 and execution_semantics_version=1`,
  [input.sourceVersionId, input.workspaceId, input.workflowId])).rows[0]
  if (!saved) throw new DomainError('APPROVAL_MIGRATION_SOURCE_INVALID', 'The accepted legacy source version is unavailable.', 409)
  const version = WorkflowVersionSchema.parse(saved.record)
  const row = (await client.query<{ record: unknown; revision: string; discarded_at: Date | null }>(
    'select record,revision::text,discarded_at from graph_drafts where id=$1 and workspace_id=$2 and workflow_id=$3 for update',
    [input.draftId, input.workspaceId, input.workflowId])).rows[0]
  if (!row || row.discarded_at) throw new DomainError('DRAFT_NOT_FOUND', 'The current draft was not found.', 404)
  const draft = GraphDraftV2Schema.parse(row.record)
  if (String(input.expectedRevision) !== row.revision || draft.revision !== input.expectedRevision
    || draft.baseWorkflowVersionId !== version.id) throw new DomainError('REVISION_CONFLICT', 'Reload the exact legacy-backed draft before migrating approval.', 409)
  const configurations = (await client.query<{ record: unknown }>(
    'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[])',
    [input.workspaceId, Object.values(version.agentConfigurationVersionIds)])).rows.map((item) => AgentConfigurationVersionSchema.parse(item.record))
  const authorized = deriveLegacyApprovalRelationships(version, configurations)
  const originalExecutions = version.definition.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })).sort((a, b) => a.id.localeCompare(b.id))
  const convertedExecutions = draft.graph.edges.filter((edge) => edge.kind === 'execution')
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })).sort((a, b) => a.id.localeCompare(b.id))
  if (canonicalGraphJson(originalExecutions) !== canonicalGraphJson(convertedExecutions)
    || canonicalGraphJson(version.definition.nodes.map((node) => [node.id, node.agentId]).sort())
      !== canonicalGraphJson(draft.graph.nodes.map((node) => [node.id, node.agentId]).sort())
    || canonicalGraphJson(version.approval ?? null) !== canonicalGraphJson(draft.graph.approval ?? null)) {
    throw new DomainError('APPROVAL_MIGRATION_TOPOLOGY_CHANGED', 'Approval migration cannot change execution direction, node identity or the accepted handler.', 409)
  }
  const existing = draft.graph.edges.filter((edge) => edge.kind === 'approval')
  if (existing.length && canonicalGraphJson([...existing].sort((a,b) => a.id.localeCompare(b.id)))
    !== canonicalGraphJson([...authorized].sort((a,b) => a.id.localeCompare(b.id)))) {
    throw new DomainError('APPROVAL_MIGRATION_CONFLICT', 'The draft already has a different explicit approval assignment.', 409)
  }
  if (existing.length === authorized.length) return draft
  if (authorized.some((edge) => draft.graph.edges.some((existingEdge) => existingEdge.id === edge.id))) {
    throw new DomainError('APPROVAL_MIGRATION_ID_CONFLICT', 'The migrated approval ID conflicts with a saved relationship.', 409)
  }
  const next = GraphDraftV2Schema.parse({ ...draft, revision: draft.revision + 1,
    graph: { ...draft.graph, edges: [...draft.graph.edges, ...authorized] },
    updatedByPrincipalId: principal.id, updatedAt: new Date().toISOString() })
  await client.query("select set_config('graphql.approval_writer','v2',true)")
  const updated = await client.query(`update graph_drafts set revision=$2,record=$3::jsonb,updated_at=clock_timestamp()
    where id=$1 and revision=$4::bigint and discarded_at is null`, [draft.id, next.revision, JSON.stringify(next), row.revision])
  if (updated.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The draft changed during approval migration.', 409)
  return next
}
