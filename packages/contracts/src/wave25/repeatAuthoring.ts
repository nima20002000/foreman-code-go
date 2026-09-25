import { z } from 'zod'
import { IdSchema } from '../index.js'
import {
  GraphEditAdvanceInputSchema, GraphEditDiscardInputSchema, GraphEditReadInputSchema,
  GraphEditAgentPinSchema, GraphEditRunPinSchema, GraphEditRunStateSchema, GraphEditStopSchema,
} from './editIntent.js'
import { RepeatWorkflowReadInputSchema, RepeatWorkflowReadbackSchema } from './repeatReadback.js'
import { sameWorkflowValue } from './meaningfulEdit.js'
import { CommandIdSchema, ExpectedRevisionSchema } from '../management/index.js'
import {
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatPlanV1Schema,
  RepeatWorkflowVersionV1Schema,
} from './repeat.js'

export const RepeatCapabilityV1Schema = z.object({
  contractVersion: z.literal(REPEAT_CONTRACT_VERSION),
  executionSemanticsVersion: z.literal(REPEAT_EXECUTION_SEMANTICS_VERSION),
  supported: z.literal(true),
  authoring: z.object({
    flatScopesOnly: z.literal(true),
    nesting: z.literal(false),
    arbitraryCycles: z.literal(false),
    maxOccurrencesMin: z.literal(1),
    maxOccurrencesMax: z.literal(2147483647),
    explicitLimitExit: z.literal(true),
    earlyExitOutcome: z.literal(true),
  }).strict(),
}).strict()
export type RepeatCapabilityV1 = z.infer<typeof RepeatCapabilityV1Schema>

export const RepeatCapabilityRequestSchema = z.object({
  workspaceId: IdSchema.optional(),
  workflowId: IdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.workflowId && !value.workspaceId) {
    context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'workspaceId is required when workflowId is provided' })
  }
})
export type RepeatCapabilityRequest = z.infer<typeof RepeatCapabilityRequestSchema>

export const RepeatSaveInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema,
  commandId: CommandIdSchema,
  expectedRevision: ExpectedRevisionSchema,
  expectedWorkflowVersionId: IdSchema,
  executionSemanticsVersion: z.literal(REPEAT_EXECUTION_SEMANTICS_VERSION),
  repeat: RepeatPlanV1Schema,
}).strict()
export type RepeatSaveInput = z.infer<typeof RepeatSaveInputSchema>

export const RepeatSavedWorkflowSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema,
  revision: ExpectedRevisionSchema,
  currentVersionId: IdSchema,
  version: RepeatWorkflowVersionV1Schema,
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId
    || value.workflowId !== value.version.workflowId
    || value.currentVersionId !== value.version.id) {
    context.addIssue({ code: 'custom', message: 'saved repeat scope/version identity mismatch' })
  }
})
export type RepeatSavedWorkflow = z.infer<typeof RepeatSavedWorkflowSchema>

export const RepeatSaveResultSchema = z.object({
  value: RepeatSavedWorkflowSchema,
  replayed: z.boolean(),
}).strict()
export type RepeatSaveResult = z.infer<typeof RepeatSaveResultSchema>

/** Repeat-only private payload of the SAME durable graph-edit journal. draftId
 * is the stable client editor-instance identity, not a graph_drafts row. A v3
 * repeat editor must not create or cast a v2 draft to obtain this identity. */
export const RepeatEditStageInputSchema = RepeatSaveInputSchema.extend({
  action: z.literal('stage_edits'),
  draftId: IdSchema,
  expectedAgentConfigurationVersionIds: z.record(z.string(), IdSchema),
  expectedLocationRevision: ExpectedRevisionSchema,
}).strict()
export type RepeatEditStageInput = z.infer<typeof RepeatEditStageInputSchema>

// These are the existing durable actions and exact command scopes, not new
// Stop commands or a new lifecycle protocol.
export const RepeatEditReadInputSchema = GraphEditReadInputSchema
export const RepeatEditAdvanceInputSchema = GraphEditAdvanceInputSchema
export const RepeatEditDiscardInputSchema = GraphEditDiscardInputSchema
export type RepeatEditReadInput = z.infer<typeof RepeatEditReadInputSchema>
export type RepeatEditAdvanceInput = z.infer<typeof RepeatEditAdvanceInputSchema>
export type RepeatEditDiscardInput = z.infer<typeof RepeatEditDiscardInputSchema>
const EditDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const RepeatEditDraftSchema = z.object({
  id: IdSchema, workspaceId: IdSchema, workflowId: IdSchema,
  revision: ExpectedRevisionSchema, baseWorkflowVersionId: IdSchema,
  repeat: RepeatPlanV1Schema,
  agentConfigurationVersionIds: z.record(z.string(), IdSchema),
  locationRevision: ExpectedRevisionSchema,
  // Content-free pins: no path, device/inode, credential or Run input leaks.
  locationDigest: EditDigestSchema,
  runLocationPins: z.array(z.object({ runId: IdSchema, digest: EditDigestSchema }).strict()),
}).strict()
export type RepeatEditDraft = z.infer<typeof RepeatEditDraftSchema>

export const RepeatEditIntentSchema = z.object({
  kind: z.literal('repeat'),
  id: IdSchema, ownerPrincipalId: IdSchema,
  workspaceId: IdSchema, workflowId: IdSchema, draftId: IdSchema,
  stageCommandId: IdSchema, stageInputHash: EditDigestSchema,
  advanceCommandId: IdSchema, advanceInputHash: EditDigestSchema,
  discardCommandId: IdSchema, discardInputHash: EditDigestSchema,
  expectedRevision: ExpectedRevisionSchema, savedWorkflowRevision: ExpectedRevisionSchema,
  expectedWorkflowVersionId: IdSchema,
  stagedDraft: RepeatEditDraftSchema, agentPins: z.array(GraphEditAgentPinSchema),
  affected: z.array(GraphEditRunPinSchema), stops: z.array(GraphEditStopSchema),
  saveInput: RepeatSaveInputSchema, saveInputHash: EditDigestSchema,
  state: z.enum(['staged', 'stopping', 'waiting', 'saving', 'blocked', 'uncertain', 'saved', 'discarded']),
  saveAttempted: z.boolean(), result: RepeatSavedWorkflowSchema.optional(),
  error: z.object({ code: z.string(), message: z.string(), uncertain: z.boolean() }).strict().optional(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict().superRefine((value, context) => {
  const error = (message: string) => context.addIssue({ code: 'custom', message })
  const draft = value.stagedDraft, save = value.saveInput
  if (draft.id !== value.draftId || draft.workspaceId !== value.workspaceId || draft.workflowId !== value.workflowId
    || draft.revision !== value.expectedRevision || draft.baseWorkflowVersionId !== value.expectedWorkflowVersionId
    || value.savedWorkflowRevision !== value.expectedRevision) error('The private repeat payload must use the exact workflow/editor baseline.')
  if (save.workspaceId !== value.workspaceId || save.workflowId !== value.workflowId
    || save.expectedRevision !== value.expectedRevision || save.expectedWorkflowVersionId !== value.expectedWorkflowVersionId
    || !sameWorkflowValue(save.repeat, draft.repeat)) error('The typed save must contain the exact staged repeat payload and baseline.')
  const runs = new Set(value.affected.map((pin) => pin.runId))
  if (runs.size !== value.affected.length || value.affected.some((pin) => pin.workspaceId !== value.workspaceId
    || pin.workflowId !== value.workflowId)) error('Repeat-only edits affect unique Runs of this exact workflow; no Agent is edited.')
  if (new Set(value.stops.map((stop) => stop.input.runId)).size !== value.stops.length
    || value.stops.some((stop) => stop.input.workspaceId !== value.workspaceId || !runs.has(stop.input.runId)
      || (stop.receipt && stop.receipt.runId !== stop.input.runId))) error('Stop identities must refer only to unique planned Runs.')
  const locations = new Set(draft.runLocationPins.map((pin) => pin.runId))
  if (locations.size !== draft.runLocationPins.length || locations.size !== runs.size
    || [...locations].some((id) => !runs.has(id))) error('Every affected Run requires its exact private location pin.')
  const agents = new Set(value.agentPins.map((pin) => pin.agentId))
  if (agents.size !== value.agentPins.length || agents.size !== Object.keys(draft.agentConfigurationVersionIds).length
    || Object.keys(draft.agentConfigurationVersionIds).some((id) => !agents.has(id))
    || value.agentPins.some((pin) => pin.metadataRevision === null || pin.configurationVersionId === null)) {
    error('Repeat edits must pin each existing Agent head as well as every immutable configuration.')
  }
  const commands = [value.stageCommandId, value.advanceCommandId, value.discardCommandId, save.commandId,
    ...value.stops.map((stop) => stop.input.commandId)]
  if (new Set(commands).size !== commands.length) error('Every durable operation requires a distinct reserved command identity.')
  if ((value.state === 'saved') !== !!value.result || (value.state === 'saved' && !value.saveAttempted)) {
    error('Only an acknowledged saved intent may contain a publication result.')
  }
  if (value.result && (value.result.workspaceId !== value.workspaceId || value.result.workflowId !== value.workflowId
    || value.result.revision !== value.expectedRevision + 1
    || value.result.currentVersionId === value.expectedWorkflowVersionId
    || !sameWorkflowValue(value.result.version.definition.repeat, draft.repeat)
    || !sameWorkflowValue(value.result.version.agentConfigurationVersionIds, draft.agentConfigurationVersionIds))) {
    error('The saved receipt must match the exact repeat, scope, revision and immutable configuration pins.')
  }
})
export type RepeatEditIntent = z.infer<typeof RepeatEditIntentSchema>
export const RepeatEditReadResultSchema = z.object({
  intent: RepeatEditIntentSchema.nullable(), current: z.array(GraphEditRunStateSchema),
  canStop: z.boolean(), affectedSetChanged: z.boolean(),
}).strict()
export type RepeatEditReadResult = z.infer<typeof RepeatEditReadResultSchema>

/** Backwards-compatible repeat_update surface: absence of action means direct
 * save. Strict variants reject Stop IDs, staged payload replacement or restart. */
export const RepeatMutationInputSchema = z.union([
  RepeatSaveInputSchema, RepeatEditStageInputSchema, RepeatEditAdvanceInputSchema, RepeatEditDiscardInputSchema,
])
export type RepeatMutationInput = z.infer<typeof RepeatMutationInputSchema>
export const RepeatMutationResultSchema = z.union([RepeatSaveResultSchema, RepeatEditReadResultSchema])
export type RepeatMutationResult = z.infer<typeof RepeatMutationResultSchema>

export const RepeatEditMutationInputSchema = z.discriminatedUnion('action', [
  RepeatEditStageInputSchema, RepeatEditAdvanceInputSchema, RepeatEditDiscardInputSchema,
])
export type RepeatEditMutationInput = z.infer<typeof RepeatEditMutationInputSchema>

/** Object-root tool schema for MCP. Refinement reuses the strict action union;
 * optional fields do not permit an action to smuggle another action's fields. */
export const RepeatMutationToolInputSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, commandId: CommandIdSchema,
  action: z.enum(['stage_edits', 'stop_and_save', 'discard_edits']).optional(),
  draftId: IdSchema.optional(), intentId: IdSchema.optional(),
  expectedRevision: ExpectedRevisionSchema.optional(), expectedWorkflowVersionId: IdSchema.optional(),
  executionSemanticsVersion: z.literal(3).optional(), repeat: RepeatPlanV1Schema.optional(),
  expectedAgentConfigurationVersionIds: z.record(z.string(), IdSchema).optional(),
  expectedLocationRevision: ExpectedRevisionSchema.optional(),
}).strict().superRefine((value, context) => {
  const parsed = RepeatMutationInputSchema.safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
export const RepeatMutationToolResultSchema = z.object({
  value: RepeatSavedWorkflowSchema.optional(), replayed: z.boolean().optional(),
  intent: RepeatEditIntentSchema.nullable().optional(), current: z.array(GraphEditRunStateSchema).optional(),
  canStop: z.boolean().optional(), affectedSetChanged: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (!RepeatMutationResultSchema.safeParse(value).success) context.addIssue({ code: 'custom', message: 'Expected an exact direct-save receipt or private edit-intent readback.' })
})

export const RepeatGetInputSchema = z.union([RepeatWorkflowReadInputSchema, RepeatEditReadInputSchema])
export const RepeatGetResultSchema = z.union([RepeatWorkflowReadbackSchema, RepeatEditReadResultSchema])
export type RepeatGetInput = z.infer<typeof RepeatGetInputSchema>
export type RepeatGetResult = z.infer<typeof RepeatGetResultSchema>
export const RepeatGetToolInputSchema = RepeatWorkflowReadInputSchema.extend({
  action: z.literal('read_edits').optional(), draftId: IdSchema.optional(), intentId: IdSchema.optional(),
}).strict().superRefine((value, context) => {
  const parsed = RepeatGetInputSchema.safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
export const RepeatGetToolResultSchema = z.object({
  contractVersion: z.literal(1).optional(), executionSemanticsVersion: z.literal(3).optional(),
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), revision: ExpectedRevisionSchema.optional(),
  currentVersionId: IdSchema.optional(), version: RepeatWorkflowVersionV1Schema.optional(),
  intent: RepeatEditIntentSchema.nullable().optional(), current: z.array(GraphEditRunStateSchema).optional(),
  canStop: z.boolean().optional(), affectedSetChanged: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (!RepeatGetResultSchema.safeParse(value).success) context.addIssue({ code: 'custom', message: 'Expected saved repeat readback or exact private edit-intent state.' })
})
