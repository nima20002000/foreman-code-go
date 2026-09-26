import { z } from 'zod'
import { CommandIdSchema, ExpectedRevisionSchema, WorkflowCreateInputSchema, ManagedAgentSchema } from '../management/index.js'
import { GraphIdSchema } from './protocol.js'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from './saved.js'

/** Metadata-only creation selects current semantics by product policy, never
 * complexity. An explicit retired/unknown tag fails before any command work. */
export const CurrentWorkflowCreateInputSchema = WorkflowCreateInputSchema.extend({
  executionSemanticsVersion: z.literal(3).optional(),
}).strict()
export type CurrentWorkflowCreateInput = z.infer<typeof CurrentWorkflowCreateInputSchema>

/** One complete authored definition, not a complexity-selected mode, patch,
 * admission permit or caller-supplied WorkflowVersion. Shared by HTTP/MCP/Board.
 * Configurations are references to actual current immutable Agent rows; saving
 * this graph never edits a shared Agent or changes an accepted Run. */
export const CurrentWorkflowValidateInputSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  executionSemanticsVersion: z.literal(3),
  expectedRevision: ExpectedRevisionSchema,
  expectedWorkflowVersionId: GraphIdSchema.nullable(),
  expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  expectedLocationRevision: ExpectedRevisionSchema,
  graph: WorkflowDefinitionV3Schema,
}).strict()
export const CurrentWorkflowSaveInputSchema = CurrentWorkflowValidateInputSchema.extend({
  commandId: CommandIdSchema,
}).strict()
export type CurrentWorkflowSaveRequest = z.input<typeof CurrentWorkflowSaveInputSchema>
export type CurrentWorkflowSaveInput = z.infer<typeof CurrentWorkflowSaveInputSchema>
export type CurrentWorkflowValidateInput = z.infer<typeof CurrentWorkflowValidateInputSchema>
export const CurrentWorkflowSavedSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, revision: ExpectedRevisionSchema,
  currentVersionId: GraphIdSchema, version: WorkflowVersionV3Schema,
  agents: z.array(ManagedAgentSchema).optional(),
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId || value.workflowId !== value.version.workflowId
    || value.currentVersionId !== value.version.id) context.addIssue({ code: 'custom', message: 'WORKFLOW_SAVED_PIN_MISMATCH' })
})
export const CurrentWorkflowSaveResultSchema = z.object({ value: CurrentWorkflowSavedSchema, replayed: z.boolean() }).strict()
export const CurrentWorkflowReadInputSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema,
  // Omit for the current saved version; supply for exact immutable history.
  workflowVersionId: GraphIdSchema.optional(),
}).strict()
export const CurrentWorkflowValidationSchema = z.object({
  valid: z.literal(true), executionSemanticsVersion: z.literal(3),
  expectedRevision: ExpectedRevisionSchema, expectedWorkflowVersionId: GraphIdSchema.nullable(),
  expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
  expectedLocationRevision: ExpectedRevisionSchema,
  // Validation is neither persistence nor native/Stop qualification.
  runtimeAdmission: z.boolean(), stopAvailable: z.boolean(),
}).strict()
export const CurrentWorkflowReadResultSchema = z.object({
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, revision: ExpectedRevisionSchema,
  currentVersionId: GraphIdSchema, version: WorkflowVersionV3Schema,
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId || value.workflowId !== value.version.workflowId) {
    context.addIssue({ code: 'custom', message: 'WORKFLOW_VERSION_PIN_MISMATCH' })
  }
})
export const CURRENT_WORKFLOW_ROUTES = Object.freeze({
  capabilities: '/api/management/workflows/capabilities/v3',
  saved: '/api/management/workspaces/:workspaceId/workflows/:workflowId/definition',
  validate: '/api/management/workspaces/:workspaceId/workflows/:workflowId/definition/validate',
  edits: '/api/management/workspaces/:workspaceId/workflows/:workflowId/definition/edits',
})
export const CURRENT_WORKFLOW_TOOLS = Object.freeze({
  capabilities: 'workflow_authoring_capabilities_v3',
  saved: 'workflow_saved_get_v3', validate: 'workflow_validate_v3', save: 'workflow_save_v3',
  edits: 'workflow_edit_v3', editRead: 'workflow_edits_get_v3',
})
export const CurrentWorkflowCapabilitiesSchema = z.object({
  executionSemanticsVersion: z.literal(3), repeatOptional: z.literal(true),
  forms: z.tuple([z.literal('sequential'), z.literal('parallel_all_required'), z.literal('conditional'),
    z.literal('approval'), z.literal('bounded_repeat')]),
  savedAuthoring: z.literal(true), persistedReadback: z.literal(true),
  runtimeAdmission: z.boolean(), stopAvailable: z.boolean(), meaningfulEdit: z.boolean(),
  editIntents: z.object({ stage: z.literal(true), read: z.literal(true), discard: z.literal(true),
    publishWhenSettled: z.literal(true), stopUnsettled: z.boolean(), stagedAgents: z.literal(true) }).strict(),
  reasons: z.array(z.enum(['NATIVE_START_NOT_READY', 'NATIVE_STOP_CLEANUP_NOT_READY'])).max(2),
  repeatLimits: z.object({ nesting: z.literal(false), arbitraryCycles: z.literal(false),
    minimumOccurrences: z.literal(1), maximumOccurrences: z.literal(2147483647),
    explicitLimitExit: z.literal(true), executionBudgetAlsoApplies: z.literal(true) }).strict(),
  tools: z.object({ capabilities: z.literal(CURRENT_WORKFLOW_TOOLS.capabilities),
    saved: z.literal(CURRENT_WORKFLOW_TOOLS.saved), validate: z.literal(CURRENT_WORKFLOW_TOOLS.validate),
    save: z.literal(CURRENT_WORKFLOW_TOOLS.save), edits: z.literal(CURRENT_WORKFLOW_TOOLS.edits),
    editRead: z.literal(CURRENT_WORKFLOW_TOOLS.editRead) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.meaningfulEdit !== value.stopAvailable || value.editIntents.stopUnsettled !== value.stopAvailable
    || new Set(value.reasons).size !== value.reasons.length
    || value.reasons.includes('NATIVE_START_NOT_READY') === value.runtimeAdmission
    || value.reasons.includes('NATIVE_STOP_CLEANUP_NOT_READY') === value.stopAvailable) {
    context.addIssue({ code: 'custom', message: 'CURRENT_WORKFLOW_CAPABILITY_CONFLICT' })
  }
})
export const CURRENT_WORKFLOW_CAPABILITIES = CurrentWorkflowCapabilitiesSchema.parse({
  executionSemanticsVersion: 3, repeatOptional: true,
  forms: ['sequential', 'parallel_all_required', 'conditional', 'approval', 'bounded_repeat'],
  savedAuthoring: true, persistedReadback: true, runtimeAdmission: false, stopAvailable: false, meaningfulEdit: false,
  editIntents: { stage: true, read: true, discard: true, publishWhenSettled: true, stopUnsettled: false, stagedAgents: true },
  reasons: ['NATIVE_START_NOT_READY', 'NATIVE_STOP_CLEANUP_NOT_READY'],
  repeatLimits: { nesting: false, arbitraryCycles: false, minimumOccurrences: 1,
    maximumOccurrences: 2147483647, explicitLimitExit: true, executionBudgetAlsoApplies: true },
  tools: CURRENT_WORKFLOW_TOOLS,
})
