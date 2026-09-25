import type pg from 'pg'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import {
  RepeatEditDraftSchema, RepeatEditIntentSchema, RepeatEditReadResultSchema, RepeatEditStageInputSchema,
  RepeatSavedWorkflowSchema, sameWorkflowValue,
  type RepeatEditDraft, type RepeatEditIntent, type RepeatEditStageInput,
  type RepeatSaveInput, type RepeatWorkflowVersionV1,
} from '@graphql/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockAgentConfigurations } from '../workspaces/agentConfiguration.js'
import { DurableEditIntentService, type EditIntentSource } from './durableEditIntent.js'

type Scope = { workspaceId: string; workflowId: string }
export interface RepeatEditWriter {
  /** Validation and locks only: this MUST NOT write a version or call Stop. */
  validate(client: pg.PoolClient, principal: ManagementPrincipal, input: Omit<RepeatSaveInput, 'commandId'>): Promise<RepeatWorkflowVersionV1>
  publish(principal: ManagementPrincipal, source: EditIntentSource, input: RepeatSaveInput, intentId: string): Promise<unknown>
  /** Composition capability only. Settlement is ALWAYS read from saveAdmission. */
  repeatStopReady(): boolean
}

function authorize(principal: ManagementPrincipal, scope: Scope, write: boolean) {
  requireAuthorization(principal, 'workflows:read', scope)
  requireAuthorization(principal, 'agents:read', scope)
  requireAuthorization(principal, 'workspace_locations:read', { workspaceId: scope.workspaceId })
  if (write) requireAuthorization(principal, 'workflows:update', scope)
}

/** Pins include private location identity without exposing paths or device IDs.
 * Call only under the existing workspace admission / workflow publication locks.
 * Terminal/progress fields are deliberately excluded from these immutable pins. */
export async function readRepeatEditLocationPins(client: pg.PoolClient, principal: ManagementPrincipal, scope: Scope) {
  const workspace = (await client.query<{
    location_revision: string; execution_location: unknown; execution_location_identity: unknown
  }>(`select location_revision::text,execution_location,execution_location_identity
    from workspaces where id=$1 for share`, [scope.workspaceId])).rows[0]
  const revision = Number(workspace?.location_revision)
  if (!workspace || !Number.isSafeInteger(revision) || revision < 0) {
    throw new DomainError('LOCATION_REVISION_CONFLICT', 'The workspace location pin is unavailable.', 409)
  }
  const rows = await client.query<{
    id: string; workspace_id: string; workflow_id: string; workflow_version_id: string
    runner_id: string | null; working_directory: string | null; location_revision: string | null; execution_location: unknown
  }>(`select id,workspace_id,workflow_id,workflow_version_id,runner_id,working_directory,
      location_revision::text,record->'executionLocation' as execution_location
    from runs where workspace_id=$1 and workflow_id=$2 order by id for share`, [scope.workspaceId, scope.workflowId])
  const runLocationPins = rows.rows.map((row) => {
    requireAuthorization(principal, 'runs:read', { ...scope, runId: row.id })
    if (row.workspace_id !== scope.workspaceId || row.workflow_id !== scope.workflowId) {
      throw new DomainError('GRAPH_EDIT_INTENT_INVALID', 'An affected Run location is outside the exact scope.', 409)
    }
    return { runId: row.id, digest: commandInputHash(row) }
  })
  return { locationRevision: revision, locationDigest: commandInputHash(workspace), runLocationPins }
}

export function createRepeatEditIntentService(pool: pg.Pool, commands: PostgresCommandCoordinator, writer: RepeatEditWriter) {
  return new DurableEditIntentService<RepeatEditStageInput, RepeatEditIntent>(pool, commands, {
    kind: 'repeat', stageSchema: RepeatEditStageInputSchema, intentSchema: RepeatEditIntentSchema,
    readResultSchema: RepeatEditReadResultSchema, resultSchema: RepeatSavedWorkflowSchema,
    authorize, authorizeContent: () => undefined,
    stagedAgentIds: () => [], // Repeat rules never edit a shared Agent.
    prepare: async (client, principal, input, saveCommandId) => {
      const saveInput: RepeatSaveInput = { workspaceId: input.workspaceId, workflowId: input.workflowId,
        expectedRevision: input.expectedRevision, expectedWorkflowVersionId: input.expectedWorkflowVersionId,
        executionSemanticsVersion: 3, commandId: saveCommandId, repeat: input.repeat }
      const version = await writer.validate(client, principal, saveInput)
      if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) {
        throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'Stage requires the exact displayed immutable configuration pins.', 409)
      }
      const agentIds = Object.keys(version.agentConfigurationVersionIds).sort()
      await lockAgentConfigurations(client, agentIds)
      const heads = await client.query<{ id: string; metadata_revision: string; current_configuration_version_id: string | null }>(
        `select id,metadata_revision::text,current_configuration_version_id from agents
         where workspace_id=$1 and id=any($2::text[]) and archived_at is null order by id for share`, [input.workspaceId, agentIds])
      if (heads.rows.length !== agentIds.length || heads.rows.some((row, index) => row.id !== agentIds[index]
        || row.current_configuration_version_id === null || !Number.isSafeInteger(Number(row.metadata_revision))
        || Number(row.metadata_revision) < 0)) {
        throw new DomainError('AGENT_REVISION_CONFLICT', 'Every repeat Agent requires an exact live metadata/configuration head.', 409)
      }
      const locations = await readRepeatEditLocationPins(client, principal, input)
      if (locations.locationRevision !== input.expectedLocationRevision) {
        throw new DomainError('LOCATION_REVISION_CONFLICT', 'The displayed workspace location changed before Stage.', 409)
      }
      const stagedDraft = RepeatEditDraftSchema.parse({ id: input.draftId, workspaceId: input.workspaceId,
        workflowId: input.workflowId, revision: input.expectedRevision, baseWorkflowVersionId: input.expectedWorkflowVersionId,
        repeat: input.repeat, agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds, ...locations })
      return { stagedDraft, savedWorkflowRevision: input.expectedRevision, saveInput,
        agentPins: heads.rows.map((row) => ({ agentId: row.id, metadataRevision: Number(row.metadata_revision),
          configurationVersionId: row.current_configuration_version_id })) }
    },
    assertDraft: async (client, principal, intent) => {
      const locations = await readRepeatEditLocationPins(client, principal, intent)
      if (locations.locationRevision !== intent.stagedDraft.locationRevision
        || locations.locationDigest !== intent.stagedDraft.locationDigest
        || !sameWorkflowValue(locations.runLocationPins, intent.stagedDraft.runLocationPins)) {
        throw new DomainError('REPEAT_EDIT_LOCATION_CONFLICT',
          'An exact workspace/Run location pin or affected Run set changed. The private payload and commands remain staged.', 409)
      }
    },
    authorizePublication: async (client, principal, draft: RepeatEditDraft) => {
      // Fresh skill/harness/publication authority and candidate validation before
      // EACH Stop as well as final publication. This method performs no writes.
      const version = await writer.validate(client, principal, { workspaceId: draft.workspaceId, workflowId: draft.workflowId,
        expectedRevision: draft.revision, expectedWorkflowVersionId: draft.baseWorkflowVersionId,
        executionSemanticsVersion: 3, repeat: draft.repeat })
      if (!sameWorkflowValue(version.agentConfigurationVersionIds, draft.agentConfigurationVersionIds)) {
        throw new DomainError('AGENT_CONFIGURATION_CONFLICT', 'The exact staged immutable configuration pins changed.', 409)
      }
    },
    assertStopReady: (pin) => {
      if (pin.executionSemanticsVersion === 3 && !writer.repeatStopReady()) throw new DomainError('REPEAT_STOP_NOT_READY',
        'Native semantics-3 Stop/closure integration is not registered. Keep this intent; no Stop was submitted.', 409)
    },
    // The database typed writer requires the original repeat.save payload/hash,
    // not a graph-save hash with an extra editIntentId property.
    saveInputHash: (input) => commandInputHash(input),
    resultScope: (result) => result,
    publish: (principal, source, input, intentId) => writer.publish(principal, source, input, intentId),
  })
}
