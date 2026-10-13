import { operatorControlTools } from './operatorControls.js'
import { z } from 'zod'
import { IdSchema, OperatorActivityPageSchema, OperatorActivityQuerySchema,
  OperatorChatSetupSchema, OperatorChatSetupQuerySchema,
  CreateOperatorConversationRequestSchema, CreateOperatorConversationResponseSchema,
  OperatorConversationDeletionInputSchema, DeleteOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
  GetOperatorConversationResponseSchema, SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema } from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema, OperatorConversationHistoryQuerySchema,
  OperatorHandoffHistoryPageSchema, OperatorHistoryCursorSchema } from '@foreman-code/contracts/operator-chat'

import {
  WorkerExecutionSettingsSchema,
  ManagedRemoteExecutionSettingsSchema,
  RemoteExecutionSettingsUpdateInputSchema,
  RemoteExecutionSettingsUpdateResultSchema,
  ManagedGeneralSettingsSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { defineOperatorTool } from '../definition.js'

export const settingsTools = [
  defineOperatorTool({
    name: 'worker_execution_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.workerExecution,
    description: 'Read whether Main permits execution on connected Worker computers. Requires global settings:read. Use remote_execution_settings_get/update to change persisted settings. Explicit environment overrides remain controlled at startup. History, cancellation and cleanup remain available through their existing permissions.',
    inputSchema: z.object({}).strict(),
    outputSchema: WorkerExecutionSettingsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context) => context.services.workerExecution!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'remote_execution_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.remoteExecution,
    description: 'Read Main’s persisted remote execution and device listener settings, revision, effective values, '
      + 'explicit environment overrides and listener runtime status. Requires global settings:read. '
      + 'TLS file paths refer to Main; certificate and key contents are never returned.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedRemoteExecutionSettingsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.remoteExecution!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'remote_execution_settings_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.remoteExecution,
    description: 'Replace Main’s persisted global remote execution and device listener settings. Requires global '
      + 'settings:update. Use expectedRevision from remote_execution_settings_get and reuse commandId with identical '
      + 'input after an uncertain save. Explicit environment values override saved values. TLS certificate/key paths '
      + 'must name owner-only files owned by Main’s OS user. Execution enablement applies live. Listener changes '
      + 'apply live when no computers are connected; otherwise restart Main. Read back effective values and '
      + 'restartRequired with remote_execution_settings_get. This grants no device, harness or workflow permissions.',
    inputSchema: RemoteExecutionSettingsUpdateInputSchema, outputSchema: RemoteExecutionSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.remoteExecution!.update(context.principal, 'mcp', input),
  }),
  ...operatorControlTools,
  defineOperatorTool({
    name: 'operator_chat_create',
    requires: [['operator_chat:write', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Create an owner-bound Operator conversation using the current saved Operator defaults. Supply a commandId and reuse it with the same title after a lost response to recover the same conversation, even if defaults have changed. Reusing it with a different title is a conflict. Use operator_chat_list to rediscover owned conversations. Requires global operator_chat:write.',
    inputSchema: CreateOperatorConversationRequestSchema.required({ commandId: true }),
    outputSchema: CreateOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { commandId, title }) => ({
    conversation: await context.services.operatorChat!.create(context.principal, title, { commandId, source: 'mcp' }),
  }),
  }),
  defineOperatorTool({
    name: 'operator_chat_delete',
    requires: [['operator_chat:write', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Soft-delete an owned idle Operator chat, removing it from history and revoking its delegated '
      + 'chat credentials. Stop an active turn first. Requires global operator_chat:write. Reuse commandId with '
      + 'the same conversationId after an uncertain response; a replay does not delete the chat again after '
      + 'restoration. New outcomes include the saved deletion revision; historical replays retain their original response. Use operator_chat_restore to undo and operator_chat_list to read persisted history.',
    inputSchema: OperatorConversationDeletionInputSchema,
    outputSchema: DeleteOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, commandId }) => context.services.operatorChat!.setDeleted(conversationId, context.principal, true, { commandId, source: 'mcp' }),
  }),
  defineOperatorTool({
    name: 'operator_chat_restore',
    requires: [['operator_chat:write', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Restore an owned deleted Operator chat to history. Previously revoked delegated chat credentials '
      + 'stay revoked. Requires global operator_chat:write and an idle chat. Reuse commandId with the same '
      + 'conversationId after an uncertain response; a replay does not restore the chat again after another deletion. '
      + 'New outcomes include the restored revision; historical replays retain their original response. Read back with operator_chat_list or operator_chat_get, requiring operator_chat:read.',
    inputSchema: OperatorConversationDeletionInputSchema,
    outputSchema: DeleteOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, commandId }) => context.services.operatorChat!.setDeleted(conversationId, context.principal, false, { commandId, source: 'mcp' }),
  }),
  defineOperatorTool({
    name: 'operator_chat_list',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Rediscover this caller\'s persisted Operator conversations, including newly created empty chats. Returns only conversations owned by this principal and excludes deleted conversations. Requires global operator_chat:read.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListOperatorConversationsResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context) => ({
      conversations: await context.services.operatorChat!.list(context.principal),
    }),
  }),
  defineOperatorTool({
    name: 'operator_chat_get',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Read an owned Operator conversation snapshot, including its harness handoff parent and recent persisted messages and activities. nativeSubmission identifies the observed Claude input message for the active request. Use operator_chat_history_get and operator_chat_activity_get to page older records. Message acceptedModel identifies the model from that message\'s immutable accepted turn configuration, when recorded. Requires operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1) }).strict(), outputSchema: GetOperatorConversationResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId }) => context.services.operatorChat!.get(conversationId, context.principal),
  }),
  defineOperatorTool({
    name: 'operator_chat_history_get',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Page the persisted messages and acceptance receipts of an owned Operator conversation, including messages omitted from operator_chat_get. Pages are oldest-first; pass nextCursor as before to read older records. Cursors are decimal strings bound to this conversation. Requires global operator_chat:read.',
    inputSchema: OperatorConversationHistoryQuerySchema.extend({ conversationId: IdSchema }),
    outputSchema: OperatorConversationHistoryPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, ...query }) => context.services.operatorChat!.history(conversationId, context.principal, query),
  }),
  defineOperatorTool({
    name: 'operator_chat_activity_get',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Page persisted activity of an owned Operator conversation, including records omitted from operator_chat_get. Supply requestId and activityId to read one persisted item regardless of its age. Pages are oldest-first; pass nextCursor as before to read older records. Cursors are decimal strings bound to this conversation. Requires global operator_chat:read.',
    inputSchema: OperatorActivityQuerySchema.extend({ conversationId: IdSchema }),
    outputSchema: OperatorActivityPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, ...query }) => context.services.operatorChat!.activityPage(conversationId, context.principal, query),
  }),
  defineOperatorTool({
    name: 'operator_chat_send',
    requires: [['operator_chat:write', 'global'], ['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Use operator_chat_controls_update for bare /compact, /plan and /plan off. For one Plan task send sessionMode: plan with its task text. Send an owned Operator message and return protected conversation state. Reserve configurationVersionId from operator_chat_get. For a different harness, also supply forkExpectedRevision and defaultsRevision from agent_defaults_get; existing chats retain their access policy. A showThinking-only change retains the owned native session and immutable prior turn configuration. Reuse the exact request ID and command fields after a lost response. Set recovery to receipt to read acceptance without starting or retrying native work; OPERATOR_RECEIPT_NOT_FOUND is not proof of non-delivery. Requires operator_chat:read and operator_chat:write, including receipt-only recovery.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: SendOperatorMessageRequestSchema }).strict(),
    outputSchema: SendOperatorMessageResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, request }) => context.services.operatorChat!.send(conversationId, request, context.principal),
  }),
  defineOperatorTool({
    name: 'operator_handoff_history_get',
    requires: [['operator_handoff:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Read older user and assistant text from an ancestor of this credential-bound fork, up to its frozen handoff cutoff. This tool cannot read other conversations or tool/approval payloads. Requires the delegated operator_handoff:read grant.',
    inputSchema: z.object({ sourceConversationId: z.string().min(1).optional(), before: OperatorHistoryCursorSchema.optional() }).strict(),
    outputSchema: OperatorHandoffHistoryPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { sourceConversationId, before }) => context.services.operatorChat!.handoffHistory(context.principal, sourceConversationId, before),
  }),
  defineOperatorTool({
    name: 'operator_mcp_setup_get',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Check the Operator Foreman Code MCP installation, configured endpoint and managed credential arrangement. Omit selectors to inspect current defaults; supply conversationId to inspect its pinned configuration, and requestId to inspect an accepted message configuration. configurationVersionId, harness and expectedDefaultsRevision retain the shared setup query checks. Conversation selectors require owner-bound operator_chat:read; private configuration pins require owned history or a live authorized chat binding. Requires global harnesses:read. Native chat-derived callers need a live submitted owner-bound turn and current parent grants. Claude inspects the selected Main or paired Worker profile with read authority and no model input. This does not install MCP, issue credentials, grant execution authority or prove a per-turn connection.',
    inputSchema: OperatorChatSetupQuerySchema, outputSchema: OperatorChatSetupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.operatorChat!.setup(context.principal, input),
  }),
  defineOperatorTool({
    name: 'system_prompt_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the app-wide System prompt and its revision. It is prepended to newly started workflow '
      + 'and Agent chat sessions for Codex and Claude. The Operator is excluded. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedPromptSettingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getSystemPrompt(context.principal),
  }),
  defineOperatorTool({
    name: 'system_prompt_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save the app-wide System prompt for newly started Codex and Claude workflow and Agent chat '
      + 'sessions. Existing sessions keep their saved revision; the Operator is excluded. Requires global '
      + 'settings:update. Use expectedRevision from system_prompt_get; retry an uncertain save with the same '
      + 'commandId and input, then read back with system_prompt_get. Empty text clears the prompt.',
    inputSchema: PromptSettingUpdateInputSchema, outputSchema: PromptSettingUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateSystemPrompt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'operator_initial_prompt_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the Operator own Initial prompt and revision. Newly created Operator conversations '
      + 'use this text; they do not receive the app-wide System prompt. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedPromptSettingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getOperatorInitialPrompt(context.principal),
  }),
  defineOperatorTool({
    name: 'operator_initial_prompt_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save the Operator own Initial prompt for new conversations. Existing conversations keep '
      + 'their saved revision. Requires global settings:update. Use expectedRevision from '
      + 'operator_initial_prompt_get and reuse commandId with the same input after an uncertain save. '
      + 'Read back with operator_initial_prompt_get. Empty text clears the custom Initial prompt.',
    inputSchema: PromptSettingUpdateInputSchema, outputSchema: PromptSettingUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateOperatorInitialPrompt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'general_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read Main’s saved general preferences and revision. Theme is shared by browsers on all computers '
      + 'connected to this Main. Requires global settings:read. Credentials and native profiles remain per computer.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedGeneralSettingsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getGeneralSettings(context.principal),
  }),
  defineOperatorTool({
    name: 'general_settings_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save general preferences on Main for all connected browsers. Requires global settings:update. '
      + 'Use expectedRevision from general_settings_get and reuse commandId with the same input after an uncertain save. '
      + 'Read back with general_settings_get. This does not sync database files, credentials or native profiles.',
    inputSchema: GeneralSettingsUpdateInputSchema, outputSchema: GeneralSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateGeneralSettings(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'agent_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read saved role defaults and nativeTools loading policy (mcpServers allowlist, apps switch), including the Operator chat model, harness, Codex or Claude sandbox, effort, and thinking preferences. Unsaved Operator defaults use full access; existing saved settings remain authoritative. New Operator conversations inherit these settings. Operator UI enablement does not disable management MCP.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getAgentDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'workflow_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.workflows && !!s.settings,
    description: 'Read defaults copied into newly created workflows, including user, orchestrator or explicit native harness approval handling. Native handling requires compatible saved settings on each Agent. Graph edges do not grant approval authority.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getWorkflowDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'agent_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Revision-check and replace role defaults. nativeTools.mcpServers is the native MCP server allowlist ([] = Foreman Code only); nativeTools.apps controls apps/connectors and Claude SDK plugins. Omitted policy fields inherit host settings. Foreman Code stays available under existing grants. These settings are copied into new Agents and pinned into new Operator conversations. Read agent_defaults_get to verify persisted settings. Includes the Operator sandbox or permission rules shared by chat and Settings > Agents > Operator. Codex and Claude support explicit danger-full-access. Access choices do not grant app authority or bypass native qualification and approval routing. New conversations inherit Operator changes; running turns and accepted Runs remain pinned. Requires global settings:update; changing Operator skills, harness, thinking or native-tool settings also requires skills:read in every assigned skill workspace. First local Claude preparation additionally requires harnesses:read and harnesses:update, and runs finite subscription diagnostics for the exact submitted configuration.',
    inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateAgentDefaults(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.workflows && !!s.settings,
    description: 'Revision-check and replace defaults for future workflows. approvalHandler accepts user, orchestrator or native; native handling still requires explicitly configured native approval on each Agent and preserves its permission rules. Existing workflows and in-flight approvals do not change.',
    inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateWorkflowDefaults(context.principal, 'mcp', input),
  }),
]
