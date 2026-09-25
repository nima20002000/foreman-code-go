import { z } from 'zod'
import { IdSchema, RunOutcomeSchema } from '../index.js'
import { GraphDraftGetInputSchema } from '../management/index.js'
import { GraphDraftOperationV2Schema, GraphDraftV2Schema, GraphSaveV2InputSchema, GraphSaveV2ResultSchema } from './authoring.js'

/** Private authoring intent. No selected Run, credentials, authority or caller-supplied Stop IDs. */
export const GraphEditStageInputSchema = GraphSaveV2InputSchema.extend({
  action: z.literal('stage_edits'),
  expectedWorkflowVersionId: IdSchema.nullable(),
  operations: z.array(GraphDraftOperationV2Schema).max(100),
}).strict()
export const GraphEditReadInputSchema = GraphDraftGetInputSchema.extend({
  action: z.literal('read_edits'), intentId: IdSchema.optional(),
}).strict()
export const GraphEditCommandInputSchema = GraphDraftGetInputSchema.extend({
  intentId: IdSchema, commandId: IdSchema,
}).strict()
export const GraphEditAdvanceInputSchema = GraphEditCommandInputSchema.extend({ action: z.literal('stop_and_save') }).strict()
export const GraphEditDiscardInputSchema = GraphEditCommandInputSchema.extend({ action: z.literal('discard_edits') }).strict()
export const GraphEditRunPinSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema, runId: IdSchema, workflowVersionId: IdSchema,
  // Affected Runs may be v3 even while the edited board still uses v2 commands.
  executionSemanticsVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  agentConfigurationVersionIds: z.record(z.string(), IdSchema),
}).strict()
export const GraphEditRunStateSchema = z.object({
  pin: GraphEditRunPinSchema, terminal: z.boolean(), settled: z.boolean(),
  outcome: RunOutcomeSchema, cleanupPending: z.boolean(), nativePending: z.boolean(),
  interactionPending: z.boolean(), reviewPending: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.settled !== (value.terminal && !value.cleanupPending && !value.nativePending && !value.interactionPending && !value.reviewPending)) {
    context.addIssue({ code: 'custom', path: ['settled'], message: 'Settlement requires terminal and every obligation to be closed.' })
  }
})
export const GraphEditStopSchema = z.object({
  input: z.object({ workspaceId: IdSchema, runId: IdSchema, commandId: IdSchema }).strict(),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  receipt: z.object({ runId: IdSchema, status: z.enum(['accepted', 'already_terminal', 'not_owner']), processStopped: z.literal(false) }).strict().optional(),
}).strict()
export const GraphEditAgentPinSchema = z.object({
  agentId: IdSchema, metadataRevision: z.number().int().nonnegative().nullable(), configurationVersionId: IdSchema.nullable(),
}).strict()
export const GraphEditIntentSchema = z.object({
  id: IdSchema, ownerPrincipalId: IdSchema,
  workspaceId: IdSchema, workflowId: IdSchema, draftId: IdSchema,
  stageCommandId: IdSchema, stageInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  advanceCommandId: IdSchema, advanceInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  discardCommandId: IdSchema, discardInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedRevision: z.number().int().nonnegative(), savedWorkflowRevision: z.number().int().nonnegative(),
  expectedWorkflowVersionId: IdSchema.nullable(),
  stagedDraft: GraphDraftV2Schema, agentPins: z.array(GraphEditAgentPinSchema),
  affected: z.array(GraphEditRunPinSchema), stops: z.array(GraphEditStopSchema),
  saveInput: GraphSaveV2InputSchema, saveInputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  state: z.enum(['staged', 'stopping', 'waiting', 'saving', 'blocked', 'uncertain', 'saved', 'discarded']),
  saveAttempted: z.boolean(),
  result: GraphSaveV2ResultSchema.optional(),
  error: z.object({ code: z.string(), message: z.string(), uncertain: z.boolean() }).strict().optional(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict().superRefine((value, context) => {
  const error = (message: string) => context.addIssue({ code: 'custom', message })
  const draft = value.stagedDraft
  if (draft.id !== value.draftId || draft.workspaceId !== value.workspaceId || draft.workflowId !== value.workflowId
    || draft.graph.id !== value.workflowId || draft.graph.workspaceId !== value.workspaceId
    || draft.revision !== value.expectedRevision || draft.baseWorkflowVersionId !== value.expectedWorkflowVersionId) error('The exact staged draft identity and revision must match the journal.')
  if (value.saveInput.workspaceId !== value.workspaceId || value.saveInput.workflowId !== value.workflowId
    || value.saveInput.draftId !== value.draftId || value.saveInput.expectedRevision !== value.expectedRevision) error('The save command must use the exact staged scope and revision.')
  const runs = new Set(value.affected.map((pin) => pin.runId))
  if (runs.size !== value.affected.length || value.affected.some((pin) => pin.workspaceId !== value.workspaceId)) error('The affected set must have unique, workspace-bound Run identities.')
  if (new Set(value.stops.map((stop) => stop.input.runId)).size !== value.stops.length
    || value.stops.some((stop) => stop.input.workspaceId !== value.workspaceId || !runs.has(stop.input.runId)
      || (stop.receipt && stop.receipt.runId !== stop.input.runId))) error('A Stop journal must refer only to unique, exactly planned Runs.')
  if ((value.state === 'saved') !== !!value.result || (value.state === 'saved' && !value.saveAttempted)) error('Only an acknowledged saved intent may contain a publication result.')
  if (value.result) {
    const saved = value.result.draft, version = value.result.version
    if (saved.id !== value.draftId || saved.workspaceId !== value.workspaceId || saved.workflowId !== value.workflowId
      || saved.revision !== value.expectedRevision + 1 || saved.publishedRevision !== saved.revision
      || saved.baseWorkflowVersionId !== version.id || version.workspaceId !== value.workspaceId || version.workflowId !== value.workflowId) error('The saved acknowledgement must match the exact draft, revision and immutable version.')
  }
})
export const GraphEditReadResultSchema = z.object({
  intent: GraphEditIntentSchema.nullable(), current: z.array(GraphEditRunStateSchema),
  canStop: z.boolean(), affectedSetChanged: z.boolean(),
}).strict()
export type GraphEditStageInput = z.infer<typeof GraphEditStageInputSchema>
export type GraphEditReadInput = z.infer<typeof GraphEditReadInputSchema>
export type GraphEditAdvanceInput = z.infer<typeof GraphEditAdvanceInputSchema>
export type GraphEditDiscardInput = z.infer<typeof GraphEditDiscardInputSchema>
export type GraphEditIntent = z.infer<typeof GraphEditIntentSchema>
export type GraphEditRunPin = z.infer<typeof GraphEditRunPinSchema>
export type GraphEditRunState = z.infer<typeof GraphEditRunStateSchema>
export type GraphEditReadResult = z.infer<typeof GraphEditReadResultSchema>
