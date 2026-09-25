import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  GraphDraftV2Schema, GraphEditIntentSchema, GraphEditReadResultSchema,
  GraphEditStageInputSchema, GraphSaveV2ResultSchema,
  type GraphDraftV2, type GraphEditIntent, type GraphEditStageInput,
} from '@graphql/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { DurableEditIntentService } from './durableEditIntent.js'
export { sameAffectedSet } from './durableEditIntent.js'

type Source = 'http' | 'mcp'
type Prepared = { draft: GraphDraftV2; savedWorkflowRevision: number; agentPins: GraphEditIntent['agentPins'] }
interface DraftBoundary {
  prepare(client: pg.PoolClient, principal: ManagementPrincipal, input: GraphEditStageInput): Promise<Prepared>
  authorizePublication(client: pg.PoolClient, principal: ManagementPrincipal, draft: GraphDraftV2): Promise<void>
  publish(principal: ManagementPrincipal, source: Source, input: GraphEditIntent['saveInput'], intentId: string): Promise<unknown>
}

/** The v2 board adapter. Its public schemas, draft pins and writer are unchanged;
 * repeat-only edits use the same journal/state machine with a different payload. */
export class GraphEditIntentService extends DurableEditIntentService<GraphEditStageInput, GraphEditIntent> {
  constructor(pool: pg.Pool, commands: PostgresCommandCoordinator, drafts: DraftBoundary) {
    super(pool, commands, {
      kind: 'graph', stageSchema: GraphEditStageInputSchema, intentSchema: GraphEditIntentSchema,
      readResultSchema: GraphEditReadResultSchema, resultSchema: GraphSaveV2ResultSchema,
      prepare: async (client, principal, input, saveCommandId) => {
        const prepared = await drafts.prepare(client, principal, input)
        return { savedWorkflowRevision: prepared.savedWorkflowRevision, agentPins: prepared.agentPins,
          stagedDraft: prepared.draft, saveInput: { workspaceId: input.workspaceId, workflowId: input.workflowId,
            draftId: input.draftId, expectedRevision: input.expectedRevision,
            commandId: saveCommandId, executionSemanticsVersion: 2 } }
      },
      stagedAgentIds: (draft) => draft.stagedAgents.filter((item) => item.baseRevision !== null).map((item) => item.agent.id),
      authorize: () => undefined,
      authorizeContent: (principal, intent) => {
        if (intent.stagedDraft.stagedAgents.length || intent.result?.agents?.length) requireAuthorization(principal, 'agents:read', intent)
      },
      assertDraft: async (client, _principal, intent) => {
        const row = (await client.query<{ record: unknown }>(`select record from graph_drafts
          where id=$1 and workspace_id=$2 and workflow_id=$3 and discarded_at is null for update`,
        [intent.draftId, intent.workspaceId, intent.workflowId])).rows[0]
        const draft = row ? GraphDraftV2Schema.parse(row.record) : undefined
        if (!draft || draft.revision !== intent.expectedRevision || draft.baseWorkflowVersionId !== intent.expectedWorkflowVersionId) {
          throw new DomainError('REVISION_CONFLICT', 'The shared draft instance or revision changed. The private staged payload is retained.', 409)
        }
      },
      authorizePublication: (client, principal, draft) => drafts.authorizePublication(client, principal, draft),
      saveInputHash: (input, intentId) => commandInputHash({ ...input, editIntentId: intentId }),
      resultScope: (value) => ({ workspaceId: value.draft.workspaceId, workflowId: value.draft.workflowId }),
      publish: (principal, source, input, intentId) => drafts.publish(principal, source, input, intentId),
    })
  }
}
