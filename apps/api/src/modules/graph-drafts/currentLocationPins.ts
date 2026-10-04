import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

/** Shared journal pins, extracted from the repeat-only editor. Read under the
 * workspace/workflow locks. No locations, credentials or Run inputs go on wire. */
export async function readCurrentEditLocationPins(client: pg.PoolClient, principal: ManagementPrincipal,
  scope: { workspaceId: string; workflowId: string; stagedAgentIds?: string[]; presentationOnly?: boolean }) {
  const workspace = (await client.query<{
    location_revision: string; execution_location: unknown; execution_location_identity: unknown
  }>(`select location_revision::text,execution_location,execution_location_identity
    from workspaces where id=$1 for share`, [scope.workspaceId])).rows[0]
  const revision = Number(workspace?.location_revision)
  if (!workspace || !Number.isSafeInteger(revision) || revision < 0) {
    throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location pin is unavailable.', 409)
  }
  if (scope.presentationOnly) {
    return { locationRevision: revision, locationDigest: commandInputHash(workspace), runLocationPins: [] }
  }
  const rows = await client.query<{
    id: string; workspace_id: string; workflow_id: string; workflow_version_id: string
    runner_id: string | null; working_directory: string | null; location_revision: string | null; execution_location: unknown
  }>(`select id,workspace_id,workflow_id,workflow_version_id,runner_id,working_directory,
      location_revision::text,record->'executionLocation' as execution_location
    from runs r where workspace_id=$1 and (workflow_id=$2
      or r.record->'agentConfigurationVersionIds' ?| $3::text[]
      or exists(select 1 from workflow_versions v where v.id=r.workflow_version_id and v.record->'agentConfigurationVersionIds' ?| $3::text[]))
    order by id for share`, [scope.workspaceId, scope.workflowId, scope.stagedAgentIds ?? []])
  const runLocationPins = rows.rows.map((row) => {
    requireAuthorization(principal, 'runs:read', { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: row.id })
    if (row.workspace_id !== scope.workspaceId) {
      throw new DomainError('GRAPH_EDIT_INTENT_INVALID', 'An affected Run location is outside the exact scope.', 409)
    }
    return { runId: row.id, digest: commandInputHash(row) }
  })
  return { locationRevision: revision, locationDigest: commandInputHash(workspace), runLocationPins }
}
