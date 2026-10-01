import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import { CancelOperatorTurnRequestSchema, CancelOperatorTurnResponseSchema, RespondOperatorInteractionRequestSchema } from '@graphql/contracts'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable } from '../availability.js'
import { invokeOperatorTool } from '../invoke.js'

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
    description: 'Answer the exact qualified native request in your Operator conversation using offered nativeRequestId and optionId plus active model requestId from operator_chat_get. Check responseAvailability.available and its message first. Reuse commandId and identical input after response loss; without commandId the exact native question has one deterministic receipt. An uncertain response is never resent. Requires operator_chat:respond and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: RespondOperatorInteractionRequestSchema }).strict(),
    outputSchema: CancelOperatorTurnResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversationId, request }) => invokeOperatorTool(context, 'operator_chat_respond', async () => ({
    state: await chat.respond(conversationId, request, context.principal, 'mcp'),
  })))
}
