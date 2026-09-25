import { z } from 'zod'
import { GraphDigestSchema, GraphIdSchema } from './protocol.js'
import {
  CurrentJournalIdentitySchema, CurrentJournalReadInputSchema as GraphEditReadInputSchema,
  CurrentJournalAdvanceInputSchema as GraphEditAdvanceInputSchema,
  CurrentJournalDiscardInputSchema as GraphEditDiscardInputSchema, CurrentJournalRunStateSchema as GraphEditRunStateSchema,
} from './currentJournal.js'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSavedSchema } from './currentAuthoring.js'
import { sameExecutableWorkflow, sameWorkflowValue } from './meaningfulEdit.js'

/** Full current-v3 payload in the EXISTING private durable edit journal. No
 * selected Run or caller-provided Stop IDs. All graph forms use this one arm. */
export const CurrentEditStageInputSchema = CurrentWorkflowSaveInputSchema.extend({
  action: z.literal('stage_edits'), draftId: GraphIdSchema,
}).strict()
export type CurrentEditStageInput = z.infer<typeof CurrentEditStageInputSchema>
export const CurrentEditReadInputSchema = GraphEditReadInputSchema
export const CurrentEditAdvanceInputSchema = GraphEditAdvanceInputSchema
export const CurrentEditDiscardInputSchema = GraphEditDiscardInputSchema
export const CurrentEditDraftSchema = z.object({
  id: GraphIdSchema, workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  revision: CurrentWorkflowSaveInputSchema.shape.expectedRevision,
  baseWorkflowVersionId: CurrentWorkflowSaveInputSchema.shape.expectedWorkflowVersionId,
  graph: CurrentWorkflowSaveInputSchema.shape.graph,
  agentConfigurationVersionIds: CurrentWorkflowSaveInputSchema.shape.expectedAgentConfigurationVersionIds,
  locationRevision: CurrentWorkflowSaveInputSchema.shape.expectedLocationRevision,
  locationDigest: GraphDigestSchema,
  runLocationPins: z.array(z.object({ runId: GraphIdSchema, digest: GraphDigestSchema }).strict()),
}).strict()
export const CurrentEditIntentSchema = z.object({
  ...CurrentJournalIdentitySchema.shape,
  kind: z.literal('current'), stagedDraft: CurrentEditDraftSchema,
  saveInput: CurrentWorkflowSaveInputSchema, result: CurrentWorkflowSavedSchema.optional(),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  const draft = value.stagedDraft, save = value.saveInput
  if (draft.id !== value.draftId || draft.workspaceId !== value.workspaceId || draft.workflowId !== value.workflowId
    || draft.graph.id !== value.workflowId || draft.graph.workspaceId !== value.workspaceId
    || draft.revision !== value.expectedRevision || value.savedWorkflowRevision !== value.expectedRevision
    || draft.baseWorkflowVersionId !== value.expectedWorkflowVersionId) fail('CURRENT_EDIT_BASE_CONFLICT')
  if (save.workspaceId !== value.workspaceId || save.workflowId !== value.workflowId
    || save.expectedRevision !== value.expectedRevision || save.expectedWorkflowVersionId !== value.expectedWorkflowVersionId
    || !sameWorkflowValue(save.graph, draft.graph)
    || !sameWorkflowValue(save.expectedAgentConfigurationVersionIds, draft.agentConfigurationVersionIds)
    || save.expectedLocationRevision !== draft.locationRevision) fail('CURRENT_EDIT_PAYLOAD_CONFLICT')
  const runs = new Set(value.affected.map((pin) => pin.runId))
  if (runs.size !== value.affected.length || value.affected.some((pin) => pin.workspaceId !== value.workspaceId
    || pin.workflowId !== value.workflowId)) fail('CURRENT_EDIT_AFFECTED_SCOPE_CONFLICT')
  if (new Set(value.stops.map((stop) => stop.input.runId)).size !== value.stops.length
    || value.stops.some((stop) => stop.input.workspaceId !== value.workspaceId || !runs.has(stop.input.runId)
      || stop.receipt && stop.receipt.runId !== stop.input.runId)) fail('CURRENT_EDIT_STOP_SCOPE_CONFLICT')
  const locations = new Set(draft.runLocationPins.map((pin) => pin.runId))
  if (locations.size !== draft.runLocationPins.length || locations.size !== runs.size
    || [...locations].some((id) => !runs.has(id))) fail('CURRENT_EDIT_LOCATION_PINS_CONFLICT')
  const agents = new Set(value.agentPins.map((pin) => pin.agentId))
  if (agents.size !== value.agentPins.length || agents.size !== Object.keys(draft.agentConfigurationVersionIds).length
    || value.agentPins.some((pin) => pin.metadataRevision === null || pin.configurationVersionId === null
      || pin.configurationVersionId !== draft.agentConfigurationVersionIds[pin.agentId])) fail('CURRENT_EDIT_AGENT_PINS_CONFLICT')
  const commands = [value.stageCommandId, value.advanceCommandId, value.discardCommandId, save.commandId,
    ...value.stops.map((stop) => stop.input.commandId)]
  if (new Set(commands).size !== commands.length) fail('CURRENT_EDIT_COMMAND_ID_CONFLICT')
  if ((value.state === 'saved') !== !!value.result || value.state === 'saved' && !value.saveAttempted) fail('CURRENT_EDIT_RESULT_STATE_CONFLICT')
  if (value.result && (value.result.workspaceId !== value.workspaceId || value.result.workflowId !== value.workflowId
    || value.result.revision !== value.expectedRevision + 1 || value.result.currentVersionId === value.expectedWorkflowVersionId
    || !sameExecutableWorkflow(value.result.version.definition, draft.graph)
    || !sameWorkflowValue(value.result.version.agentConfigurationVersionIds, draft.agentConfigurationVersionIds))) fail('CURRENT_EDIT_SAVED_RESULT_CONFLICT')
})
export type CurrentEditIntent = z.infer<typeof CurrentEditIntentSchema>
export type CurrentEditDraft = z.infer<typeof CurrentEditDraftSchema>
export const CurrentEditReadResultSchema = z.object({
  intent: CurrentEditIntentSchema.nullable(), current: z.array(GraphEditRunStateSchema),
  canStop: z.boolean(), affectedSetChanged: z.boolean(),
}).strict()
export const CurrentEditMutationInputSchema = z.discriminatedUnion('action', [
  CurrentEditStageInputSchema, CurrentEditAdvanceInputSchema, CurrentEditDiscardInputSchema,
])
/** Object-root MCP schema; the strict union still rejects substituted Stage
 * payloads, arbitrary Stop IDs, cross-action fields and missing exact pins. */
export const CurrentEditMutationToolInputSchema = z.object({
  ...CurrentWorkflowSaveInputSchema.partial().shape,
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  commandId: CurrentWorkflowSaveInputSchema.shape.commandId,
  action: z.enum(['stage_edits', 'stop_and_save', 'discard_edits']),
  draftId: GraphIdSchema, intentId: GraphIdSchema.optional(),
}).strict().superRefine((input, context) => {
  const parsed = CurrentEditMutationInputSchema.safeParse(input)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
