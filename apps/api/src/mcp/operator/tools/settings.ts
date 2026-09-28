import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { OperatorChatSetupSchema, CreateOperatorConversationRequestSchema, CreateOperatorConversationResponseSchema,
  GetOperatorConversationResponseSchema, SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema } from '@graphql/contracts'
import { OperatorHandoffHistoryPageSchema, OperatorHistoryCursorSchema } from '@graphql/contracts/operator-chat'

import {
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@graphql/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerSettingsTools(server: McpServer, context: OperatorRequestContext): void {
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_create')) server.registerTool('operator_chat_create', {
    description: 'Create an owner-bound Operator conversation using the current saved Operator defaults. Requires operator_chat:write.',
    inputSchema: CreateOperatorConversationRequestSchema, outputSchema: CreateOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'operator_chat_create', async () => ({ conversation: await context.services.operatorChat!.create(context.principal, input.title) })))
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_get')) server.registerTool('operator_chat_get', {
    description: 'Read an owned Operator conversation, including its harness handoff parent and persisted messages. Requires operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1) }).strict(), outputSchema: GetOperatorConversationResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversationId }) => invokeOperatorTool(context, 'operator_chat_get', () => context.services.operatorChat!.get(conversationId, context.principal)))
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_send')) server.registerTool('operator_chat_send', {
    description: 'Send an owned Operator message. Reserve configurationVersionId from operator_chat_get. For a different harness, also supply forkExpectedRevision and defaultsRevision from agent_defaults_get; existing chats retain their access policy. Reuse the exact request ID and command fields after a lost response. Set recovery to receipt to read acceptance without starting or retrying native work; OPERATOR_RECEIPT_NOT_FOUND is not proof of non-delivery. Requires operator_chat:write.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: SendOperatorMessageRequestSchema }).strict(),
    outputSchema: SendOperatorMessageResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversationId, request }) => invokeOperatorTool(context, 'operator_chat_send', () => context.services.operatorChat!.send(conversationId, request, context.principal)))
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_handoff_history_get')) server.registerTool('operator_handoff_history_get', {
    description: 'Read older user and assistant text from an ancestor of this credential-bound fork, up to its frozen handoff cutoff. This tool cannot read other conversations or tool/approval payloads. Requires the delegated operator_handoff:read grant.',
    inputSchema: z.object({ sourceConversationId: z.string().min(1).optional(), before: OperatorHistoryCursorSchema.optional() }).strict(),
    outputSchema: OperatorHandoffHistoryPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ sourceConversationId, before }) => invokeOperatorTool(context, 'operator_handoff_history_get', () => context.services.operatorChat!.handoffHistory(context.principal, sourceConversationId, before)))
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_mcp_setup_get')) server.registerTool('operator_mcp_setup_get', {
    description: 'Check the saved Operator harness for the required enabled graphql MCP launcher (automatic instance routing) or legacy endpoint and credential environment reference. This checks installation only; it does not install MCP, issue credentials, or prove provider authentication.',
    inputSchema: z.object({}).strict(), outputSchema: OperatorChatSetupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'operator_mcp_setup_get', () => context.services.operatorChat!.setup(context.principal)))
  const settings = context.services.settings
  if (!settings) return
  if (operatorToolAvailable(context, 'agent_defaults_get')) server.registerTool('agent_defaults_get', {
    description: 'Read saved role defaults, including the Operator chat model, harness, Codex sandbox or OpenCode permission rules, effort, and thinking preferences. New Operator conversations inherit these settings. Operator UI enablement does not disable management MCP.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'agent_defaults_get', () => settings.getAgentDefaults(context.principal)))
  if (operatorToolAvailable(context, 'workflow_defaults_get')) server.registerTool('workflow_defaults_get', {
    description: 'Read defaults copied into newly created workflows, including approval routing. Graph edges do not grant approval authority.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'workflow_defaults_get', () => settings.getWorkflowDefaults(context.principal)))
  if (operatorToolAvailable(context, 'agent_defaults_update')) server.registerTool('agent_defaults_update', {
    description: 'Revision-check and replace role defaults, including the Operator sandbox or permission rules shared by chat and Settings > Agents > Operator. New conversations inherit Operator changes; running turns and accepted Runs remain pinned. Requires global settings:update; changing Operator skills, harness or thinking settings also requires skills:read in every assigned skill workspace.',
    inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_defaults_update', () => settings.updateAgentDefaults(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_defaults_update')) server.registerTool('workflow_defaults_update', {
    description: 'Revision-check and replace defaults for future workflows. Existing workflows and in-flight approvals do not change.',
    inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_defaults_update', () => settings.updateWorkflowDefaults(context.principal, 'mcp', input)))
}
