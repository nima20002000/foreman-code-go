import { z } from 'zod'
import { ActivityScopeSchema } from './activity.js'

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

/** Accepted caller choice on the existing control receipt. This is not a native delivery or model-turn receipt. */
export const AcceptedChatResponseControlSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('respond'), conversationId: z.string().min(1), modelRequestId: z.string().min(1),
  scope: ActivityScopeSchema,
  native: z.object({ harness: z.string().min(1), providerVersion: z.string().min(1).optional(), sessionId: z.string().min(1),
    turnId: z.string().min(1).optional(), messageId: z.string().min(1).optional(), generation: z.string().min(1).optional(),
    requestId: z.string().min(1), requestType: z.string().min(1) }).strict(),
  choice: z.object({ optionId: z.string().min(1), semantic: z.string().min(1), response: z.json().optional() }).strict(),
}).strict().superRefine((value, context) => {
  const native = value.native
  if (native.harness === 'claude') {
    if (!native.messageId || !native.generation || native.turnId !== undefined) {
      context.addIssue({ code: 'custom', path: ['native'], message: 'Claude control requires its observed message identity and callback generation.' })
    }
  } else if (!native.turnId || native.messageId !== undefined || native.generation !== undefined) {
    context.addIssue({ code: 'custom', path: ['native'], message: 'This native provider requires its observed turn identity.' })
  }
  if (!['operator_chat', 'agent_chat', 'selected_run_chat'].includes(value.scope.kind)
    || !('conversationId' in value.scope) || value.scope.conversationId !== value.conversationId) {
    context.addIssue({ code: 'custom', message: 'Control metadata must retain the exact conversation scope.' })
  }
})
export type AcceptedChatResponseControl = z.infer<typeof AcceptedChatResponseControlSchema>

export const ChatResponseAcknowledgmentSchema = z.object({
  source: z.enum(['provider_acknowledgement', 'provider_history']), harness: z.string().min(1), providerVersion: z.string().min(1),
  nativeSessionId: z.string().min(1), nativeRequestId: z.string().min(1), nativeRequestType: z.string().min(1),
  optionId: z.string().min(1), semantic: z.string().min(1),
}).strict()
export type ChatResponseAcknowledgment = z.infer<typeof ChatResponseAcknowledgmentSchema>
