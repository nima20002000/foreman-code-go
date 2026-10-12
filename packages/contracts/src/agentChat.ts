import { NativeInteractionResponseAvailabilitySchema } from './interaction-activity.js';
import { NativeMessageSubmissionSchema } from './claude.js';
import { z } from "zod";
import { ActivitySnapshotV1Schema } from "./activity.js";
import { MessageAttachmentFields } from "./files.js";
import { OperatorConversationHistoryQuerySchema } from "./operatorChat.js";
import { SavedNodePlacementSchema } from './nodePlacement.js';
import { WorkspaceRootPolicySchema } from './workspaceRootPolicies.js';
import { PromptSettingSnapshotSchema } from './prompts.js';
import { AcceptedProviderAccountBindingSchema } from './providerAccounts.js';

export const AgentChatDirectoryBindingSchema = z.object({ workflowVersionId: z.string().min(1),
  placement: SavedNodePlacementSchema, policy: WorkspaceRootPolicySchema,
}).strict();
export type AgentChatDirectoryBinding = z.infer<typeof AgentChatDirectoryBindingSchema>;

import {
  RecordedAgentHarnessSchema, HarnessExecutionSchema, ExecutionResultSchema, IdSchema, MessageSchema, OperatorActivityCursorSchema,
  OperatorActivitySchema, PendingNativeInteractionSchema, TimestampSchema,
} from "./index.js";

/**
 * FEAT-15 selected-Agent chat (NIM-2682 frozen seam).
 *
 * Identities stay separate:
 * - conversation: app record (`AgentConversation.id`), stored in the existing conversation tables.
 * - native session: provider session (`nativeSession.nativeSessionId`).
 * - turn: one delivered chat input (`AgentChatTurn.requestId`, optional provider `nativeTurnId`).
 * - execution / Run: the workflow attempt a conversation may originate from. Chat never writes them.
 */

/** How a new input relates to work already in the conversation. */
export const AgentChatIntentSchema = z.enum([
  /** Run after the current turn finishes (or immediately when idle). */
  "next_turn",
  /** Add text to the active turn. Attachments require a new turn; capabilities.steer must be available. */
  "steer",
  /** Interrupt the active turn, wait for native settlement, then submit this input once. */
  "interrupt_and_send",
]);
export type AgentChatIntent = z.infer<typeof AgentChatIntentSchema>;

/**
 * Delivery receipt state. `accepted` is provider acknowledgement/persistence, never proof that the
 * model consumed the input. `unknown` means acceptance could not be proven; it is reconciled from
 * native history and never blindly resubmitted.
 */
export const AgentChatDeliveryStateSchema = z.enum([
  "queued", "submitting", "accepted", "completed", "failed", "canceled", "unknown",
]);
export type AgentChatDeliveryState = z.infer<typeof AgentChatDeliveryStateSchema>;

/** Steering support of the installed provider version, qualified by the backend. */
export const AgentChatSteerSupportSchema = z.enum([
  /** Codex app-server `turn/steer` with an expectedTurnId precondition. */
  "native_expected_turn",
  /** Provider consumes extra input at its next processing step; no active-turn precondition. */
  "cooperative_next_step",
  "unavailable",
]);
export type AgentChatSteerSupport = z.infer<typeof AgentChatSteerSupportSchema>;

export const AgentChatCapabilitiesSchema = z.object({
  harness: RecordedAgentHarnessSchema,
  providerVersion: z.string().trim().min(1).nullable(),
  steer: AgentChatSteerSupportSchema,
  interruptAndSend: z.boolean(),
  queueNextTurn: z.boolean(),
  /** A finished conversation can continue in the same native session, including after API restart. */
  resume: z.boolean(),
  /** Human-readable reason for each unsupported capability; shown as-is by the UI. */
  unavailable: z.object({
    steer: z.string().optional(),
    interruptAndSend: z.string().optional(),
    queueNextTurn: z.string().optional(),
    resume: z.string().optional(),
  }).strict(),
}).strict();
export type AgentChatCapabilities = z.infer<typeof AgentChatCapabilitiesSchema>;

/** The Board selection a chat belongs to. `runId` absent means the Agent outside any Run. */
export const AgentChatContextSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema,
  workflowNodeId: IdSchema,
  agentId: IdSchema,
  runId: IdSchema.optional(),
}).strict();
export type AgentChatContext = z.infer<typeof AgentChatContextSchema>;

export const AgentChatOriginSchema = z.discriminatedUnion("kind", [
  /** New native session from the Agent's current accepted configuration. */
  z.object({ kind: z.literal("fresh") }).strict(),
  /** Native fork of a finished Run execution's session. The Run and its native history stay unchanged. */
  z.object({
    kind: z.literal("run_execution"),
    runId: IdSchema,
    executionId: IdSchema,
    sourceNativeSessionId: IdSchema,
  }).strict(),
]);
export type AgentChatOrigin = z.infer<typeof AgentChatOriginSchema>;

export const AgentConversationSchema = z.object({
  providerAccountBinding: AcceptedProviderAccountBindingSchema.optional(),
  id: IdSchema,
  workspaceId: IdSchema,
  workflowId: IdSchema,
  workflowNodeId: IdSchema,
  agentId: IdSchema,
  /** Accepted configuration pinned at creation; resume never re-injects its startup instructions. */
  agentConfigurationVersionId: IdSchema,
  systemPrompt: PromptSettingSnapshotSchema.optional(),
  harness: RecordedAgentHarnessSchema,
  origin: AgentChatOriginSchema,
  /** Null until the first native session is bound, including a definitely rejected, retryable attempt. */
  nativeSession: z.object({
    nativeSessionId: IdSchema,
    providerVersion: z.string().trim().min(1),
  }).strict().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type AgentConversation = z.infer<typeof AgentConversationSchema>;

export const AgentChatSessionStateSchema = z.enum([
  /** No conversation yet; the first message creates exactly one native session. */
  "none",
  "creating",
  "idle",
  "active",
  "interrupting",
  "waiting_approval",
  /** A submission or native state could not be proven; reconciliation is pending. */
  "uncertain",
  /** Native storage/runtime for this conversation is gone or unsupported. Read-only. */
  "unavailable",
  "error",
]);
export type AgentChatSessionState = z.infer<typeof AgentChatSessionStateSchema>;

/** Why sending is blocked. Absent when `availability.canSend` is true. */
export const AgentChatBlockedReasonSchema = z.enum([
  "run_active",
  "agent_missing",
  "harness_unavailable",
  "execution_location_missing",
  "native_session_missing",
  "permission_denied",
  "context_stale",
]);
export type AgentChatBlockedReason = z.infer<typeof AgentChatBlockedReasonSchema>;

export const AgentChatTurnSchema = z.object({
  requestId: IdSchema,
  /** Server order of accepted commands in the conversation. */
  sequence: OperatorActivityCursorSchema,
  intent: AgentChatIntentSchema,
  delivery: AgentChatDeliveryStateSchema,
  /** User message this turn delivered. */
  messageId: IdSchema,
  nativeTurnId: IdSchema.optional(),
  nativeSubmission: NativeMessageSubmissionSchema.optional(),
  /** For steer / interrupt_and_send: the active turn this input targeted. */
  targetNativeTurnId: IdSchema.optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type AgentChatTurn = z.infer<typeof AgentChatTurnSchema>;

/** Public text from the workflow execution, separate from its follow-up conversation. */
export const AgentChatSourceTranscriptSchema = z.object({
  executionId: IdSchema,
  state: HarnessExecutionSchema.shape.state,
  revision: OperatorActivityCursorSchema,
  messages: z.array(MessageSchema.omit({ conversationId: true })).max(100),
  hasEarlierMessages: z.boolean(),
}).strict();
export type AgentChatSourceTranscript = z.infer<typeof AgentChatSourceTranscriptSchema>;

export const AgentChatStateSchema = z.object({
  responseAvailability: NativeInteractionResponseAvailabilitySchema.optional(),
  qualificationKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),  context: AgentChatContextSchema,
  conversation: AgentConversationSchema.nullable(),
  sessionState: AgentChatSessionStateSchema,
  availability: z.object({
    canSend: z.boolean(),
    reason: AgentChatBlockedReasonSchema.optional(),
    message: z.string().optional(),
  }).strict(),
  capabilities: AgentChatCapabilitiesSchema,
  /** The native turn currently running in this conversation, if any. */
  activeTurn: z.object({
    requestId: IdSchema,
    nativeTurnId: IdSchema.optional(),
    startedAt: TimestampSchema,
  }).strict().nullable(),
  /** Recent receipts, oldest first, including every non-terminal turn unless hasMoreTurns is true. */
  turns: z.array(AgentChatTurnSchema).max(100),
  /** Legacy overflow recovery only: turns is incomplete, sending is blocked, queued cancellation remains available. */
  hasMoreTurns: z.literal(true).optional(),
  messages: z.array(MessageSchema).max(100),
  sourceTranscript: AgentChatSourceTranscriptSchema.optional(),
  hasEarlierMessages: z.boolean(),
  activities: z.array(OperatorActivitySchema).max(100),
  pendingInteraction: PendingNativeInteractionSchema.optional(),
  lastResult: ExecutionResultSchema.optional(),
  /** Monotonic per conversation; 0 when there is no conversation. */
  revision: z.number().int().nonnegative(),
  activitySnapshot: ActivitySnapshotV1Schema.optional(),
}).strict();
export type AgentChatState = z.infer<typeof AgentChatStateSchema>;

/** GET /api/workspaces/:workspaceId/agent-chat?workflowId&workflowNodeId&agentId[&runId] */
export const AgentChatQuerySchema = AgentChatContextSchema.omit({ workspaceId: true });
export type AgentChatQuery = z.infer<typeof AgentChatQuerySchema>;

/** POST /api/workspaces/:workspaceId/agent-chat/messages */
export const SendAgentChatMessageRequestSchema = z.object({
  /** Idempotency key. A replay with the same key and input returns the stored receipt; never re-sends. */
  requestId: IdSchema,
  ...MessageAttachmentFields,
  context: AgentChatQuerySchema,
  content: z.string().trim().max(32000),
  sessionMode: z.enum(['regular', 'plan']).optional()
    .describe('Selects the mode for a new turn. Steering may only retain the active applied mode; mode changes and /plan tasks require next_turn or interrupt_and_send.'),
  intent: AgentChatIntentSchema.default("next_turn")
    .describe("steer supports text only in the active mode; use next_turn or interrupt_and_send for mode changes, /plan tasks or attachments"),
  /** Null = the client saw no conversation (first message). A mismatch returns 409 context_stale. */
  expectedConversationId: IdSchema.nullable(),
  /** Required for steer when capabilities.steer is "native_expected_turn". */
  expectedNativeTurnId: IdSchema.optional(),
}).strict().refine((value) => value.content.length > 0 || value.attachments.length > 0, {
  path: ["content"], message: "Message requires text or an attachment.",
}).refine((value) => value.intent !== "steer" || value.attachments.length === 0, {
  path: ["attachments"], message: "Attachment steering is not supported. Send attachments in a new turn.",
});
export type SendAgentChatMessageRequest = Omit<z.infer<typeof SendAgentChatMessageRequestSchema>, "attachments">
  & { attachments?: z.input<typeof MessageAttachmentFields.attachments> };
/** Legacy urgent receipts did not retain the original target. This is readback, not target verification. */
export const AgentChatReplayWarningSchema = z.object({
  code: z.literal("AGENT_CHAT_LEGACY_TARGET_UNVERIFIABLE"),
  message: z.string().min(1),
}).strict();
export type AgentChatReplayWarning = z.infer<typeof AgentChatReplayWarningSchema>;
export const SendAgentChatMessageResponseSchema = z.object({
  state: AgentChatStateSchema,
  turn: AgentChatTurnSchema,
  replayed: z.boolean(),
  /** Present on legacy targetless urgent readback, even for an omitted or different claimed target.
   * Only retained content/intent/context were checked; no target was verified, applied, or adopted.
   * The original receipt (including delivery) is unchanged. New receipts use strict input identity. */
  replayWarning: AgentChatReplayWarningSchema.optional(),
}).strict();
export type SendAgentChatMessageResponse = z.infer<typeof SendAgentChatMessageResponseSchema>;

/** POST /api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/interrupt */
export const InterruptAgentChatRequestSchema = z.object({
  requestId: IdSchema,
  expectedNativeTurnId: IdSchema.optional(),
}).strict();
/** POST .../conversations/:conversationId/turns/:turnRequestId/cancel — only a queued turn. */
export const CancelQueuedAgentChatTurnRequestSchema = z.object({ requestId: IdSchema }).strict();
/** POST .../conversations/:conversationId/responses — native approval/user-input reply. */
export const RespondAgentChatInteractionRequestSchema = z.object({
  requestId: IdSchema, nativeRequestId: IdSchema, optionId: IdSchema,
  response: z.json().optional(),
}).strict();
export const AgentChatStateResponseSchema = z.object({ state: AgentChatStateSchema }).strict();

/** GET .../conversations/:conversationId/history?before&limit — older messages. */
export const AgentChatHistoryPageSchema = z.object({
  conversationId: IdSchema,
  messages: z.array(MessageSchema).max(100),
  nextCursor: OperatorActivityCursorSchema.nullable(),
}).strict();

/** Shared bigint keyset pagination for HTTP and MCP message/receipt readback. */
export const AgentChatReadbackQuerySchema = OperatorConversationHistoryQuerySchema;

/** GET .../conversations/:conversationId/turns?before&limit — all retained receipts, oldest first per page. */
export const AgentChatTurnPageSchema = z.object({
  conversationId: IdSchema,
  turns: z.array(AgentChatTurnSchema).max(100),
  nextCursor: OperatorActivityCursorSchema.nullable(),
}).strict();

/** agent_chat_read retains its ordinary state response; explicit page requests add readback fields. */
export const ReadAgentChatRequestSchema = z.object({
  workspaceId: IdSchema,
  query: AgentChatQuerySchema,
  history: AgentChatReadbackQuerySchema.optional(),
  receipts: AgentChatReadbackQuerySchema.optional(),
}).strict();
export const ReadAgentChatResponseSchema = AgentChatStateSchema.extend({
  history: AgentChatHistoryPageSchema.optional(),
  receipts: AgentChatTurnPageSchema.optional(),
}).strict();

/**
 * GET .../conversations/:conversationId/events — SSE. Normally the first event is `snapshot`
 * (full AgentChatState). If its serialized payload exceeds the transport byte budget, the first
 * event is `state` with { snapshotRequired: true }; read state via HTTP instead. Large live events
 * use the same invalidation, never truncated approval/result content. Later events may carry
 * partial data; the client re-reads state on `state` or after reconnect.
 */
export const AgentChatStreamEventSchema = z.object({
  id: z.number().int().nonnegative(),
  conversationId: IdSchema,
  type: z.enum(["snapshot", "delta", "message", "activity", "turn", "state", "error"]),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type AgentChatStreamEvent = z.infer<typeof AgentChatStreamEventSchema>;

export {
  agentChatFixtureContext, agentChatFixtures, codexChatCapabilities, claudeChatCapabilities, steerUnavailableCapabilities,
} from "./agentChatFixtures.js";
