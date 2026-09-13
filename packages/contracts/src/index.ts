import { z } from "zod";

/** A non-empty identifier. IDs are intentionally unbranded at the API boundary. */
export const IdSchema = z.string().trim().min(1);
export type Id = z.infer<typeof IdSchema>;

export const TimestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

const OptionalTimestampFields = {
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
} as const;

/** A workspace is the top-level scope for agents, workflows, conversations and resources. */
export const WorkspaceSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    agentIds: z.array(IdSchema).optional(),
    workflowIds: z.array(IdSchema).optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const AgentStatusSchema = z.enum([
  "available",
  "working",
  "waiting_browser",
  "auth_required",
  "interrupted",
  "disconnected",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export const AgentExecutionStateSchema = AgentStatusSchema;
export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

export const AgentRoleSchema = z.string().trim().min(1);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const HarnessStatusSchema = z.enum(["ready", "running", "disconnected", "unavailable"]);
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/** A small runner/harness projection suitable for an Agent context panel. */
export const HarnessSummarySchema = z
  .object({
    status: HarnessStatusSchema,
    label: z.string().trim().min(1).optional(),
    detail: z.string().optional(),
    runnerId: IdSchema.optional(),
  })
  .strict();
export type HarnessSummary = z.infer<typeof HarnessSummarySchema>;

/** An Agent is a separately addressable worker; workflow nodes reference it by agentId. */
export const AgentSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    role: AgentRoleSchema.optional(),
    status: AgentStatusSchema.optional(),
    executionState: AgentExecutionStateSchema.optional(),
    /** Links this logical Agent projection to its current run summary, if any. */
    activeRunId: IdSchema.optional(),
    harnessSummary: HarnessSummarySchema.optional(),
    model: z.string().trim().min(1).optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Agent = z.infer<typeof AgentSchema>;

export const ExecutionConditionKindSchema = z.enum([
  "manual",
  "on_message",
  "on_event",
  "schedule",
]);
export type ExecutionConditionKind = z.infer<typeof ExecutionConditionKindSchema>;

/** The condition that makes a workflow eligible to start. It is not a run outcome. */
export const ExecutionConditionSchema = z
  .object({
    kind: ExecutionConditionKindSchema,
    description: z.string().trim().min(1).optional(),
  })
  .strict();
export type ExecutionCondition = z.infer<typeof ExecutionConditionSchema>;

export const WorkflowNodeSchema = z
  .object({
    id: IdSchema,
    agentId: IdSchema,
    name: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.name && !value.label) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "a workflow node requires name or label",
      });
    }
  });
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z
  .object({
    id: IdSchema,
    source: IdSchema,
    target: IdSchema,
    label: z.string().optional(),
  })
  .strict();
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    executionCondition: ExecutionConditionSchema,
    nodes: z.array(WorkflowNodeSchema),
    edges: z.array(WorkflowEdgeSchema),
    version: z.number().int().positive().optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const ConversationStatusSchema = z.enum(["open", "archived"]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ConversationSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    agentId: IdSchema,
    title: z.string().optional(),
    status: ConversationStatusSchema.optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z
  .object({
    id: IdSchema,
    conversationId: IdSchema,
    role: MessageRoleSchema,
    content: z.string(),
    ...OptionalTimestampFields,
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const RunExecutionStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "interrupted",
  "completed",
]);
export type RunExecutionState = z.infer<typeof RunExecutionStateSchema>;

/** A terminal task result. An interrupted run has no successful/failed outcome by implication. */
export const RunOutcomeSchema = z.enum(["pending", "succeeded", "failed", "canceled"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const BrowserWaitReasonSchema = z.enum([
  "auth_required",
  "browser_profile",
  "operator_input",
  "browser_unavailable",
  "rate_limited",
  "other",
]);
export type BrowserWaitReason = z.infer<typeof BrowserWaitReasonSchema>;

export const ResourceHolderSchema = z.enum(["none", "operator", "runner", "agent"]);
export type ResourceHolder = z.infer<typeof ResourceHolderSchema>;

/** Why a run is waiting for a browser and who currently holds that resource. */
export const BrowserWaitSchema = z
  .object({
    reason: BrowserWaitReasonSchema,
    resourceHolder: ResourceHolderSchema,
    resourceId: IdSchema.optional(),
    resourceName: z.string().trim().min(1).optional(),
    holderId: IdSchema.optional(),
    holderLabel: z.string().trim().min(1).optional(),
    executionId: IdSchema.optional(),
    executionLabel: z.string().trim().min(1).optional(),
  })
  .strict();
export type BrowserWait = z.infer<typeof BrowserWaitSchema>;

export const RunnerHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "offline",
  "disconnected",
  "unknown",
]);
export type RunnerHealthStatus = z.infer<typeof RunnerHealthStatusSchema>;

export const RunnerHealthSchema = z
  .object({
    status: RunnerHealthStatusSchema,
    message: z.string().optional(),
    checkedAt: TimestampSchema.optional(),
  })
  .strict();
export type RunnerHealth = z.infer<typeof RunnerHealthSchema>;

/**
 * A compact run projection for cards and activity views. Execution state, outcome,
 * auth, browser waits and runner health are separate so one cannot stand in for another.
 */
export const WorkflowRunSummarySchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    workflowId: IdSchema,
    executionCondition: ExecutionConditionSchema,
    executionState: RunExecutionStateSchema,
    outcome: RunOutcomeSchema,
    authRequired: z.boolean(),
    browserWait: BrowserWaitSchema.nullable(),
    runnerHealth: RunnerHealthSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict();
export type WorkflowRunSummary = z.infer<typeof WorkflowRunSummarySchema>;
export const RunSummarySchema = WorkflowRunSummarySchema;
export type RunSummary = WorkflowRunSummary;

export const ResourceKindSchema = z.enum(["browser", "file", "document", "tool", "other"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const ResourceStatusSchema = z.enum([
  "available",
  "in_use",
  "waiting",
  "auth_required",
  "unavailable",
]);
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;

export const ResourceSummarySchema = z
  .object({
    id: IdSchema,
    kind: ResourceKindSchema,
    name: z.string().trim().min(1),
    status: ResourceStatusSchema,
    resourceHolder: ResourceHolderSchema,
    authRequired: z.boolean(),
  })
  .strict();
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;
export const VisibleResourceSchema = ResourceSummarySchema;
export type VisibleResource = ResourceSummary;

export const BrowserProfileStatusSchema = z.enum([
  "available",
  "in_use",
  "waiting",
  "auth_required",
  "unavailable",
]);
export type BrowserProfileStatus = z.infer<typeof BrowserProfileStatusSchema>;

/** A browser profile summary is a resource projection, not a browser implementation. */
export const BrowserProfileSummarySchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    status: BrowserProfileStatusSchema,
    authRequired: z.boolean(),
    resourceHolder: ResourceHolderSchema,
    runnerId: IdSchema.optional(),
  })
  .strict();
export type BrowserProfileSummary = z.infer<typeof BrowserProfileSummarySchema>;

export const RunnerSummarySchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    health: RunnerHealthSchema,
  })
  .strict();
export type RunnerSummary = z.infer<typeof RunnerSummarySchema>;

export const ApiErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: IdSchema.optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiErrorResponseSchema = z
  .object({
    error: ApiErrorSchema,
  })
  .strict();
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export const ErrorResponseSchema = ApiErrorResponseSchema;
export type ErrorResponse = ApiErrorResponse;

export const WorkspaceDetailsSchema = z
  .object({
    workspace: WorkspaceSchema,
    agents: z.array(AgentSchema),
    workflows: z.array(WorkflowDefinitionSchema),
    runs: z.array(WorkflowRunSummarySchema),
    resources: z.array(ResourceSummarySchema),
    browserProfiles: z.array(BrowserProfileSummarySchema).optional(),
    runners: z.array(RunnerSummarySchema).optional(),
  })
  .strict();
export type WorkspaceDetails = z.infer<typeof WorkspaceDetailsSchema>;

export const WorkspaceDetailsRequestSchema = z
  .object({ workspaceId: IdSchema })
  .strict();
export type WorkspaceDetailsRequest = z.infer<typeof WorkspaceDetailsRequestSchema>;
export const WorkspaceDetailsResponseSchema = WorkspaceDetailsSchema;
export type WorkspaceDetailsResponse = WorkspaceDetails;
export const GetWorkspaceDetailsRequestSchema = WorkspaceDetailsRequestSchema;
export type GetWorkspaceDetailsRequest = WorkspaceDetailsRequest;
export const GetWorkspaceDetailsResponseSchema = WorkspaceDetailsResponseSchema;
export type GetWorkspaceDetailsResponse = WorkspaceDetailsResponse;

export const ListAgentsRequestSchema = WorkspaceDetailsRequestSchema;
export type ListAgentsRequest = WorkspaceDetailsRequest;
export const ListAgentsResponseSchema = z
  .object({ agents: z.array(AgentSchema) })
  .strict();
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

export const GetAgentRequestSchema = z
  .object({ workspaceId: IdSchema, agentId: IdSchema })
  .strict();
export type GetAgentRequest = z.infer<typeof GetAgentRequestSchema>;
export const GetAgentResponseSchema = z
  .object({ agent: AgentSchema })
  .strict();
export type GetAgentResponse = z.infer<typeof GetAgentResponseSchema>;

export const GetWorkflowRequestSchema = z
  .object({ workspaceId: IdSchema, workflowId: IdSchema })
  .strict();
export type GetWorkflowRequest = z.infer<typeof GetWorkflowRequestSchema>;
export const GetWorkflowResponseSchema = z
  .object({ workflow: WorkflowDefinitionSchema })
  .strict();
export type GetWorkflowResponse = z.infer<typeof GetWorkflowResponseSchema>;
export const ReadWorkflowRequestSchema = GetWorkflowRequestSchema;
export type ReadWorkflowRequest = GetWorkflowRequest;
export const ReadWorkflowResponseSchema = GetWorkflowResponseSchema;
export type ReadWorkflowResponse = GetWorkflowResponse;

export const SaveWorkflowRequestSchema = z
  .object({
    workspaceId: IdSchema,
    workflow: WorkflowDefinitionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workspaceId !== value.workflow.workspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow", "workspaceId"],
        message: "workflow.workspaceId must match workspaceId",
      });
    }
  });
export type SaveWorkflowRequest = z.infer<typeof SaveWorkflowRequestSchema>;
export const SaveWorkflowResponseSchema = z
  .object({ workflow: WorkflowDefinitionSchema })
  .strict();
export type SaveWorkflowResponse = z.infer<typeof SaveWorkflowResponseSchema>;
export const ReadWorkflowDefinitionRequestSchema = GetWorkflowRequestSchema;
export const ReadWorkflowDefinitionResponseSchema = GetWorkflowResponseSchema;
export const SaveWorkflowDefinitionRequestSchema = SaveWorkflowRequestSchema;
export const SaveWorkflowDefinitionResponseSchema = SaveWorkflowResponseSchema;

export const ListConversationsRequestSchema = WorkspaceDetailsRequestSchema;
export type ListConversationsRequest = WorkspaceDetailsRequest;
export const ListConversationsResponseSchema = z
  .object({ conversations: z.array(ConversationSchema) })
  .strict();
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;
export const ConversationsResponseSchema = ListConversationsResponseSchema;
export type ConversationsResponse = ListConversationsResponse;

export const GetConversationRequestSchema = z
  .object({ workspaceId: IdSchema, conversationId: IdSchema })
  .strict();
export type GetConversationRequest = z.infer<typeof GetConversationRequestSchema>;
export const GetConversationResponseSchema = z
  .object({
    conversation: ConversationSchema,
    messages: z.array(MessageSchema),
  })
  .strict();
export type GetConversationResponse = z.infer<typeof GetConversationResponseSchema>;

export const ListMessagesRequestSchema = z
  .object({ workspaceId: IdSchema, conversationId: IdSchema })
  .strict();
export type ListMessagesRequest = z.infer<typeof ListMessagesRequestSchema>;
export const ListMessagesResponseSchema = z
  .object({ messages: z.array(MessageSchema) })
  .strict();
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;
export const MessagesResponseSchema = ListMessagesResponseSchema;
export type MessagesResponse = ListMessagesResponse;

export const CreateMessageRequestSchema = z
  .object({
    workspaceId: IdSchema,
    conversationId: IdSchema,
    role: MessageRoleSchema,
    content: z.string(),
  })
  .strict();
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
export const CreateMessageResponseSchema = z
  .object({ message: MessageSchema })
  .strict();
export type CreateMessageResponse = z.infer<typeof CreateMessageResponseSchema>;

export const ListVisibleResourcesRequestSchema = WorkspaceDetailsRequestSchema;
export type ListVisibleResourcesRequest = WorkspaceDetailsRequest;
export const ListVisibleResourcesResponseSchema = z
  .object({
    resources: z.array(ResourceSummarySchema),
    browserProfiles: z.array(BrowserProfileSummarySchema).optional(),
    runners: z.array(RunnerSummarySchema).optional(),
  })
  .strict();
export type ListVisibleResourcesResponse = z.infer<typeof ListVisibleResourcesResponseSchema>;
export const VisibleResourcesResponseSchema = ListVisibleResourcesResponseSchema;
export type VisibleResourcesResponse = ListVisibleResourcesResponse;

/** Scenario IDs are URL-safe and intentionally open-ended for additive Phase 1 scenarios. */
export const ScenarioIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "scenario id must be URL-safe");
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

/** The subset of URL search state that selects a Phase 1 scenario/resource. */
export const UrlSearchSelectionSchema = z
  .object({
    scenarioId: ScenarioIdSchema.optional(),
    workspaceId: IdSchema.optional(),
    agentId: IdSchema.optional(),
    workflowId: IdSchema.optional(),
    conversationId: IdSchema.optional(),
  })
  .strict();
export type UrlSearchSelection = z.infer<typeof UrlSearchSelectionSchema>;
export const ScenarioSelectionSchema = UrlSearchSelectionSchema;
export type ScenarioSelection = UrlSearchSelection;
