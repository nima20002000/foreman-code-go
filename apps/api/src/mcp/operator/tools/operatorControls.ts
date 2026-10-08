import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { CancelOperatorTurnRequestSchema, CancelOperatorTurnResponseSchema, RespondOperatorInteractionRequestSchema } from '@foreman-code/contracts'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure } from '../../shared/results.js'

export const OPERATOR_CONTROL_TOOLS = ['operator_chat_cancel', 'operator_chat_respond', 'operator_chat_controls_get', 'operator_chat_controls_update', 'agent_chat_controls_get', 'agent_chat_controls_update'] as const

/** Actual HTTP control services and native receipt fence, including current owner/grant rechecks. */
export function registerOperatorControlTools(server: McpServer, context: OperatorRequestContext) {
  const chat = context.services.operatorChat
  if (!chat) return
  if (operatorToolAvailable(context, 'operator_chat_cancel')) server.registerTool('operator_chat_cancel', {
    description: 'Cancel the exact active model request in your Operator conversation. Pass requestId from readback and reuse commandId with identical input after a lost response. Without commandId the service uses one deterministic receipt for this model request. A cancellation request is not native terminal evidence. Requires operator_chat:cancel and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: CancelOperatorTurnRequestSchema }).strict(),
    outputSchema: CancelOperatorTurnResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ conversationId, request }) => invokeOperatorTool(context, 'operator_chat_cancel', async () => ({
    state: await chat.cancel(conversationId, request.requestId, context.principal, request.commandId, 'mcp'),
  })))
  if (operatorToolAvailable(context, 'operator_chat_respond')) server.registerTool('operator_chat_respond', {
    description: 'Answer the pending native request in your Operator conversation using offered nativeRequestId and '
      + 'optionId plus active model requestId from operator_chat_get. For a standalone session request with no active '
      + 'model request, use nativeRequestId as requestId. For questions and forms, supply response matching '
      + 'the option input schema. Check responseAvailability.available and its message first. Reuse commandId and '
      + 'identical input after response loss. An uncertain response is never resent. '
      + 'Read operator_chat_get activitySnapshot for the saved decision and providerAcknowledged: '
      + 'a recorded answer alone is not delivery confirmation; native consumption may confirm it later. '
      + 'Requires operator_chat:respond and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: RespondOperatorInteractionRequestSchema }).strict(),
    outputSchema: CancelOperatorTurnResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversationId, request }) => invokeOperatorTool(context, 'operator_chat_respond', async () => ({
    state: await chat.respond(conversationId, request, context.principal, 'mcp'),
  })))
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(OPERATOR_CONTROL_TOOLS) }).passthrough() }).passthrough()

/** Preserve authenticated denial audit for direct calls to grant-hidden controls. */
export async function unavailableOperatorControlToolCall(context: OperatorRequestContext, body: unknown) {
  const call = ToolCall.safeParse(body)
  if (!call.success || operatorToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  const composed = name.startsWith('agent_chat_') ? context.services.agentChat : context.services.operatorChat
  const error = composed
    ? new DomainError('ACCESS_DENIED', 'Operator control requires compatible global control and read grants.', 403)
    : new DomainError('OPERATOR_CHAT_UNAVAILABLE', 'Operator chat is not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}
