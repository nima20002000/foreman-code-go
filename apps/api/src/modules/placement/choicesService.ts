import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { WorkflowVersionV3Schema } from '@graphql/contracts/wave25'
import { NodePlacementChoicesInputSchema, NodePlacementChoicesResultSchema, type NodePlacementChoicesInput, type NodePlacementChoice, type NodePlacementChoicesResult } from '@graphql/contracts/placement-readback'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'

/** W07/W09 host discovery supplies only destinations permitted by the live main,
 * workspace/root policy and exact harness configuration. No browser-made IDs. */
export interface PlacementChoiceDiscovery {
  list(principal: ManagementPrincipal, input: NodePlacementChoicesInput): Promise<readonly NodePlacementChoice[]>
}
export class NodePlacementChoicesService {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string, private readonly discovery: PlacementChoiceDiscovery) {}
  private async pinned(principal: ManagementPrincipal, input: NodePlacementChoicesInput): Promise<ManagementPrincipal> {
    const authorize = (p: ManagementPrincipal) => {
      requireAuthorization(p, 'workflows:read', input)
      requireAuthorization(p, 'workspace_locations:read', input)
    }
    authorize(principal)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const live = await readLiveManagementPrincipal(client, principal.id); authorize(live)
      const row = (await client.query<{ record: unknown }>(`select v.record from workflows w
        join workflow_versions v on v.id=w.current_version_id
        where w.workspace_id=$1 and w.id=$2 and w.archived_at is null`, [input.workspaceId, input.workflowId])).rows[0]
      if (!row) throw new DomainError('WORKFLOW_NOT_SAVED', 'Placement choices require a saved workflow.', 409)
      const version = WorkflowVersionV3Schema.parse(row.record), node = version.definition.nodes.find(n => n.id === input.nodeId)
      if (!node || node.kind === 'job' || version.agentConfigurationVersionIds[node.agentId] !== input.agentConfigurationVersionId) throw new DomainError(
        'PLACEMENT_CONFIGURATION_CONFLICT', 'Placement choices require the saved node configuration.', 409)
      authorize(principal); authorize(live); await client.query('commit')
      return live
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  async get(principal: ManagementPrincipal, raw: unknown): Promise<NodePlacementChoicesResult> {
    const input = NodePlacementChoicesInputSchema.parse(raw)
    const live = await this.pinned(principal, input)
    const choices = await this.discovery.list(live, input)
    await this.pinned(principal, input) // external discovery held no SQL locks
    const result = NodePlacementChoicesResultSchema.parse({ ...input, choices })
    if (result.choices.some(choice => choice.placement.hostRef.mainId !== this.mainId)
      || new Set(result.choices.map(choice => choice.id)).size !== result.choices.length) throw new DomainError(
      'PLACEMENT_CHOICES_INVALID', 'Destination discovery returned duplicate selection identities.', 409)
    return result
  }
}
