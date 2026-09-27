import { z } from "zod";

import {
  AgentHarnessSchema, ExecutionResultSchema, IdSchema, MessageSchema, OperatorActivityCursorSchema,
  OperatorActivitySchema, PendingNativeInteractionSchema, TimestampSchema,
} from "./index.js";

/**
 * FEAT-15 selected-Agent chat (NIM-2682 frozen seam).
 *
 * Identities stay separate:
 * - conversation: app record (`AgentConversation.id`), stored in the existing conversation tables.
 * - native session: Codex thread / OpenCode session (`nativeSession.nativeSessionId`).
 * - turn: one delivered chat input (`AgentChatTurn.requestId`, optional provider `nativeTurnId`).
 * - execution / Run: the workflow attempt a conversation may originate from. Chat never writes them.
 */

/** How a new input relates to work already in the conversation. */
export const AgentChatIntentSchema = z.enum([
  /** Run after the current turn finishes (or immediately when idle). */
  "next_turn",
  /** Add input to the active turn. Only valid when capabilities.steer is not "unavailable". */
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
  harness: AgentHarnessSchema,
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
  id: IdSchema,
  workspaceId: IdSchema,
  workflowId: IdSchema,
  workflowNodeId: IdSchema,
  agentId: IdSchema,
  /** Accepted configuration pinned at creation; resume never re-injects its startup instructions. */
  agentConfigurationVersionId: IdSchema,
  harness: AgentHarnessSchema,
  origin: AgentChatOriginSchema,
  /** Null only while the first native session is being created. */
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
  /** For steer / interrupt_and_send: the active turn this input targeted. */
  targetNativeTurnId: IdSchema.optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type AgentChatTurn = z.infer<typeof AgentChatTurnSchema>;

export const AgentChatStateSchema = z.object({
  context: AgentChatContextSchema,
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
  /** Recent receipts, oldest first, including every non-terminal (queued/submitting/unknown) turn. */
  turns: z.array(AgentChatTurnSchema).max(100),
  messages: z.array(MessageSchema).max(100),
  hasEarlierMessages: z.boolean(),
  activities: z.array(OperatorActivitySchema).max(100),
  pendingInteraction: PendingNativeInteractionSchema.optional(),
  lastResult: ExecutionResultSchema.optional(),
  /** Monotonic per conversation; 0 when there is no conversation. */
  revision: z.number().int().nonnegative(),
}).strict();
export type AgentChatState = z.infer<typeof AgentChatStateSchema>;

/** GET /api/workspaces/:workspaceId/agent-chat?workflowId&workflowNodeId&agentId[&runId] */
export const AgentChatQuerySchema = AgentChatContextSchema.omit({ workspaceId: true });
export type AgentChatQuery = z.infer<typeof AgentChatQuerySchema>;

/** POST /api/workspaces/:workspaceId/agent-chat/messages */
export const SendAgentChatMessageRequestSchema = z.object({
  /** Idempotency key. A replay with the same key and input returns the stored receipt; never re-sends. */
  requestId: IdSchema,
  context: AgentChatQuerySchema,
  content: z.string().trim().min(1).max(32000),
  intent: AgentChatIntentSchema.default("next_turn"),
  /** Null = the client saw no conversation (first message). A mismatch returns 409 context_stale. */
  expectedConversationId: IdSchema.nullable(),
  /** Required for steer when capabilities.steer is "native_expected_turn". */
  expectedNativeTurnId: IdSchema.optional(),
}).strict();
export type SendAgentChatMessageRequest = z.infer<typeof SendAgentChatMessageRequestSchema>;
export const SendAgentChatMessageResponseSchema = z.object({
  state: AgentChatStateSchema,
  turn: AgentChatTurnSchema,
  replayed: z.boolean(),
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
}).strict();
export const AgentChatStateResponseSchema = z.object({ state: AgentChatStateSchema }).strict();

/** GET .../conversations/:conversationId/history?before&limit — older messages. */
export const AgentChatHistoryPageSchema = z.object({
  conversationId: IdSchema,
  messages: z.array(MessageSchema).max(100),
  nextCursor: OperatorActivityCursorSchema.nullable(),
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
  agentChatFixtureContext, agentChatFixtures, codexChatCapabilities, openCodeChatCapabilities, steerUnavailableCapabilities,
} from "./agentChatFixtures.js";
