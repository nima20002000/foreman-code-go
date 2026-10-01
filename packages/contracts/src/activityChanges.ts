import { z } from 'zod'
import { ActivityItemSchema, ActivityNativeIdentitySchema, ActivitySourceSchema, InteractionSummarySchema, WorkRefSchema, WorkSummarySchema } from './activity.js'
const id = z.string().min(1)
export const ActivityOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat_request'), conversationId: id, requestId: id }).strict(),
  z.object({ kind: z.literal('execution'), workspaceId: id, workflowId: id, runId: id, workflowVersionId: id, executionId: id, attemptKey: id }).strict(),
])
export type ActivityOwner = z.infer<typeof ActivityOwnerSchema>
/** Notification envelope; existing receipts remain the sole authority for effects and delivery. */
export const ActivityChangeEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1), owner: ActivityOwnerSchema, native: ActivityNativeIdentitySchema.optional(), source: ActivitySourceSchema,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text.append'), itemId: id, text: z.string(), finality: z.literal('provisional') }).strict(),
    z.object({ kind: z.literal('text.replace'), itemId: id, text: z.string(), finality: z.enum(['provisional', 'authoritative_final']) }).strict(),
    z.object({ kind: z.literal('item.upsert'), item: ActivityItemSchema }).strict(),
    z.object({ kind: z.literal('provider-turn.observed'), work: WorkSummarySchema }).strict(),
    z.object({ kind: z.literal('interaction.changed'), interaction: InteractionSummarySchema }).strict(),
    z.object({ kind: z.literal('publication.changed'), owner: WorkRefSchema, receiptId: id }).strict(),
  ]),
}).strict()
export type ActivityChangeEnvelopeV1 = z.infer<typeof ActivityChangeEnvelopeV1Schema>
