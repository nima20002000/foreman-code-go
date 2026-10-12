import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  CancelQueuedAgentChatTurnRequestSchema, RespondAgentChatInteractionRequestSchema,
  AgentChatStateResponseSchema, SendAgentChatMessageResponseSchema,
} from '@foreman-code/contracts/agent-chat'
import {
  AgentChatReadToolInputSchema, AgentChatReadToolOutputSchema, AgentChatSendToolInputSchema, AgentChatInterruptToolInputSchema,
} from '@foreman-code/contracts/selected-run-chat'

import { DomainError } from '../../../modules/errors.js'
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
    description: 'Read the chat for one workflow Agent node with query, or an exact historical Run node with selection: {workflowId, runId, workflowNodeId, executionId?}. Supply exactly one selector. Historical selection uses the immutable Run snapshot, works after removing the Agent, and returns kind selected, execution_selection_required, or unavailable. When multiple executions exist, choose executionId explicitly; never choose another execution because it has a session. sourceTranscript contains the execution’s public messages while starting, running and completed, independently of chat session availability. It is bounded to the latest 100 messages and 128 KiB of text, with explicit truncation. Follow-up chat forks only a completed execution; the parent Run may still be working. A selected result includes state and a complete key, or null key until a conversation exists. Reads never attach, create, fork or resume a native session. Returns the conversation, native session, delivery receipts, messages, public activity, capabilities and why sending is blocked. When availability.canSend is true, the first message may create the conversation and its separate native session; an unavailable source must not be replaced. Pass history: {limit, before?} to retrieve complete follow-up messages omitted from the byte-bounded snapshot (including a single oversized message); follow history.nextCursor until null. Pass receipts: {limit, before?} to page all retained delivery receipts; follow receipts.nextCursor until null. Pages are oldest-first and begin with the newest page when before is omitted. hasMoreTurns marks legacy overflow: sending is blocked, not all receipts fit in state.turns, and queued receipts can be canceled with agent_chat_cancel_queued or agent_chat_interrupt. Unconfirmed deliveries are never treated as canceled. Pass executionActivity: {cursor?, executionId?, before?, itemId?, limit?} with query.runId to read the live public activity of that Run Agent\u2019s newest 20 executions (labeled Execution, Attempt n, Interval check n or Occurrence n): messages plus tool, shell command, file, MCP, plan, reasoning-summary and subagent steps with status and bounded output previews, ordered by execution then native sequence. Without cursor it returns the newest window; pass the returned cursor to receive only changed entries (hasMoreChanges means read again now). executionId with before pages older entries; executionId with itemId returns one entry with bounded bodies (message 64 KiB, arguments 16,000 bytes and output 24,000 bytes); truncation is explicit. Public pages are bounded to 200 items and 256 KiB. Cursors are opaque and also include execution-state changes, including unfinished tools becoming unknown after an execution finishes. Requires agent_chat:read.',
    inputSchema: AgentChatReadToolInputSchema, outputSchema: AgentChatReadToolOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, query, selection, history, receipts, executionActivity }) => invokeOperatorTool(context, 'agent_chat_read', async () => {
    if (executionActivity && !query?.runId) {
      throw new DomainError('AGENT_CHAT_EXECUTION_ACTIVITY_REQUIRES_RUN', 'executionActivity requires query with runId.', 400)
    }
    if (selection) return chat.readSelectedRun(context.principal, { selection: { workspaceId, ...selection },
      ...(history ? { history } : {}), ...(receipts ? { receipts } : {}) })
    const state = await chat.read(context.principal, workspaceId, query!)
    const id = state.conversation?.id
    return { ...state,
      ...(id && history ? { history: await chat.history(context.principal, workspaceId, id, history.before, history.limit) } : {}),
      ...(id && receipts ? { receipts: await chat.receipts(context.principal, workspaceId, id, receipts.before, receipts.limit) } : {}),
      ...(executionActivity && query?.runId ? { executionActivity: await chat.executionActivity(context.principal, workspaceId,
        { ...query, runId: query.runId }, executionActivity) } : {}),
    }
  }))
  if (operatorToolAvailable(context, 'agent_chat_send')) server.registerTool('agent_chat_send', {
    description: 'Use agent_chat_controls_update for bare /compact, /plan and /plan off. For one Plan task send sessionMode: plan with its task text through the same admission. Send a message to a workflow Agent chat using request. content may be empty only when attachments contains at least one fileId/revisionId pin for an existing conversation. For historical selection, instead supply selection: {workflowId, runId, workflowNodeId, executionId} and message with the usual message fields except context; Agent identity comes from the snapshot. The follow-up forks and recovers on the original accepted execution computer and profile; unavailable placement fails without changing hosts. Never supply both forms. intent next_turn queues after the active turn (or starts now when idle); steer adds text only to the active turn when capabilities.steer allows it and needs expectedNativeTurnId; steering may retain the active applied mode but mode changes and /plan tasks require next_turn or interrupt_and_send; attachments are rejected for steer before admission, so use next_turn or interrupt_and_send for files; interrupt_and_send stops the active turn and sends once. Set expectedConversationId to the conversation id read before (null for the first message). Reuse the exact requestId and input after a lost response: the stored receipt is returned and nothing is resent. For old interrupt_and_send receipts whose target was not retained, replayWarning AGENT_CHAT_LEGACY_TARGET_UNVERIFIABLE means readback only: content, intent and context match, but the supplied target was not verified or applied (including a changed or omitted target). Do not interpret that receipt as a new command or verified target match. Never starts or changes a workflow Run. Requires agent_chat:write and agent_chat:read.',
    inputSchema: AgentChatSendToolInputSchema, outputSchema: SendAgentChatMessageResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, request, selection, message }) => invokeOperatorTool(context, 'agent_chat_send', () =>
    selection && message ? chat.sendSelectedRun(context.principal, { selection: { workspaceId, ...selection }, message })
      : chat.send(context.principal, workspaceId, request!)))
  if (operatorToolAvailable(context, 'agent_chat_interrupt')) server.registerTool('agent_chat_interrupt', {
    description: 'Stop the active chat turn and cancel every queued message in this Agent conversation. For a selected historical Run, additionally pass selection: {workflowId, runId, workflowNodeId, agentId, executionId} from its readback key; every id is checked before any native action. Reuse requestId with identical input after a lost response; uncertain delivery is never resent. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: AgentChatInterruptToolInputSchema,
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, selection, ...request }) => invokeOperatorTool(context, 'agent_chat_interrupt',
    async () => ({ state: selection
      ? await chat.interruptSelectedRun(context.principal, { key: { workspaceId, conversationId, ...selection }, request }, 'mcp')
      : await chat.interrupt(context.principal, workspaceId, conversationId, request, 'mcp') })))
  if (operatorToolAvailable(context, 'agent_chat_cancel_queued')) server.registerTool('agent_chat_cancel_queued', {
    description: 'Cancel one queued Agent chat message before it is sent to the Agent. Fails when it already started. Reuse requestId with identical input after a lost response; uncertain delivery is never resent. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: CancelQueuedAgentChatTurnRequestSchema.extend({ workspaceId: workspace, conversationId: conversation, turnRequestId: z.string().min(1) }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, turnRequestId, ...request }) => invokeOperatorTool(context, 'agent_chat_cancel_queued',
    async () => ({ state: await chat.cancelQueued(context.principal, workspaceId, conversationId, turnRequestId, request, 'mcp') })))
  if (operatorToolAvailable(context, 'agent_chat_respond')) server.registerTool('agent_chat_respond', {
    description: 'Answer the pending native approval or input request in an Agent chat with an offered option. '
      + 'Standalone Codex forms are bound to their native session and request, without a turn ID. '
      + 'For questions and forms, supply response matching the option input schema. Reuse requestId with the same '
      + 'choice and response after a lost response; uncertain delivery is never resent. '
      + 'Read agent_chat_read activitySnapshot for the saved decision and providerAcknowledged: '
      + 'a recorded answer alone is not delivery confirmation; native consumption may confirm it later. '
      + 'Requires agent_chat:respond and agent_chat:read.',
    inputSchema: RespondAgentChatInteractionRequestSchema.extend({ workspaceId: workspace, conversationId: conversation }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, conversationId, ...request }) => invokeOperatorTool(context, 'agent_chat_respond',
    async () => ({ state: await chat.respond(context.principal, workspaceId, conversationId, request, 'mcp') })))
}
