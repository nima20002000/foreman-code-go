import { z } from 'zod'
import { IdSchema, TimestampSchema } from '../schemaPrimitives.js'

export const BugReportStatusSchema = z.enum(['open', 'triaged', 'fixed', 'wont-fix'])
export const BugReportSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
const CommandId = z.string().trim().min(8).max(200)
const Text = z.string().trim().min(1).max(12000)

export const BugReportCreateInputSchema = z.object({
  commandId: CommandId,
  workspaceId: IdSchema.optional(),
  title: z.string().trim().min(1).max(300),
  tried: z.object({ feature: z.string().trim().min(1).max(300), inputsSummary: Text }).strict(),
  happened: z.object({ errorCode: z.string().trim().max(300).optional(), message: Text }).strict(),
  expected: Text,
  severity: BugReportSeveritySchema,
  runId: IdSchema.optional(),
  workflowId: IdSchema.optional(),
}).strict()

export const BugReportSchema = BugReportCreateInputSchema.omit({ commandId: true, workspaceId: true }).extend({
  id: IdSchema,
  workspaceId: IdSchema,
  status: BugReportStatusSchema,
  revision: z.number().int().positive(),
  reporter: z.object({
    principalId: IdSchema,
    name: z.string(),
    audience: z.enum(['operator', 'worker', 'user']),
    agentId: IdSchema.optional(),
  }).strict(),
  harness: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastReportedAt: TimestampSchema,
  occurrenceCount: z.number().int().positive(),
}).strict()

export const BugReportListInputSchema = z.object({
  workspaceId: IdSchema.optional(),
  status: BugReportStatusSchema.optional(),
  severity: BugReportSeveritySchema.optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict()
export const BugReportPageSchema = z.object({
  items: z.array(BugReportSchema),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict()
export const BugReportGetInputSchema = z.object({ reportId: IdSchema }).strict()
export const BugReportUpdateInputSchema = BugReportGetInputSchema.extend({
  commandId: CommandId,
  expectedRevision: z.number().int().positive(),
  status: BugReportStatusSchema,
}).strict()
export const BugReportCreateResultSchema = z.object({
  report: BugReportSchema,
  deduplicated: z.boolean(),
  replayed: z.boolean(),
}).strict()
export const BugReportUpdateResultSchema = z.object({ report: BugReportSchema, replayed: z.boolean() }).strict()

export type BugReport = z.infer<typeof BugReportSchema>
export type BugReportStatus = z.infer<typeof BugReportStatusSchema>
export type BugReportSeverity = z.infer<typeof BugReportSeveritySchema>
export type BugReportCreateInput = z.infer<typeof BugReportCreateInputSchema>
export type BugReportListInput = z.input<typeof BugReportListInputSchema>
export type BugReportPage = z.infer<typeof BugReportPageSchema>
export type BugReportUpdateInput = z.infer<typeof BugReportUpdateInputSchema>
export type BugReportCreateResult = z.infer<typeof BugReportCreateResultSchema>
export type BugReportUpdateResult = z.infer<typeof BugReportUpdateResultSchema>

export const BugsSettingsSearchSchema = z.object({
  status: BugReportStatusSchema.optional(),
  severity: BugReportSeveritySchema.optional(),
  reportId: IdSchema.optional(),
}).strict()
export type BugsSettingsSearch = z.infer<typeof BugsSettingsSearchSchema>
