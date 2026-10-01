import { z } from 'zod'

/** Decimal revisions compare only inside the exact same scope. Ordering keys are separate. */
export const ActivityRevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
const id = z.string().min(1)
const timestamp = z.iso.datetime()
export const ActivityNativeIdentitySchema = z.object({ harness: id, sessionId: id, turnId: id.optional(), itemId: id.optional(), generation: id.optional() }).strict()
export type ActivityNativeIdentity = z.infer<typeof ActivityNativeIdentitySchema>
const execution = { workspaceId: id, workflowId: id, runId: id, workflowVersionId: id, executionId: id, attemptKey: id }
const chat = { conversationId: id, requestId: id.optional() }
const agent = { workspaceId: id, workflowId: id, nodeId: id, agentId: id }
export const ActivityScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow_execution'), ...execution }).strict(),
  z.object({ kind: z.literal('operator_chat'), ...chat }).strict(),
  z.object({ kind: z.literal('agent_chat'), ...chat, ...agent }).strict(),
  // This immutable selection is provenance only; it conveys no Run mutation authority.
  z.object({ kind: z.literal('selected_run_chat'), ...chat, ...agent, selection: z.object(execution).strict() }).strict(),
])
export type ActivityScope = z.infer<typeof ActivityScopeSchema>
export const WorkRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execution'), ...execution }).strict(),
  z.object({ kind: z.literal('chat_request'), conversationId: id, requestId: id }).strict(),
  z.object({ kind: z.literal('native_turn'), native: ActivityNativeIdentitySchema }).strict(),
  z.object({ kind: z.literal('tool'), itemId: id, native: ActivityNativeIdentitySchema.optional() }).strict(),
  z.object({ kind: z.literal('subagent'), itemId: id, native: ActivityNativeIdentitySchema.optional() }).strict(),
])
export type WorkRef = z.infer<typeof WorkRefSchema>
export const WorkSummarySchema = z.object({
  ref: WorkRefSchema, phase: z.enum(['preparing', 'active', 'waiting', 'interrupting', 'finalizing', 'terminal']),
  outcome: z.enum(['succeeded', 'failed', 'canceled', 'unknown']).nullable(),
  delivery: z.enum(['queued', 'submitting', 'accepted', 'completed', 'failed', 'canceled', 'unknown']).nullable(),
  evidence: z.enum(['confirmed', 'reconciling', 'unknown']), startedAt: timestamp.nullable(),
  native: ActivityNativeIdentitySchema.optional(),
}).strict()
export type WorkSummary = z.infer<typeof WorkSummarySchema>
export const ActivitySourceSchema = z.object({ schemaVersion: z.literal(1), system: id, eventId: id.optional(), sequence: ActivityRevisionSchema.optional(), observedAt: timestamp.nullable() }).strict()
export type ActivitySource = z.infer<typeof ActivitySourceSchema>
export const InteractionSummarySchema = z.object({
  id, revision: ActivityRevisionSchema, owner: WorkRefSchema, native: ActivityNativeIdentitySchema.optional(),
  delivery: z.enum(['pending', 'answer_recorded', 'delivery_pending', 'uncertain', 'delivered', 'failed', 'canceled']),
  answerRecorded: z.boolean(), providerAcknowledged: z.boolean(), workerAcknowledged: z.boolean(),
  responseAvailability: z.enum(['available', 'recovery_required', 'unavailable', 'unknown']),
}).strict()
export type InteractionSummary = z.infer<typeof InteractionSummarySchema>
const item = { id, revision: ActivityRevisionSchema, order: ActivityRevisionSchema, owner: WorkRefSchema,
  parent: WorkRefSchema.optional(), native: ActivityNativeIdentitySchema.optional(), source: ActivitySourceSchema,
  evidence: z.enum(['confirmed', 'reconciling', 'unknown']) }
export const ActivityItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...item, kind: z.literal('text'), text: z.string(), finality: z.enum(['provisional', 'authoritative_final']) }).strict(),
  z.object({ ...item, kind: z.literal('reasoning_summary'), summary: z.string() }).strict(),
  z.object({ ...item, kind: z.literal('tool'), title: id, status: z.enum(['pending', 'running', 'completed', 'failed', 'canceled', 'unknown']) }).strict(),
  z.object({ ...item, kind: z.literal('subagent'), title: id, status: z.enum(['pending', 'running', 'completed', 'failed', 'canceled', 'unknown']) }).strict(),
  z.object({ ...item, kind: z.literal('interaction'), interaction: InteractionSummarySchema }).strict(),
  z.object({ ...item, kind: z.literal('file_publication'), receiptId: id, fileId: id.optional(), status: z.enum(['pending', 'ready', 'adopted', 'failed', 'unknown']) }).strict(),
  z.object({ ...item, kind: z.literal('diagnostic'), code: id, message: z.string() }).strict(),
])
export type ActivityItem = z.infer<typeof ActivityItemSchema>
export const ActivitySnapshotV1Schema = z.object({
  schemaVersion: z.literal(1), scope: ActivityScopeSchema, revision: ActivityRevisionSchema,
  active: z.array(WorkSummarySchema), queued: z.array(WorkRefSchema), latest: WorkRefSchema.nullable(),
  pendingInteractions: z.array(InteractionSummarySchema), activities: z.array(ActivityItemSchema),
  page: z.object({ before: z.string().nullable(), nextCursor: z.string().nullable(), hasMore: z.boolean() }).strict(),
}).strict()
export type ActivitySnapshotV1 = z.infer<typeof ActivitySnapshotV1Schema>

/** Callers supply chronological owners from durable receipts, not message/audit/transport order. */
export function projectActivityStatus(input: {
  work: readonly WorkSummary[]; queued: readonly WorkRef[]; latest: WorkRef | null
}): Pick<ActivitySnapshotV1, 'active' | 'queued' | 'latest'> {
  return { active: input.work.filter((work) => work.phase !== 'terminal'), queued: [...input.queued], latest: input.latest }
}
