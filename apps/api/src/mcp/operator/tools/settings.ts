import { registerOperatorControlTools } from './operatorControls.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { IdSchema, OperatorActivityPageSchema, OperatorActivityQuerySchema,
  OperatorChatSetupSchema, OperatorChatSetupQuerySchema,
  CreateOperatorConversationRequestSchema, CreateOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
  GetOperatorConversationResponseSchema, SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema } from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema, OperatorConversationHistoryQuerySchema,
  OperatorHandoffHistoryPageSchema, OperatorHistoryCursorSchema } from '@foreman-code/contracts/operator-chat'

import {
  WorkerExecutionSettingsSchema,
  ManagedGeneralSettingsSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { invokeOperatorTool } from '../invoke.js'
import { operatorToolAvailable } from '../availability.js'
import type { OperatorRequestContext } from '../types.js'

export function registerSettingsTools(server: McpServer, context: OperatorRequestContext): void {
  if (context.services.workerExecution && operatorToolAvailable(context, 'worker_execution_settings_get')) {
    server.registerTool('worker_execution_settings_get', {
      description: 'Read whether Main permits execution on connected Worker computers. Requires global settings:read. This deployment setting is controlled at startup by a person; MCP cannot change it. History, cancellation and cleanup remain available through their existing permissions.',
      inputSchema: z.object({}).strict(),
      outputSchema: WorkerExecutionSettingsSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    }, () => invokeOperatorTool(context, 'worker_execution_settings_get', async () =>
      context.services.workerExecution!.read(context.principal)))
  }
  registerOperatorControlTools(server, context)
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_create')) server.registerTool('operator_chat_create', {
    description: 'Create an owner-bound Operator conversation using the current saved Operator defaults. Supply a commandId and reuse it with the same title after a lost response to recover the same conversation, even if defaults have changed. Reusing it with a different title is a conflict. Use operator_chat_list to rediscover owned conversations. Requires global operator_chat:write.',
    inputSchema: CreateOperatorConversationRequestSchema.required({ commandId: true }),
    outputSchema: CreateOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ commandId, title }) => invokeOperatorTool(context, 'operator_chat_create', async () => ({
    conversation: await context.services.operatorChat!.create(context.principal, title, { commandId, source: 'mcp' }),
  })))
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_list')) {
    server.registerTool('operator_chat_list', {
      description: 'Rediscover this caller\'s persisted Operator conversations, including newly created empty chats. Returns only conversations owned by this principal and excludes deleted conversations. Requires global operator_chat:read.',
      inputSchema: z.object({}).strict(),
      outputSchema: ListOperatorConversationsResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => invokeOperatorTool(context, 'operator_chat_list', async () => ({
      conversations: await context.services.operatorChat!.list(context.principal),
    })))
  }
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_get')) server.registerTool('operator_chat_get', {
    description: 'Read an owned Operator conversation snapshot, including its harness handoff parent and recent persisted messages and activities. nativeSubmission identifies the observed Claude input message for the active request. Use operator_chat_history_get and operator_chat_activity_get to page older records. Message acceptedModel identifies the model from that message\'s immutable accepted turn configuration, when recorded. Requires operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1) }).strict(), outputSchema: GetOperatorConversationResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ conversationId }) => invokeOperatorTool(context, 'operator_chat_get', () => context.services.operatorChat!.get(conversationId, context.principal)))
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_history_get')) {
    server.registerTool('operator_chat_history_get', {
      description: 'Page the persisted messages and acceptance receipts of an owned Operator conversation, including messages omitted from operator_chat_get. Pages are oldest-first; pass nextCursor as before to read older records. Cursors are decimal strings bound to this conversation. Requires global operator_chat:read.',
      inputSchema: OperatorConversationHistoryQuerySchema.extend({ conversationId: IdSchema }),
      outputSchema: OperatorConversationHistoryPageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ conversationId, ...query }) => invokeOperatorTool(context, 'operator_chat_history_get', () =>
      context.services.operatorChat!.history(conversationId, context.principal, query)))
  }
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_activity_get')) {
    server.registerTool('operator_chat_activity_get', {
      description: 'Page persisted activity of an owned Operator conversation, including records omitted from operator_chat_get. Pages are oldest-first; pass nextCursor as before to read older records. Cursors are decimal strings bound to this conversation. Requires global operator_chat:read.',
      inputSchema: OperatorActivityQuerySchema.extend({ conversationId: IdSchema }),
      outputSchema: OperatorActivityPageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ conversationId, ...query }) => invokeOperatorTool(context, 'operator_chat_activity_get', () =>
      context.services.operatorChat!.activityPage(conversationId, context.principal, query)))
  }
  if (context.services.operatorChat && operatorToolAvailable(context, 'operator_chat_send')) server.registerTool('operator_chat_send', {
    description: 'Use operator_chat_controls_update for bare /compact, /plan and /plan off. For one Plan task send sessionMode: plan with its task text. Send an owned Operator message and return protected conversation state. Reserve configurationVersionId from operator_chat_get. For a different harness, also supply forkExpectedRevision and defaultsRevision from agent_defaults_get; existing chats retain their access policy. Reuse the exact request ID and command fields after a lost response. Set recovery to receipt to read acceptance without starting or retrying native work; OPERATOR_RECEIPT_NOT_FOUND is not proof of non-delivery. Requires operator_chat:read and operator_chat:write, including receipt-only recovery.',
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
    description: 'Check the Operator Foreman Code MCP installation, configured endpoint and managed credential arrangement. Omit selectors to inspect current defaults; supply conversationId to inspect its pinned configuration, and requestId to inspect an accepted message configuration. configurationVersionId, harness and expectedDefaultsRevision retain the shared setup query checks. Conversation selectors require owner-bound operator_chat:read; private configuration pins require owned history or a live authorized chat binding. Requires global harnesses:read. Native chat-derived callers need a live submitted owner-bound turn and current parent grants. Claude uses a read-authorized SDK inspection on the selected profile. This does not install MCP, issue credentials, grant execution authority or prove a per-turn connection.',
    inputSchema: OperatorChatSetupQuerySchema, outputSchema: OperatorChatSetupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'operator_mcp_setup_get', () =>
    context.services.operatorChat!.setup(context.principal, input)))
  const settings = context.services.settings
  if (!settings) return
  if (operatorToolAvailable(context, 'general_settings_get')) server.registerTool('general_settings_get', {
    description: 'Read Main’s saved general preferences and revision. Theme is shared by browsers on all computers '
      + 'connected to this Main. Requires global settings:read. Credentials and native profiles remain per computer.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedGeneralSettingsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => invokeOperatorTool(context, 'general_settings_get', () => settings.getGeneralSettings(context.principal)))
  if (operatorToolAvailable(context, 'general_settings_update')) server.registerTool('general_settings_update', {
    description: 'Save general preferences on Main for all connected browsers. Requires global settings:update. '
      + 'Use expectedRevision from general_settings_get and reuse commandId with the same input after an uncertain save. '
      + 'Read back with general_settings_get. This does not sync database files, credentials or native profiles.',
    inputSchema: GeneralSettingsUpdateInputSchema, outputSchema: GeneralSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => invokeOperatorTool(context, 'general_settings_update',
    () => settings.updateGeneralSettings(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'agent_defaults_get')) server.registerTool('agent_defaults_get', {
    description: 'Read saved role defaults, including the Operator chat model, harness, Codex or Claude sandbox, OpenCode native permission rules, effort, and thinking preferences. Unsaved Operator defaults use full access; existing saved settings remain authoritative. New Operator conversations inherit these settings. Operator UI enablement does not disable management MCP.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'agent_defaults_get', () => settings.getAgentDefaults(context.principal)))
  if (operatorToolAvailable(context, 'workflow_defaults_get')) server.registerTool('workflow_defaults_get', {
    description: 'Read defaults copied into newly created workflows, including user, orchestrator or explicit native harness approval handling. Native handling requires compatible saved settings on each Agent. Graph edges do not grant approval authority.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => invokeOperatorTool(context, 'workflow_defaults_get', () => settings.getWorkflowDefaults(context.principal)))
  if (operatorToolAvailable(context, 'agent_defaults_update')) server.registerTool('agent_defaults_update', {
    description: 'Revision-check and replace role defaults, including the Operator sandbox or permission rules shared by chat and Settings > Agents > Operator. Codex and Claude support explicit danger-full-access; OpenCode permissions are not a filesystem sandbox. Access choices do not grant app authority or bypass native qualification and approval routing. New conversations inherit Operator changes; running turns and accepted Runs remain pinned. Requires global settings:update; changing Operator skills, harness or thinking settings also requires skills:read in every assigned skill workspace. First local Claude preparation additionally requires harnesses:read and harnesses:update, and runs finite subscription diagnostics for the exact submitted configuration.',
    inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'agent_defaults_update', () => settings.updateAgentDefaults(context.principal, 'mcp', input)))
  if (operatorToolAvailable(context, 'workflow_defaults_update')) server.registerTool('workflow_defaults_update', {
    description: 'Revision-check and replace defaults for future workflows. approvalHandler accepts user, orchestrator or native; native handling still requires explicitly configured native approval on each Agent and preserves its permission rules. Existing workflows and in-flight approvals do not change.',
    inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invokeOperatorTool(context, 'workflow_defaults_update', () => settings.updateWorkflowDefaults(context.principal, 'mcp', input)))
}
