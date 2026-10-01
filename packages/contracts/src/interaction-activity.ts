import { z } from 'zod'

/** Read projection only. Neither a recorded answer nor a callback is delivery evidence. */
export const InteractionActivityProjectionSchema = z.object({
  interactionId: z.string().min(1), revision: z.string().regex(/^\d+$/),
  owner: z.object({ workspaceId: z.string(), workflowId: z.string(), runId: z.string(),
    executionId: z.string(), agentId: z.string() }).strict(),
  native: z.object({ harness: z.string(), sessionId: z.string(), requestId: z.string(),
    turnId: z.string().optional() }).strict(),
  phase: z.enum(['needs_answer', 'answer_recorded', 'delivery_pending', 'uncertain', 'delivered', 'failed', 'canceled']),
  answerRecorded: z.boolean(),
  nativeDelivery: z.enum(['not_started', 'pending', 'submitted', 'uncertain', 'delivered', 'failed']),
  workerAcknowledgment: z.enum(['confirmed', 'unknown']),
  response: z.object({ available: z.boolean(), path: z.enum(['live_callback', 'qualified_recovery']).nullable(),
    reason: z.enum(['available', 'not_pending', 'unauthorized', 'unqualified', 'callback_unavailable', 'identity_mismatch']) }).strict(),
}).strict()
export type InteractionActivityProjection = z.infer<typeof InteractionActivityProjectionSchema>

/** Action qualification changes independently of the durable interaction or conversation revision. */
export const NativeInteractionResponseAvailabilitySchema = z.object({
  nativeSessionId: z.string().min(1), nativeRequestId: z.string().min(1).optional(),
  nativeRequestType: z.string().min(1), nativeTurnId: z.string().min(1).optional(),
  available: z.boolean(), status: z.enum(['available', 'recovery_required', 'unavailable']),
  path: z.enum(['live_callback', 'qualified_recovery']).nullable(), generation: z.string().min(1).optional(),
  reason: z.enum(['live_callback', 'qualified_recovery', 'request_consumed', 'callback_lost', 'session_closed',
    'unqualified', 'identity_mismatch', 'response_in_flight', 'unsupported', 'unauthorized', 'missing_request_identity']),
  message: z.string().min(1),
}).strict()
export type NativeInteractionResponseAvailability = z.infer<typeof NativeInteractionResponseAvailabilitySchema>
