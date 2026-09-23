import {
  GraphDraftApplyV2InputSchema, GraphDraftCommandV2ResultSchema, GraphDraftV2Schema,
  type GraphDraftV2,
} from '@graphql/contracts/wave25'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { applyApprovalOperation } from './approvalOperations.js'

/** Shared UI/Operator service for the approval subset of the frozen v2 command.
 * It does not create versions, choose entry, schedule work, or replace the common
 * graph dispatcher. Mixed execution/approval batches belong to that dispatcher. */
export class Wave25ApprovalDraftService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  async getIfV2(principal: ManagementPrincipal, workspaceId: string, workflowId: string,
    draftId?: string): Promise<GraphDraftV2 | undefined> {
    requireAuthorization(principal, 'graph:read', { workspaceId, workflowId })
    const found = await this.pool.query<{ record: unknown }>(
      `select record from graph_drafts where workspace_id=$1 and workflow_id=$2
       and ($3::text is null or id=$3) and discarded_at is null
       and record->'graph'->>'executionSemanticsVersion'='2'`, [workspaceId, workflowId, draftId ?? null])
    if (!found.rows[0]) return undefined
    const draft = GraphDraftV2Schema.parse(found.rows[0].record)
    if (draft.workspaceId !== workspaceId || draft.workflowId !== workflowId || draftId && draft.id !== draftId) {
      throw new DomainError('DRAFT_IDENTITY_INVALID', 'The saved draft identity does not match its scope.', 409)
    }
    if (draft.stagedAgents.length) requireAuthorization(principal, 'agents:read', { workspaceId, workflowId })
    return draft
  }

  async apply(principal: ManagementPrincipal, source: 'http' | 'mcp', input: unknown) {
    const parsed = GraphDraftApplyV2InputSchema.parse(input)
    const scope = { workspaceId: parsed.workspaceId, workflowId: parsed.workflowId }
    requireAuthorization(principal, 'graph:read', scope)
    requireAuthorization(principal, 'graph:edit', scope)
    // Replayed commands also require current management authority, not a cached token.
    const live = await readLiveManagementPrincipal(this.pool, principal.id)
    requireAuthorization(live, 'graph:read', scope)
    requireAuthorization(live, 'graph:edit', scope)
    const result = await this.commands.execute({ principal: live, source, operation: 'graph_draft_apply',
      commandId: parsed.commandId, targetKey: `draft:${parsed.draftId}`, payload: parsed,
      perform: async (client) => {
        const current = await readLiveManagementPrincipal(client, live.id)
        requireAuthorization(current, 'graph:read', scope)
        requireAuthorization(current, 'graph:edit', scope)
        const workspace = await client.query('select id from workspaces where id=$1 and archived_at is null for share', [scope.workspaceId])
        const workflow = await client.query('select id from workflows where id=$1 and workspace_id=$2 and archived_at is null for update',
          [scope.workflowId, scope.workspaceId])
        if (workspace.rowCount !== 1 || workflow.rowCount !== 1) throw new DomainError('WORKFLOW_NOT_FOUND', 'The active workflow was not found.', 404)
        const row = (await client.query<{ record: unknown; revision: string }>(
          `select record,revision::text from graph_drafts where id=$1 and workspace_id=$2 and workflow_id=$3
           and discarded_at is null for update`, [parsed.draftId, scope.workspaceId, scope.workflowId])).rows[0]
        if (!row) throw new DomainError('DRAFT_NOT_FOUND', 'The draft was not found.', 404)
        let draft = GraphDraftV2Schema.parse(row.record)
        if (draft.id !== parsed.draftId || draft.workspaceId !== scope.workspaceId || draft.workflowId !== scope.workflowId
          || draft.revision !== parsed.expectedRevision || row.revision !== String(parsed.expectedRevision)) {
          throw new DomainError('REVISION_CONFLICT', 'Reload the draft before changing approval relationships.', 409)
        }
        if (draft.stagedAgents.length) requireAuthorization(current, 'agents:read', scope)
        for (const operation of parsed.operations) {
          const next = applyApprovalOperation(draft, operation, current)
          if (!next) throw new DomainError('APPROVAL_OPERATION_NOT_OWNED',
            'Use the shared v2 graph dispatcher for execution, entry or mixed operation batches. Nothing was saved.', 409)
          draft = next
        }
        draft = GraphDraftV2Schema.parse({ ...draft, revision: draft.revision + 1,
          updatedByPrincipalId: current.id, updatedAt: new Date().toISOString() })
        await client.query("select set_config('graphql.approval_writer','v2',true)")
        const saved = await client.query(`update graph_drafts set revision=$2,record=$3::jsonb,updated_at=clock_timestamp()
          where id=$1 and revision=$4::bigint and discarded_at is null`, [draft.id, draft.revision, JSON.stringify(draft), row.revision])
        if (saved.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The draft changed while saving approval.', 409)
        return { draft, effects: [] }
      },
    })
    return GraphDraftCommandV2ResultSchema.parse(result)
  }
}
