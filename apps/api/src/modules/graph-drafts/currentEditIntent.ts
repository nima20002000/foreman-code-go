import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  CurrentEditDraftSchema, CurrentEditIntentSchema, CurrentEditReadResultSchema, CurrentEditStageInputSchema,
  CurrentWorkflowSaveInputSchema, CurrentWorkflowSavedSchema, sameWorkflowValue,
  type CurrentEditIntent, type CurrentEditStageInput, type CurrentEditDraft,
  type CurrentWorkflowSaveInput, type CurrentWorkflowValidateInput, type WorkflowVersionV3,
} from '@graphql/contracts/wave25'
import { requireCurrentWorkflowAccess } from '../workflows/currentWorkflowPolicy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockAgentConfigurations } from '../workspaces/agentConfiguration.js'
import { readCurrentEditLocationPins } from './currentLocationPins.js'
import { DurableEditIntentService, type EditIntentSource } from './durableEditIntent.js'

export interface CurrentEditWriter {
  assertStopReady(): void
  validate(client: pg.PoolClient, principal: ManagementPrincipal, input: CurrentWorkflowValidateInput): Promise<WorkflowVersionV3>
  publish(principal: ManagementPrincipal, source: EditIntentSource, input: CurrentWorkflowSaveInput, intentId: string): Promise<unknown>
}
/** Same durable Stage/Discard/Stop-and-save coordinator, now with a complete
 * semantics-3 payload. No Agent write and no new Stop/native implementation. */
export function createCurrentEditIntentService(pool: pg.Pool, commands: PostgresCommandCoordinator, writer: CurrentEditWriter) {
  return new DurableEditIntentService<CurrentEditStageInput, CurrentEditIntent>(pool, commands, {
    kind: 'current', stageSchema: CurrentEditStageInputSchema, intentSchema: CurrentEditIntentSchema,
    readResultSchema: CurrentEditReadResultSchema, resultSchema: CurrentWorkflowSavedSchema,
    authorize: (principal, scope, write) => requireCurrentWorkflowAccess(principal, write ? 'save' : 'validate', scope),
    authorizeContent: () => undefined, stagedAgentIds: () => [],
    prepare: async (client, principal, input, saveCommandId) => {
      const { action, draftId, commandId, ...definition } = input
      void action; void commandId
      const saveInput = CurrentWorkflowSaveInputSchema.parse({ ...definition, commandId: saveCommandId })
      const version = await writer.validate(client, principal, definition)
      if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) {
        throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'The Stage configuration pins changed.', 409)
      }
      const ids = Object.keys(version.agentConfigurationVersionIds).sort()
      await lockAgentConfigurations(client, ids)
      const heads = (await client.query<{ id: string; metadata_revision: string; current_configuration_version_id: string | null }>(
        `select id,metadata_revision::text,current_configuration_version_id from agents
         where workspace_id=$1 and id=any($2::text[]) and archived_at is null order by id for share`, [input.workspaceId, ids])).rows
      if (heads.length !== ids.length || heads.some((row, index) => row.id !== ids[index]
        || row.current_configuration_version_id !== input.expectedAgentConfigurationVersionIds[row.id]
        || !Number.isSafeInteger(Number(row.metadata_revision)) || Number(row.metadata_revision) < 0)) {
        throw new DomainError('AGENT_REVISION_CONFLICT', 'Stage requires every exact live Agent head.', 409)
      }
      const locations = await readCurrentEditLocationPins(client, principal, input)
      if (locations.locationRevision !== input.expectedLocationRevision) throw new DomainError('LOCATION_REVISION_CONFLICT', 'The displayed workspace location changed.', 409)
      const stagedDraft = CurrentEditDraftSchema.parse({ id: draftId, workspaceId: input.workspaceId,
        workflowId: input.workflowId, revision: input.expectedRevision, baseWorkflowVersionId: input.expectedWorkflowVersionId,
        graph: input.graph, agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds, ...locations })
      return { stagedDraft, saveInput, savedWorkflowRevision: input.expectedRevision,
        agentPins: heads.map((row) => ({ agentId: row.id, metadataRevision: Number(row.metadata_revision),
          configurationVersionId: row.current_configuration_version_id })) }
    },
    assertDraft: async (client, principal, intent) => {
      const pins = await readCurrentEditLocationPins(client, principal, intent)
      if (pins.locationRevision !== intent.stagedDraft.locationRevision || pins.locationDigest !== intent.stagedDraft.locationDigest
        || !sameWorkflowValue(pins.runLocationPins, intent.stagedDraft.runLocationPins)) {
        throw new DomainError('CURRENT_EDIT_LOCATION_CONFLICT', 'The workspace/Run location pins or exact affected set changed. The private payload is retained.', 409)
      }
    },
    authorizePublication: async (client, principal, draft: CurrentEditDraft) => {
      // Fresh complete validation and authority BEFORE each Stop and final Save.
      await writer.validate(client, principal, { workspaceId: draft.workspaceId, workflowId: draft.workflowId,
        executionSemanticsVersion: 3, expectedRevision: draft.revision, expectedWorkflowVersionId: draft.baseWorkflowVersionId,
        expectedAgentConfigurationVersionIds: draft.agentConfigurationVersionIds, expectedLocationRevision: draft.locationRevision,
        graph: draft.graph })
    },
    assertStopReady: () => writer.assertStopReady(),
    saveInputHash: (input) => commandInputHash(input), resultScope: (result) => result,
    publish: (principal, source, input, intentId) => writer.publish(principal, source, input, intentId),
  })
}
