import { z } from 'zod'

/** Read projection only. Neither a recorded answer nor a callback is delivery evidence. */
export const InteractionActivityProjectionSchema = z.object({
  interactionId: z.string().min(1), revision: z.string().regex(/^\d+$/),
  owner: z.object({ workspaceId: z.string(), workflowId: z.string(), runId: z.string(),
    executionId: z.string(), agentId: z.string() }).strict(),
  native: z.object({ harness: z.string(), sessionId: z.string(), requestId: z.string(),
    turnId: z.string().optional(), messageId: z.string().optional() }).strict(),
  phase: z.enum(['needs_answer', 'answer_recorded', 'delivery_pending', 'uncertain', 'delivered', 'failed', 'canceled']),
  answerRecorded: z.boolean(),
  nativeDelivery: z.enum(['not_started', 'pending', 'submitted', 'uncertain', 'delivered', 'failed']),
  workerAcknowledgment: z.enum(['confirmed', 'unknown']),
  response: z.object({ available: z.boolean(), path: z.enum(['live_callback', 'qualified_recovery']).nullable(),
    reason: z.enum(['available', 'not_pending', 'unauthorized', 'unqualified', 'callback_unavailable', 'identity_mismatch']) }).strict(),
}).strict()
export type InteractionActivityProjection = z.infer<typeof InteractionActivityProjectionSchema>
