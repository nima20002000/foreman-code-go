import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  AgentChatQuerySchema, AgentChatStateResponseSchema, AgentChatStateSchema, SendAgentChatMessageRequestSchema, SendAgentChatMessageResponseSchema,
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
    description: 'Read the chat for one workflow Agent node, optionally for a finished Run (runId). Returns the conversation, native session, delivery receipts, messages, public activity, capabilities and why sending is blocked. A missing conversation means the first message will create one real native session. Requires agent_chat:read.',
    inputSchema: z.object({ workspaceId: workspace, query: AgentChatQuerySchema }).strict(), outputSchema: AgentChatStateSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, query }) => invokeOperatorTool(context, 'agent_chat_read', () => chat.read(context.principal, workspaceId, query)))
  if (operatorToolAvailable(context, 'agent_chat_send')) server.registerTool('agent_chat_send', {
    description: 'Send a message to a workflow Agent chat. intent next_turn queues after the active turn (or starts now when idle); steer adds input to the active turn only when capabilities.steer allows it and needs expectedNativeTurnId; interrupt_and_send stops the active turn and sends once. Set expectedConversationId to the conversation id read before (null for the first message). Reuse the exact requestId and input after a lost response: the stored receipt is returned and nothing is resent. Never starts or changes a workflow Run. Requires agent_chat:write.',
    inputSchema: z.object({ workspaceId: workspace, request: SendAgentChatMessageRequestSchema }).strict(), outputSchema: SendAgentChatMessageResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, request }) => invokeOperatorTool(context, 'agent_chat_send', () => chat.send(context.principal, workspaceId, request)))
  if (operatorToolAvailable(context, 'agent_chat_interrupt')) server.registerTool('agent_chat_interrupt', {
    description: 'Stop the active chat turn and cancel every queued message in this Agent conversation. Requires agent_chat:cancel.',
    inputSchema: z.object({ workspaceId: workspace, conversationId: conversation, expectedNativeTurnId: z.string().min(1).optional() }).strict(),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, expectedNativeTurnId }) => invokeOperatorTool(context, 'agent_chat_interrupt',
    async () => ({ state: await chat.interrupt(context.principal, workspaceId, conversationId, expectedNativeTurnId) })))
  if (operatorToolAvailable(context, 'agent_chat_cancel_queued')) server.registerTool('agent_chat_cancel_queued', {
    description: 'Cancel one queued Agent chat message before it is sent to the Agent. Fails when it already started. Requires agent_chat:cancel.',
    inputSchema: z.object({ workspaceId: workspace, conversationId: conversation, turnRequestId: z.string().min(1) }).strict(),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, turnRequestId }) => invokeOperatorTool(context, 'agent_chat_cancel_queued',
    async () => ({ state: await chat.cancelQueued(context.principal, workspaceId, conversationId, turnRequestId) })))
  if (operatorToolAvailable(context, 'agent_chat_respond')) server.registerTool('agent_chat_respond', {
    description: 'Answer the pending native approval or input request in an Agent chat with one of its offered options. Requires agent_chat:respond.',
    inputSchema: z.object({ workspaceId: workspace, conversationId: conversation, nativeRequestId: z.string().min(1), optionId: z.string().min(1) }).strict(),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, conversationId, nativeRequestId, optionId }) => invokeOperatorTool(context, 'agent_chat_respond',
    async () => ({ state: await chat.respond(context.principal, workspaceId, conversationId, nativeRequestId, optionId) })))
}
