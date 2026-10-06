import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { JobOrdinaryVerificationSuiteSchema, JobVerificationReportReadSchema } from './jobVerification.js'
import { JobQueueTicketSchema } from './jobAdmission.js'
import { JobExecutionSchema } from './jobs.js'

export const CiRunInputSchema = z.object({
  suite: JobOrdinaryVerificationSuiteSchema,
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  commandId: IdSchema,
}).strict()
export const OperatorCiRunInputSchema = CiRunInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiRunOutputSchema = z.object({ ticketId: IdSchema, executionId: IdSchema.optional() }).strict()
export const CiGetInputSchema = z.object({ ticketId: IdSchema }).strict()
export const OperatorCiGetInputSchema = CiGetInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiGetOutputSchema = z.object({
  queue: JobQueueTicketSchema,
  executionId: IdSchema.nullable(),
  process: JobExecutionSchema.shape.process.nullable(),
  publication: JobExecutionSchema.shape.publication.nullable(),
  resultIssue: JobExecutionSchema.shape.resultIssue,
  summaryReport: JobVerificationReportReadSchema.nullable(),
  logTail: z.object({ text: z.string().max(32768), truncated: z.boolean() }).strict(),
}).strict()
export type CiRunInput = z.infer<typeof CiRunInputSchema>
export type CiGetInput = z.infer<typeof CiGetInputSchema>
