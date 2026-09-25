import { z } from 'zod'
import { IdSchema } from '../index.js'
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
