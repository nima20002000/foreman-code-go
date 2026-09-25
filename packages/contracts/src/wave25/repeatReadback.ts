import { z } from 'zod'
import { IdSchema } from '../index.js'
import { ExpectedRevisionSchema, ManagementPageInfoSchema } from '../management/index.js'
import {
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatDecisionMetadataV1Schema,
  RepeatDecisionV1Schema,
  RepeatOccurrenceV1Schema,
  RepeatWorkflowVersionV1Schema,
} from './repeat.js'

export const RepeatWorkflowReadInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema,
}).strict()
export type RepeatWorkflowReadInput = z.infer<typeof RepeatWorkflowReadInputSchema>

export const RepeatWorkflowReadbackSchema = z.object({
  contractVersion: z.literal(REPEAT_CONTRACT_VERSION),
  executionSemanticsVersion: z.literal(REPEAT_EXECUTION_SEMANTICS_VERSION),
  workspaceId: IdSchema,
  workflowId: IdSchema,
  revision: ExpectedRevisionSchema,
  currentVersionId: IdSchema,
  version: RepeatWorkflowVersionV1Schema,
}).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.version.workspaceId
    || value.workflowId !== value.version.workflowId
    || value.currentVersionId !== value.version.id) {
    context.addIssue({ code: 'custom', message: 'repeat readback identity mismatch' })
  }
})
export type RepeatWorkflowReadback = z.infer<typeof RepeatWorkflowReadbackSchema>

export const RepeatRunReadInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  cursor: IdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  includeResultData: z.boolean().default(false),
}).strict()
export type RepeatRunReadInput = z.infer<typeof RepeatRunReadInputSchema>

export const RepeatOccurrenceReadItemSchema = z.object({
  occurrence: RepeatOccurrenceV1Schema,
  decision: z.union([RepeatDecisionMetadataV1Schema, RepeatDecisionV1Schema]).nullable(),
}).strict().superRefine((value, context) => {
  if (!value.decision) return
  const left = value.occurrence.identity
  const right = value.decision.occurrence.identity
  if (left.scope.runId !== right.scope.runId || left.scope.workflowVersionId !== right.scope.workflowVersionId
    || left.blockId !== right.blockId || left.occurrenceId !== right.occurrenceId
    || left.occurrenceIndex !== right.occurrenceIndex) {
    context.addIssue({ code: 'custom', message: 'occurrence and decision readback identities differ' })
  }
})
export type RepeatOccurrenceReadItem = z.infer<typeof RepeatOccurrenceReadItemSchema>

export const RepeatRunReadbackSchema = z.object({
  contractVersion: z.literal(REPEAT_CONTRACT_VERSION),
  executionSemanticsVersion: z.literal(REPEAT_EXECUTION_SEMANTICS_VERSION),
  workspaceId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  items: z.array(RepeatOccurrenceReadItemSchema).max(100),
  pageInfo: ManagementPageInfoSchema,
}).strict()
export type RepeatRunReadback = z.infer<typeof RepeatRunReadbackSchema>
