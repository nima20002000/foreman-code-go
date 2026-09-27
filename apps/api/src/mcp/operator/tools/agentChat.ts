import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  InterruptAgentChatRequestSchema, CancelQueuedAgentChatTurnRequestSchema, RespondAgentChatInteractionRequestSchema,
  ReadAgentChatRequestSchema, ReadAgentChatResponseSchema, AgentChatStateResponseSchema, SendAgentChatMessageRequestSchema, SendAgentChatMessageResponseSchema,
} from '@graphql/contracts/agent-chat'

import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

const workspace = z.string().min(1)
const conversation = z.string().min(1)

/** Operator MCP parity for the Board's selected-Agent chat. Same services, receipts and authorization as HTTP. */
export function registerAgentChatTools(server: McpServer, context: OperatorRequestContext): void {
  const chat = context.services.agentChat
  if (!chat) return
  if (operatorToolAvailable(context, 'agent_chat_read')) server.registerTool('agent_chat_read', {
    description: 'Read the chat for one workflow Agent node, optionally for a finished Run (runId). Returns the conversation, native session, delivery receipts, messages, public activity, capabilities and why sending is blocked. A missing conversation means the first message will create one real native session. Pass history: {limit, before?} to retrieve complete messages omitted from the byte-bounded snapshot (including a single oversized message); follow history.nextCursor until null. Pass receipts: {limit, before?} to page all retained delivery receipts; follow receipts.nextCursor until null. Pages are oldest-first and begin with the newest page when before is omitted. hasMoreTurns marks legacy overflow: sending is blocked, not all receipts fit in state.turns, and queued receipts can be canceled with agent_chat_cancel_queued or agent_chat_interrupt. Unconfirmed deliveries are never treated as canceled. Requires agent_chat:read.',
    inputSchema: ReadAgentChatRequestSchema, outputSchema: ReadAgentChatResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, query, history, receipts }) => invokeOperatorTool(context, 'agent_chat_read', async () => {
    const state = await chat.read(context.principal, workspaceId, query)
    const id = state.conversation?.id
    return { ...state,
      ...(id && history ? { history: await chat.history(context.principal, workspaceId, id, history.before, history.limit) } : {}),
      ...(id && receipts ? { receipts: await chat.receipts(context.principal, workspaceId, id, receipts.before, receipts.limit) } : {}),
    }
  }))
  if (operatorToolAvailable(context, 'agent_chat_send')) server.registerTool('agent_chat_send', {
    description: 'Send a message to a workflow Agent chat. intent next_turn queues after the active turn (or starts now when idle); steer adds input to the active turn only when capabilities.steer allows it and needs expectedNativeTurnId; interrupt_and_send stops the active turn and sends once. Set expectedConversationId to the conversation id read before (null for the first message). Reuse the exact requestId and input after a lost response: the stored receipt is returned and nothing is resent. Never starts or changes a workflow Run. Requires agent_chat:write and agent_chat:read.',
    inputSchema: z.object({ workspaceId: workspace, request: SendAgentChatMessageRequestSchema }).strict(), outputSchema: SendAgentChatMessageResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, request }) => invokeOperatorTool(context, 'agent_chat_send', () => chat.send(context.principal, workspaceId, request)))
  if (operatorToolAvailable(context, 'agent_chat_interrupt')) server.registerTool('agent_chat_interrupt', {
    description: 'Stop the active chat turn and cancel every queued message in this Agent conversation. Reuse requestId with identical input after a lost response; uncertain delivery is never resent. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: InterruptAgentChatRequestSchema.extend({ workspaceId: workspace, conversationId: conversation }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, ...request }) => invokeOperatorTool(context, 'agent_chat_interrupt',
    async () => ({ state: await chat.interrupt(context.principal, workspaceId, conversationId, request, 'mcp') })))
  if (operatorToolAvailable(context, 'agent_chat_cancel_queued')) server.registerTool('agent_chat_cancel_queued', {
    description: 'Cancel one queued Agent chat message before it is sent to the Agent. Fails when it already started. Reuse requestId with identical input after a lost response; uncertain delivery is never resent. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: CancelQueuedAgentChatTurnRequestSchema.extend({ workspaceId: workspace, conversationId: conversation, turnRequestId: z.string().min(1) }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, turnRequestId, ...request }) => invokeOperatorTool(context, 'agent_chat_cancel_queued',
    async () => ({ state: await chat.cancelQueued(context.principal, workspaceId, conversationId, turnRequestId, request, 'mcp') })))
  if (operatorToolAvailable(context, 'agent_chat_respond')) server.registerTool('agent_chat_respond', {
    description: 'Answer the pending native approval or input request in an Agent chat with one of its offered options. Reuse requestId with the same choice after a lost response; uncertain delivery is never resent. Requires agent_chat:respond and agent_chat:read.',
    inputSchema: RespondAgentChatInteractionRequestSchema.extend({ workspaceId: workspace, conversationId: conversation }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, ...request }) => invokeOperatorTool(context, 'agent_chat_respond',
    async () => ({ state: await chat.respond(context.principal, workspaceId, conversationId, request, 'mcp') })))
}
