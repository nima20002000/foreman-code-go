import { z } from 'zod'
import {
  ScheduleDisableInputSchema, ScheduleGetInputSchema, ScheduleOccurrenceSchema, ScheduleSaveResultSchema,
} from '@graphql/contracts/schedules'

/** Provisional compositions for omissions in SCH-02; see SCH-03-HANDOFF.md.
 * HTTP and Operator MCP share these. No frozen contract or UI shape is redefined. */
export const ScheduleEnableInputSchema = ScheduleDisableInputSchema
export const ScheduleEnableResultSchema = ScheduleSaveResultSchema.refine((result) => result.value.enabled, {
  path: ['value', 'enabled'], message: 'Enable must return the enabled persisted schedule',
})
export const ScheduleClearInputSchema = ScheduleDisableInputSchema
export const ScheduleClearResultSchema = z.object({ value: z.null(), replayed: z.boolean() }).strict()
export const MAX_OCCURRENCE_PAGE_SIZE = 100
export const ScheduleOccurrenceListInputSchema = ScheduleGetInputSchema.extend({
  cursor: z.string().trim().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(MAX_OCCURRENCE_PAGE_SIZE).default(50),
}).strict()
export const ScheduleOccurrencePageSchema = z.object({
  items: z.array(ScheduleOccurrenceSchema).max(MAX_OCCURRENCE_PAGE_SIZE),
  pageInfo: z.object({ nextCursor: z.string().min(1).max(4096).nullable() }).strict(),
}).strict()
export type ScheduleOccurrenceListInput = z.infer<typeof ScheduleOccurrenceListInputSchema>
export type ScheduleOccurrencePage = z.infer<typeof ScheduleOccurrencePageSchema>
