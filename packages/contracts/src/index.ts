import { z } from "zod";

/** A non-empty identifier. IDs are intentionally unbranded at the API boundary. */
export const IdSchema = z.string().trim().min(1);
export type Id = z.infer<typeof IdSchema>;

export const TimestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Runner-owned directory inherited by every workflow and Agent in a workspace. */
export const ExecutionLocationSchema = z
  .object({
    runnerId: IdSchema,
    rootPath: z.string().min(1).refine((value) => !value.includes("\0"), "rootPath cannot contain NUL"),
  })
  .strict();
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;

/** Immutable location accepted together with a new Run. */
export const RunExecutionLocationSchema = ExecutionLocationSchema.extend({
  locationRevision: z.number().int().nonnegative(),
  /** Opaque runner-side identity used to detect replacement of the accepted directory. */
  identityHash: z.string().startsWith("sha256:"),
}).strict();
export type RunExecutionLocation = z.infer<typeof RunExecutionLocationSchema>;

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

/** Product authority role. Free-form Agent.role remains display metadata only. */
export const AgentProductRoleSchema = z.enum(["orchestrator", "coder", "operator"]);
export type AgentProductRole = z.infer<typeof AgentProductRoleSchema>;

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

export const AgentHarnessSchema = z.enum(["codex", "opencode"]);
export type AgentHarness = z.infer<typeof AgentHarnessSchema>;
export const AgentEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type AgentEffort = z.infer<typeof AgentEffortSchema>;

/** A Skill Hub reference pinned when an agent configuration version is created. */
export const AssignedSkillSchema = z
  .object({
    skillId: IdSchema,
    version: z.string().trim().min(1),
  })
  .strict();
export type AssignedSkill = z.infer<typeof AssignedSkillSchema>;

export const AgentPromptSchema = z
  .object({
    system: z.string().trim().min(1).optional(),
  })
  .strict();
export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

const WritableRootSchema = z.string().min(1)
  .refine((value) => !value.includes("\0"), "path cannot contain NUL")
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "path must be absolute");
export const CodexMcpToolApprovalModeSchema = z.enum(["auto", "prompt", "writes", "approve"]);
export const CodexMcpToolPolicySchema = z.object({
  enabled: z.boolean().optional(),
  approvalMode: CodexMcpToolApprovalModeSchema.optional(),
}).strict();
export type CodexMcpToolPolicy = z.infer<typeof CodexMcpToolPolicySchema>;
export const CodexMcpServerSettingsSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  enabledTools: z.array(z.string().trim().min(1)).optional(),
  disabledTools: z.array(z.string().trim().min(1)).optional(),
  defaultToolsApprovalMode: CodexMcpToolApprovalModeSchema.optional(),
  tools: z.record(z.string().trim().min(1), CodexMcpToolPolicySchema).optional(),
}).strict().superRefine((value, context) => {
  if (value.required && !value.enabled) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["required"], message: "a required MCP server must be enabled" });
  }
  const disabled = new Set(value.disabledTools ?? []);
  for (const [index, tool] of (value.enabledTools ?? []).entries()) {
    if (disabled.has(tool)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledTools", index], message: "enabled and disabled MCP tools must be disjoint" });
  }
});
export const CodexAdvancedConfigurationSchema = z.object({
  approvalPolicy: z.enum(["on-request", "never"]),
  approvalsReviewer: z.enum(["user", "auto_review"]),
  additionalWritableDirectories: z.array(WritableRootSchema),
  workspaceWrite: z.object({
    networkAccess: z.boolean(), excludeTmpdirEnvVar: z.boolean(), excludeSlashTmp: z.boolean(),
  }).strict().optional(),
  sessionPersistence: z.enum(["persistent", "ephemeral"]),
  shellEnvironment: z.object({
    inherit: z.enum(["all", "core", "none"]),
    ignoreDefaultExcludes: z.boolean(),
    filters: z.record(z.string().trim().min(1), z.enum(["include", "exclude"])),
    set: z.record(z.string().trim().min(1), z.string()),
  }).strict(),
  webSearch: z.enum(["disabled", "cached", "live"]),
  mcpServers: z.record(z.string().trim().min(1), CodexMcpServerSettingsSchema),
}).strict();
export type CodexAdvancedConfiguration = z.infer<typeof CodexAdvancedConfigurationSchema>;
export const DEFAULT_CODEX_ADVANCED_CONFIGURATION: CodexAdvancedConfiguration = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  additionalWritableDirectories: [],
  sessionPersistence: "persistent",
  shellEnvironment: { inherit: "all", ignoreDefaultExcludes: false, filters: {}, set: {} },
  webSearch: "cached",
  mcpServers: {},
};

export const OpenCodePermissionRuleSchema = z.object({
  permission: z.string().trim().min(1),
  pattern: z.string().min(1),
  effect: z.enum(["allow", "ask", "deny"]),
}).strict();
export const OpenCodeAdvancedConfigurationSchema = z.object({
  apiVersion: z.literal("v1"),
  permissionRules: z.array(OpenCodePermissionRuleSchema),
  permissionHandling: z.enum(["graphql_routed", "native_auto"]),
  subagentDepth: z.number().int().nonnegative().optional(),
  plugins: z.object({ mode: z.enum(["inherit", "pure"]) }).strict(),
  compaction: z.object({
    auto: z.boolean(), prune: z.boolean(), reservedTokens: z.number().int().nonnegative().optional(),
    tailTurns: z.number().int().nonnegative().optional(), preserveRecentTokens: z.number().int().nonnegative().optional(),
  }).strict(),
  configLoading: z.object({ mode: z.literal("native") }).strict(),
  mcp: z.object({ serverEnabled: z.record(z.string().trim().min(1), z.boolean()) }).strict(),
}).strict();
export type OpenCodeAdvancedConfiguration = z.infer<typeof OpenCodeAdvancedConfigurationSchema>;
export const DEFAULT_OPENCODE_ADVANCED_CONFIGURATION: OpenCodeAdvancedConfiguration = {
  apiVersion: "v1", permissionRules: [], permissionHandling: "graphql_routed",
  plugins: { mode: "inherit" }, compaction: { auto: true, prune: false },
  configLoading: { mode: "native" }, mcp: { serverEnabled: {} },
};

export const CodexHarnessConfigurationSchema = z
  .object({
    harness: z.literal("codex"),
    model: z.string().trim().min(1),
    reasoningEffort: AgentEffortSchema,
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    serviceTier: z.enum(["standard", "priority"]),
    advanced: CodexAdvancedConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sandbox !== "workspace-write" && value.advanced
      && (value.advanced.additionalWritableDirectories.length > 0 || value.advanced.workspaceWrite !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["advanced", "workspaceWrite"], message: "writable directories and workspace controls require workspace-write sandbox" });
    }
  });
export type CodexHarnessConfiguration = z.infer<typeof CodexHarnessConfigurationSchema>;

export const OpenCodeHarnessConfigurationSchema = z
  .object({
    harness: z.literal("opencode"),
    model: z.string().trim().min(1),
    /** Empty string delegates to the native default; named variants require provider evidence. */
    variant: z.string().trim(),
    nativeAgent: z.string().trim().min(1),
    thinking: z.boolean(),
    autoApprove: z.boolean(),
    advanced: OpenCodeAdvancedConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.advanced && value.autoApprove !== (value.advanced.permissionHandling === "native_auto")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["autoApprove"], message: "legacy autoApprove must match Advanced permission handling" });
    }
  });
export type OpenCodeHarnessConfiguration = z.infer<typeof OpenCodeHarnessConfigurationSchema>;

/** Harness settings stay discriminated because native CLIs expose different capabilities. */
export const HarnessConfigurationSchema = z.discriminatedUnion("harness", [
  CodexHarnessConfigurationSchema,
  OpenCodeHarnessConfigurationSchema,
]);
export type HarnessConfiguration = z.infer<typeof HarnessConfigurationSchema>;

export const ApprovalHandlerSchema = z.enum(["user", "orchestrator", "operator"]);
export type ApprovalHandler = z.infer<typeof ApprovalHandlerSchema>;

export const HarnessWorkflowCompatibilitySchema = z.object({
  configuration: HarnessConfigurationSchema,
  workflowApprovalHandler: ApprovalHandlerSchema.optional(),
}).strict().superRefine((value, context) => {
  if (!value.workflowApprovalHandler) return;
  if (value.configuration.harness === "codex" && value.configuration.advanced?.approvalsReviewer === "auto_review") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["configuration", "advanced", "approvalsReviewer"], message: "native auto review conflicts with GraphQL-routed approval" });
  }
  // Legacy records can omit Advanced settings. Both representations must obey
  // the same workflow approval boundary before the fallback can enable --auto.
  if (value.configuration.harness === "opencode"
    && (value.configuration.autoApprove || value.configuration.advanced?.permissionHandling === "native_auto")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.configuration.advanced
        ? ["configuration", "advanced", "permissionHandling"]
        : ["configuration", "autoApprove"],
      message: "native auto approval conflicts with GraphQL-routed approval",
    });
  }
});
export function validateHarnessWorkflowCompatibility(
  configuration: HarnessConfiguration,
  workflowApprovalHandler?: ApprovalHandler,
): HarnessConfiguration {
  return HarnessWorkflowCompatibilitySchema.parse({ configuration, workflowApprovalHandler }).configuration;
}

/** Editable selection. Orchestrator designation may remain incomplete until executable save. */
export const WorkflowApprovalConfigurationSchema = z
  .object({
    handler: ApprovalHandlerSchema,
    designatedOrchestratorAgentId: IdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.handler !== "orchestrator" && value.designatedOrchestratorAgentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["designatedOrchestratorAgentId"], message: "only orchestrator handling may designate an Orchestrator" });
    }
  });
export type WorkflowApprovalConfiguration = z.infer<typeof WorkflowApprovalConfigurationSchema>;

/** Complete immutable assignment accepted into workflow and Run snapshots. */
export const AcceptedWorkflowApprovalConfigurationSchema = z
  .object({
    handler: ApprovalHandlerSchema,
    designatedOrchestratorAgentId: IdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.handler === "orchestrator" && !value.designatedOrchestratorAgentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["designatedOrchestratorAgentId"], message: "accepted orchestrator handling requires a designated Orchestrator" });
    }
    if (value.handler !== "orchestrator" && value.designatedOrchestratorAgentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["designatedOrchestratorAgentId"], message: "only orchestrator handling may designate an Orchestrator" });
    }
  });
export type AcceptedWorkflowApprovalConfiguration = z.infer<typeof AcceptedWorkflowApprovalConfigurationSchema>;

export const AgentTemplateSchema = z.object({
  role: AgentProductRoleSchema,
  boardAddable: z.boolean(),
  harness: HarnessConfigurationSchema,
}).strict().superRefine((value, context) => {
  if (value.role === "operator" && value.boardAddable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["boardAddable"], message: "Operator is application-level and cannot be added to a workflow board" });
  }
});
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

export const AgentDefaultsSchema = z.object({
  orchestrator: AgentTemplateSchema.safeExtend({ role: z.literal("orchestrator"), boardAddable: z.literal(true) }),
  coder: AgentTemplateSchema.safeExtend({ role: z.literal("coder"), boardAddable: z.literal(true) }),
  operator: AgentTemplateSchema.safeExtend({
    role: z.literal("operator"), boardAddable: z.literal(false), uiEnabled: z.boolean(),
  }),
}).strict();
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

export const WorkflowDefaultsSchema = z.object({ approvalHandler: ApprovalHandlerSchema }).strict();
export type WorkflowDefaults = z.infer<typeof WorkflowDefaultsSchema>;

export const VersionedAgentDefaultsSchema = z.object({
  value: AgentDefaultsSchema, versionId: IdSchema.nullable(), revision: z.number().int().nonnegative(),
}).strict();
export const GetAgentDefaultsResponseSchema = VersionedAgentDefaultsSchema;
export const UpdateAgentDefaultsRequestSchema = z.object({
  value: AgentDefaultsSchema, expectedRevision: z.number().int().nonnegative(),
}).strict();
export const UpdateAgentDefaultsResponseSchema = VersionedAgentDefaultsSchema;

export const VersionedWorkflowDefaultsSchema = z.object({
  value: WorkflowDefaultsSchema, versionId: IdSchema.nullable(), revision: z.number().int().nonnegative(),
}).strict();
export const GetWorkflowDefaultsResponseSchema = VersionedWorkflowDefaultsSchema;
export const UpdateWorkflowDefaultsRequestSchema = z.object({
  value: WorkflowDefaultsSchema, expectedRevision: z.number().int().nonnegative(),
}).strict();
export const UpdateWorkflowDefaultsResponseSchema = VersionedWorkflowDefaultsSchema;

/** Global templates copied into new board Agents. Prompts and skills never belong here. */
export const HarnessDefaultsSchema = z
  .object({
    codex: CodexHarnessConfigurationSchema,
    opencode: OpenCodeHarnessConfigurationSchema,
  })
  .strict();
export type HarnessDefaults = z.infer<typeof HarnessDefaultsSchema>;
export const DEFAULT_HARNESS_DEFAULTS: HarnessDefaults = HarnessDefaultsSchema.parse({
  codex: {
    harness: "codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    sandbox: "read-only",
    serviceTier: "standard",
    advanced: DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  },
  opencode: {
    harness: "opencode",
    model: "opencode-go/deepseek-v4.1-flash",
    variant: "max",
    nativeAgent: "build",
    thinking: false,
    autoApprove: false,
    advanced: DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  },
});

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = AgentDefaultsSchema.parse({
  orchestrator: {
    role: "orchestrator", boardAddable: true,
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex },
  },
  coder: {
    role: "coder", boardAddable: true,
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex },
  },
  operator: {
    role: "operator", boardAddable: false, uiEnabled: true,
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex },
  },
});

/** A designated Orchestrator is selected when a workflow is created. */
export const DEFAULT_WORKFLOW_APPROVAL_HANDLER: ApprovalHandler = "orchestrator";

export const HarnessQualificationSchema = z
  .object({
    harness: AgentHarnessSchema,
    version: z.string().trim().min(1),
    authenticated: z.boolean(),
    ready: z.boolean(),
    structuredEvents: z.boolean(),
    supportsResume: z.boolean(),
    supportsCancellation: z.boolean(),
    supportsWorkingDirectory: z.boolean(),
    supportsStartupPrompt: z.boolean(),
    supportedNativeTools: z.array(z.string().trim().min(1)),
    supportedSettings: z.array(z.string().trim().min(1)),
    unsupportedCapabilities: z.array(z.string().trim().min(1)),
  })
  .strict();
export type HarnessQualification = z.infer<typeof HarnessQualificationSchema>;

export const McpDetectionStateSchema = z.enum([
  "not_detected", "misconfigured", "status_unavailable", "connected", "disabled",
  "authentication_required", "broken", "check_failed",
]);
export const McpDetectionSchema = z.object({
  harness: AgentHarnessSchema,
  serverName: z.string().trim().min(1),
  state: McpDetectionStateSchema,
  endpointMatches: z.boolean().nullable(),
  credentialEnvironmentVariable: z.string().trim().min(1).nullable(),
  checkedAt: TimestampSchema,
  detail: z.string().optional(),
}).strict();
export type McpDetection = z.infer<typeof McpDetectionSchema>;

export const ScopedMcpDetectionSchema = z.object({
  detection: McpDetectionSchema,
  runnerId: IdSchema,
  workingDirectory: z.string().min(1).refine((value) => !value.includes("\0"), "workingDirectory cannot contain NUL"),
  providerVersion: z.string().trim().min(1),
  nativeFilters: z.object({
    enabledTools: z.array(z.string()).optional(),
    disabledTools: z.array(z.string()).optional(),
    diagnostics: z.array(z.string()).optional(),
  }).strict(),
}).strict();
export type ScopedMcpDetection = z.infer<typeof ScopedMcpDetectionSchema>;

export const NativeHarnessCapabilitiesSchema = z.object({
  provider: AgentHarnessSchema,
  providerVersion: z.string().trim().min(1),
  persistentSessions: z.boolean(),
  reconnect: z.boolean(),
  sameRequestResponses: z.boolean(),
  cancellation: z.boolean(),
  history: z.boolean(),
  configurationInspection: z.boolean(),
  mcpDetection: z.boolean(),
  supportedInteractionKinds: z.array(z.string().trim().min(1)),
}).strict();
export type NativeHarnessCapabilities = z.infer<typeof NativeHarnessCapabilitiesSchema>;

export const ApprovalResponseSemanticSchema = z.enum([
  "approve_once", "allow_turn", "allow_session", "reject", "cancel",
  "provider_scoped_allow", "persistent_policy_change",
]);
export const ApprovalPersistenceSchema = z.enum([
  "request", "turn", "session", "provider_instance", "project", "persistent_config",
]);
export const ApprovalResponseOptionSchema = z.object({
  optionId: IdSchema,
  semantic: ApprovalResponseSemanticSchema,
  label: z.string().trim().min(1),
  persistence: ApprovalPersistenceSchema,
  scopeSummary: z.string().trim().min(1).optional(),
  affectsOtherPendingRequests: z.boolean(),
  interruptsCurrentTurn: z.boolean(),
  mutatesPersistentPolicy: z.boolean(),
}).strict();
export type ApprovalResponseOption = z.infer<typeof ApprovalResponseOptionSchema>;

export const CodexSessionCompatibilitySchema = z.object({
  configuration: CodexHarnessConfigurationSchema,
  responseOptions: z.array(ApprovalResponseOptionSchema).default([]),
  requiresResume: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.configuration.advanced?.sessionPersistence !== "ephemeral") return;
  if (value.requiresResume) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requiresResume"], message: "ephemeral Codex sessions cannot support resume-dependent features" });
  }
  value.responseOptions.forEach((option, index) => {
    if (option.semantic === "allow_session") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["responseOptions", index], message: "ephemeral Codex sessions cannot offer session allowance" });
    }
  });
});

export const InteractionStatusSchema = z.enum(["pending", "decided", "delivery_pending", "delivered", "delivery_failed", "canceled"]);
export const NativeDeliveryStateSchema = z.enum(["not_started", "pending", "submitted", "uncertain", "delivered", "failed"]);
export const DurableInteractionSchema = z.object({
  id: IdSchema,
  revision: z.number().int().nonnegative(),
  workspaceId: IdSchema,
  workflowId: IdSchema,
  runId: IdSchema,
  executionId: IdSchema,
  requestingAgentId: IdSchema,
  harness: AgentHarnessSchema,
  providerVersion: z.string().trim().min(1),
  nativeSessionId: IdSchema,
  nativeRequestId: IdSchema,
  nativeRequestType: z.string().trim().min(1),
  graphThreadId: IdSchema,
  graphInterruptId: IdSchema.optional(),
  request: z.json(),
  approval: AcceptedWorkflowApprovalConfigurationSchema,
  responseOptions: z.array(ApprovalResponseOptionSchema).min(1),
  status: InteractionStatusSchema,
  selectedOptionId: IdSchema.optional(),
  selectedSemantic: ApprovalResponseSemanticSchema.optional(),
  nativeResponse: z.json().optional(),
  deliveryState: NativeDeliveryStateSchema,
  auditReference: IdSchema.optional(),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.optional(),
  deliveredAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();
export type DurableInteraction = z.infer<typeof DurableInteractionSchema>;

export const NativeSessionReferenceSchema = z.object({
  harness: AgentHarnessSchema,
  providerVersion: z.string().trim().min(1),
  nativeSessionId: IdSchema,
}).strict();
export type NativeSessionReference = z.infer<typeof NativeSessionReferenceSchema>;
export const NativeTurnReferenceSchema = z.object({
  nativeTurnId: IdSchema,
  nativeRequestId: IdSchema.optional(),
}).strict();
export type NativeTurnReference = z.infer<typeof NativeTurnReferenceSchema>;
export const NativeHarnessEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.string().trim().min(1),
  occurredAt: TimestampSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type NativeHarnessEvent = z.infer<typeof NativeHarnessEventSchema>;
export const PendingNativeInteractionSchema = z.object({
  session: NativeSessionReferenceSchema,
  turn: NativeTurnReferenceSchema,
  nativeRequestType: z.string().trim().min(1),
  request: z.json(),
  responseOptions: z.array(ApprovalResponseOptionSchema).min(1),
}).strict();
export type PendingNativeInteraction = z.infer<typeof PendingNativeInteractionSchema>;

export const ActiveTimeBudgetSchema = z.object({
  activeTimeoutMs: z.number().int().positive(),
  activeElapsedMs: z.number().int().nonnegative(),
  approvalWaitStartedAt: TimestampSchema.optional(),
  infrastructureDeadlineAt: TimestampSchema.optional(),
}).strict();
export const NativeCancellationSchema = z.object({
  requestedAt: TimestampSchema,
  reason: z.string().trim().min(1).optional(),
  nativeAcknowledgedAt: TimestampSchema.optional(),
}).strict();

export const NativeSessionLaneSchema = z.object({
  id: IdSchema,
  harness: AgentHarnessSchema,
  nativeSessionId: IdSchema,
  ownerAgentId: IdSchema,
  leaseOwner: IdSchema.optional(),
  leaseToken: IdSchema.optional(),
  leaseExpiresAt: TimestampSchema.optional(),
  correlationId: IdSchema.optional(),
  observedStatus: z.enum(["idle", "busy", "disconnected", "uncertain"]),
  currentTurnOrMessageId: IdSchema.optional(),
  connectionGeneration: z.number().int().nonnegative(),
  observedAt: TimestampSchema,
  revision: z.number().int().nonnegative(),
}).strict();
export type NativeSessionLane = z.infer<typeof NativeSessionLaneSchema>;

export const ReviewJobSchema = z.object({
  id: IdSchema,
  interactionId: IdSchema,
  reviewerAgentId: IdSchema,
  attempt: z.number().int().nonnegative(),
  state: z.enum(["pending", "leased", "submitted", "acknowledged", "completed", "blocked_busy", "blocked_disconnected", "uncertain", "failed"]),
  provider: AgentHarnessSchema,
  nativeSessionId: IdSchema,
  providerTurnOrMessageId: IdSchema.optional(),
  leaseOwner: IdSchema.optional(),
  leaseToken: IdSchema.optional(),
  leaseExpiresAt: TimestampSchema.optional(),
  correlationId: IdSchema,
  error: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict().optional(),
  createdAt: TimestampSchema,
  submittedAt: TimestampSchema.optional(),
  acknowledgedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
}).strict();
export type ReviewJob = z.infer<typeof ReviewJobSchema>;

/** An Agent is a separately addressable worker; workflow nodes reference it by agentId. */
export const AgentSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    description: z.string().optional(),
    role: AgentRoleSchema.optional(),
    /** Server-owned product role; never derived from role or model output. */
    productRole: z.enum(["orchestrator", "coder"]).optional(),
    status: AgentStatusSchema.optional(),
    executionState: AgentExecutionStateSchema.optional(),
    /** Links this logical Agent projection to its current run summary, if any. */
    activeRunId: IdSchema.optional(),
    harnessSummary: HarnessSummarySchema.optional(),
    harness: AgentHarnessSchema.optional(),
    model: z.string().trim().min(1).optional(),
    effort: AgentEffortSchema.optional(),
    fastMode: z.boolean().optional(),
    harnessConfiguration: HarnessConfigurationSchema.optional(),
    configurationVersionId: IdSchema.optional(),
    prompt: AgentPromptSchema.optional(),
    assignedSkills: z.array(AssignedSkillSchema).optional(),
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

export const WorkflowJoinSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("any") }).strict(),
  z
    .object({
      mode: z.literal("threshold"),
      required: z.number().int().positive(),
    })
    .strict(),
]);
export type WorkflowJoin = z.infer<typeof WorkflowJoinSchema>;

export const ResultConditionOperatorSchema = z.enum(["exists", "equals", "not_equals"]);
export type ResultConditionOperator = z.infer<typeof ResultConditionOperatorSchema>;

export const ResultConditionSchema = z
  .object({
    path: z.array(z.string().trim().min(1)).min(1),
    operator: ResultConditionOperatorSchema,
    value: z.json().optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (condition.operator !== "exists" && condition.value === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "equals and not_equals conditions require a value",
      });
    }
  });
export type ResultCondition = z.infer<typeof ResultConditionSchema>;

/** Explicit routing facts evaluated after a source node reaches a terminal outcome. */
export const WorkflowRouteSchema = z
  .object({
    outcomes: z.array(z.enum(["succeeded", "failed", "canceled"])).min(1),
    result: ResultConditionSchema.optional(),
    /** Bounds loop edges. Omit for a one-time dependency. */
    maxTraversals: z.number().int().positive().optional(),
  })
  .strict();
export type WorkflowRoute = z.infer<typeof WorkflowRouteSchema>;

export const WorkflowExecutionPolicySchema = z
  .object({
    maxParallelism: z.number().int().positive(),
    /** Global safety bound across first attempts and repeats. */
    maxNodeExecutions: z.number().int().positive(),
  })
  .strict();
export type WorkflowExecutionPolicy = z.infer<typeof WorkflowExecutionPolicySchema>;

export const WorkflowNodeSchema = z
  .object({
    id: IdSchema,
    agentId: IdSchema,
    name: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    /** User instruction sent to this workflow step, separate from the Agent system prompt. */
    initialPrompt: z.string().trim().min(1).optional(),
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict()
      .optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
    join: WorkflowJoinSchema.optional(),
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
    sourceHandle: z.enum(["top", "right", "bottom", "left"]).nullable().optional(),
    targetHandle: z.enum(["top", "right", "bottom", "left"]).nullable().optional(),
    label: z.string().optional(),
    route: WorkflowRouteSchema.optional(),
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
    /** Missing or incomplete only for legacy/unconfigured records and editable drafts. */
    approval: WorkflowApprovalConfigurationSchema.optional(),
    /** Optional explicit cardinality invariant for workflows with a fixed agent topology. */
    requiredAgentCount: z.number().int().positive().max(10_000).optional(),
    nodes: z.array(WorkflowNodeSchema),
    edges: z.array(WorkflowEdgeSchema),
    version: z.number().int().positive().optional(),
    executionPolicy: WorkflowExecutionPolicySchema.optional(),
    ...OptionalTimestampFields,
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** Immutable workflow snapshot pinned by every run. */
export const WorkflowVersionSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    workflowId: IdSchema,
    version: z.number().int().positive(),
    entryNodeId: IdSchema,
    definition: WorkflowDefinitionSchema,
    agentConfigurationVersionIds: z.record(IdSchema, IdSchema),
    /** Accepted immutable approval assignment; missing only on legacy versions. */
    approval: AcceptedWorkflowApprovalConfigurationSchema.optional(),
    contentHash: z.string().trim().min(1),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.definition.id !== snapshot.workflowId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["definition", "id"],
        message: "definition.id must match workflowId",
      });
    }
    if (snapshot.definition.workspaceId !== snapshot.workspaceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["definition", "workspaceId"],
        message: "definition.workspaceId must match workspaceId",
      });
    }
    if (snapshot.definition.version !== snapshot.version) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["definition", "version"],
        message: "definition.version must match version",
      });
    }
    if (!snapshot.definition.nodes.some((node) => node.id === snapshot.entryNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entryNodeId"],
        message: "entryNodeId must reference a node in the workflow version",
      });
    }
    if (!snapshot.definition.executionPolicy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["definition", "executionPolicy"],
        message: "an executable workflow version requires an execution policy",
      });
    } else if (snapshot.definition.executionPolicy.maxNodeExecutions < snapshot.definition.nodes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["definition", "executionPolicy", "maxNodeExecutions"],
        message: "maxNodeExecutions must allow every workflow node to run once",
      });
    }
    const nodeIds = new Set<string>();
    snapshot.definition.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["definition", "nodes", index, "id"],
          message: "workflow node IDs must be unique",
        });
      }
      nodeIds.add(node.id);
    });
    const edgeIds = new Set<string>();
    snapshot.definition.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["definition", "edges", index, "id"],
          message: "workflow edge IDs must be unique",
        });
      }
      edgeIds.add(edge.id);
      for (const endpoint of ["source", "target"] as const) {
        if (!nodeIds.has(edge[endpoint])) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["definition", "edges", index, endpoint],
            message: `edge ${endpoint} must reference an existing workflow node`,
          });
        }
      }
      if (!edge.route) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["definition", "edges", index, "route"],
          message: "an executable workflow edge requires explicit routing",
        });
      }
    });
    for (const node of snapshot.definition.nodes) {
      if (!snapshot.agentConfigurationVersionIds[node.agentId]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agentConfigurationVersionIds", node.agentId],
          message: "every workflow agent must have a pinned configuration version",
        });
      }
    }
  });
export type WorkflowVersion = z.infer<typeof WorkflowVersionSchema>;

/** Immutable prompt, skill, model and harness settings used to start a native session. */
export const AgentConfigurationVersionSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    agentId: IdSchema,
    productRole: z.enum(["orchestrator", "coder"]).optional(),
    version: z.number().int().positive(),
    prompt: AgentPromptSchema,
    assignedSkills: z.array(AssignedSkillSchema),
    harness: HarnessConfigurationSchema,
    contentHash: z.string().trim().min(1),
    createdAt: TimestampSchema,
  })
  .strict();
export type AgentConfigurationVersion = z.infer<typeof AgentConfigurationVersionSchema>;

export const OperatorConfigurationVersionSchema = z.object({
  id: IdSchema,
  operatorId: IdSchema,
  version: z.number().int().positive(),
  harness: HarnessConfigurationSchema,
  contentHash: z.string().startsWith("sha256:"),
  createdAt: TimestampSchema,
}).strict();
export type OperatorConfigurationVersion = z.infer<typeof OperatorConfigurationVersionSchema>;

export const OperatorAgentSchema = z.object({
  id: IdSchema,
  role: z.literal("operator"),
  name: z.string().trim().min(1),
  currentConfigurationVersionId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();
export type OperatorAgent = z.infer<typeof OperatorAgentSchema>;

export const ConversationStatusSchema = z.enum(["open", "archived"]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ConversationSchema = z
  .object({
    id: IdSchema,
    /** Omitted for application-global Operator conversations. */
    workspaceId: IdSchema.optional(),
    agentId: IdSchema,
    scope: z.enum(["workspace", "application"]).optional(),
    operatorConfigurationVersionId: IdSchema.optional(),
    title: z.string().optional(),
    status: ConversationStatusSchema.optional(),
    ...OptionalTimestampFields,
  })
  .strict()
  .superRefine((value, context) => {
    const scope = value.scope ?? "workspace";
    if (scope === "workspace" && !value.workspaceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceId"], message: "workspace conversations require workspaceId" });
    }
    if (scope === "application" && value.workspaceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceId"], message: "application conversations cannot use a fake workspace" });
    }
    if (scope === "application" && !value.operatorConfigurationVersionId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["operatorConfigurationVersionId"], message: "Operator conversations pin a configuration version" });
    }
  });
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

export const RunInputSchema = z.record(z.string(), z.json());
export type RunInput = z.infer<typeof RunInputSchema>;

export const ExecutionResultSchema = z
  .object({
    outcome: z.enum(["succeeded", "failed", "canceled"]),
    output: z.json().optional(),
    error: z
      .object({
        code: z.string().trim().min(1),
        message: z.string().trim().min(1),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "failed" && !result.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "a failed result requires an error",
      });
    }
    if (result.outcome !== "failed" && result.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "only a failed result may include an error",
      });
    }
  });
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const HarnessExecutionStateSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
]);
export type HarnessExecutionState = z.infer<typeof HarnessExecutionStateSchema>;

/** One native harness attempt for a workflow node. Attempts may share a parallelGroupId. */
export const HarnessExecutionSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    workflowNodeId: IdSchema,
    agentId: IdSchema,
    agentConfigurationVersionId: IdSchema,
    attempt: z.number().int().positive(),
    parallelGroupId: IdSchema.optional(),
    nativeSessionId: IdSchema.optional(),
    /** User project directory selected on the Run. Optional only for legacy history. */
    workingDirectory: z.string().min(1).optional(),
    /** GraphQL-owned attempt storage, always separate from workingDirectory. */
    runtimeDirectory: z.string().min(1).optional(),
    input: z.json(),
    state: HarnessExecutionStateSchema,
    result: ExecutionResultSchema.optional(),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.state === "completed" && (!execution.result || !execution.finishedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "a completed harness execution requires a result and finishedAt",
      });
    }
    if (execution.state !== "completed") {
      for (const field of ["result", "finishedAt"] as const) {
        if (execution[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `a non-completed harness execution cannot include ${field}`,
          });
        }
      }
    }
  });
export type HarnessExecution = z.infer<typeof HarnessExecutionSchema>;

/** Durable run identity; workflow/configuration pins never change after creation. */
export const WorkflowRunSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    workflowId: IdSchema,
    workflowVersionId: IdSchema,
    /** Accepted workspace location snapshot. Absent only on legacy history. */
    executionLocation: RunExecutionLocationSchema.optional(),
    /** Operator authority rechecked before queued and later node execution. */
    authorizationPrincipalId: IdSchema.optional(),
    agentConfigurationVersionIds: z.record(IdSchema, IdSchema),
    /** Immutable accepted approval assignment; absent only for legacy Runs. */
    approval: AcceptedWorkflowApprovalConfigurationSchema.optional(),
    executionCondition: ExecutionConditionSchema,
    executionState: RunExecutionStateSchema,
    outcome: RunOutcomeSchema,
    input: RunInputSchema,
    result: ExecutionResultSchema.optional(),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const terminal = run.executionState === "completed";
    if (terminal && (run.outcome === "pending" || !run.result || !run.finishedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "a completed run requires a terminal outcome, result, and finishedAt",
      });
    }
    if (!terminal && (run.outcome !== "pending" || run.result || run.finishedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "a non-completed run must retain a pending outcome without a result or finishedAt",
      });
    }
    if (run.result && run.result.outcome !== run.outcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result", "outcome"],
        message: "result.outcome must match outcome",
      });
    }
  });
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const ActivitySourceSchema = z.enum(["backend", "langgraph", "harness", "operator"]);
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;

export const ActivityKindSchema = z.enum([
  "run_state_changed",
  "node_scheduled",
  "node_state_changed",
  "harness_session_started",
  "harness_output",
  "harness_session_finished",
  "result_recorded",
  "interaction_pending",
  "interaction_decided",
  "interaction_delivery_state",
  "interaction_resolved",
  "review_job_state",
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** Ordered native/backend activity. payload remains source-specific but JSON-safe. */
export const RunActivitySchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    sequence: z.number().int().nonnegative(),
    source: ActivitySourceSchema,
    kind: ActivityKindSchema,
    harnessExecutionId: IdSchema.optional(),
    occurredAt: TimestampSchema,
    payload: z.record(z.string(), z.json()),
  })
  .strict();
export type RunActivity = z.infer<typeof RunActivitySchema>;

/** One unmodified machine-readable event emitted by a native harness process. */
export const HarnessNativeEventSchema = z
  .object({
    executionId: IdSchema,
    sequence: z.number().int().nonnegative(),
    type: z.string().trim().min(1),
    occurredAt: TimestampSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type HarnessNativeEvent = z.infer<typeof HarnessNativeEventSchema>;

/** Command handed to a harness adapter when initializing a new native session. */
export const HarnessExecutionRequestSchema = z
  .object({
    executionId: IdSchema,
    runId: IdSchema,
    workspaceId: IdSchema,
    workflowNodeId: IdSchema,
    // Validated filesystem paths must cross this boundary without trimming.
    workingDirectory: ExecutionLocationSchema.shape.rootPath,
    runtimeDirectory: ExecutionLocationSchema.shape.rootPath,
    initialPrompt: z.string().trim().min(1).optional(),
    configuration: AgentConfigurationVersionSchema,
    input: z.json(),
  })
  .strict();
export type HarnessExecutionRequest = z.infer<typeof HarnessExecutionRequestSchema>;

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

export const ServiceHealthSchema = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    service: z.literal("graphql-api"),
    checks: z
      .object({
        database: z.enum(["ok", "unavailable"]).optional(),
        checkpoints: z.enum(["ok", "unavailable"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const CreateRunRequestSchema = z
  .object({
    workspaceId: IdSchema,
    workflowId: IdSchema,
    expectedLocationRevision: z.number().int().nonnegative(),
    input: RunInputSchema,
  })
  .strict();
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export const CreateRunResponseSchema = z.object({ run: WorkflowRunSchema }).strict();
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

export const GetRunRequestSchema = z
  .object({ workspaceId: IdSchema, runId: IdSchema })
  .strict();
export type GetRunRequest = z.infer<typeof GetRunRequestSchema>;
export const GetRunResponseSchema = z
  .object({
    run: WorkflowRunSchema,
    executions: z.array(HarnessExecutionSchema),
    activity: z.array(RunActivitySchema),
  })
  .strict();
export type GetRunResponse = z.infer<typeof GetRunResponseSchema>;

export const ListRunActivityRequestSchema = z
  .object({
    workspaceId: IdSchema,
    runId: IdSchema,
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export type ListRunActivityRequest = z.infer<typeof ListRunActivityRequestSchema>;
export const ListRunActivityResponseSchema = z
  .object({ activity: z.array(RunActivitySchema) })
  .strict();
export type ListRunActivityResponse = z.infer<typeof ListRunActivityResponseSchema>;

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
    agents: z.array(AgentSchema).optional(),
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
  .object({
    workflow: WorkflowDefinitionSchema,
    agents: z.array(AgentSchema).optional(),
  })
  .strict();
export type SaveWorkflowResponse = z.infer<typeof SaveWorkflowResponseSchema>;

export const GetHarnessDefaultsResponseSchema = z
  .object({ defaults: HarnessDefaultsSchema })
  .strict();
export type GetHarnessDefaultsResponse = z.infer<typeof GetHarnessDefaultsResponseSchema>;
export const SaveHarnessDefaultsRequestSchema = z
  .object({ defaults: HarnessDefaultsSchema })
  .strict();
export type SaveHarnessDefaultsRequest = z.infer<typeof SaveHarnessDefaultsRequestSchema>;
export const SaveHarnessDefaultsResponseSchema = GetHarnessDefaultsResponseSchema;
export type SaveHarnessDefaultsResponse = GetHarnessDefaultsResponse;
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

export const CreateConversationRequestSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("workspace"), workspaceId: IdSchema, agentId: IdSchema,
    title: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    scope: z.literal("application"), agentId: IdSchema,
    operatorConfigurationVersionId: IdSchema,
    title: z.string().trim().min(1).optional(),
  }).strict(),
]);
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;
export const CreateConversationResponseSchema = z.object({ conversation: ConversationSchema }).strict();
export type CreateConversationResponse = z.infer<typeof CreateConversationResponseSchema>;

export const GetInteractionResponseSchema = z.object({ interaction: DurableInteractionSchema }).strict();
export const ListInteractionsRequestSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), status: InteractionStatusSchema.optional(),
  cursor: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const ListInteractionsResponseSchema = z.object({
  items: z.array(DurableInteractionSchema), nextCursor: IdSchema.nullable(),
}).strict();
export const RespondToInteractionRequestSchema = z.object({
  interactionId: IdSchema, optionId: IdSchema, expectedRevision: z.number().int().nonnegative(),
}).strict();
export const RespondToInteractionResponseSchema = z.object({ interaction: DurableInteractionSchema, replayed: z.boolean() }).strict();

/** Deterministic cross-provider fixtures for contract consumers; exact native payloads stay server-side. */
export const CODEX_APPROVAL_OPTIONS_FIXTURE = ApprovalResponseOptionSchema.array().parse([
  { optionId: "codex-approve-once", semantic: "approve_once", label: "Approve once", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "codex-allow-session", semantic: "allow_session", label: "Allow for this session", persistence: "session", scopeSummary: "Exact command and environment", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "codex-reject", semantic: "reject", label: "Reject", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "codex-cancel", semantic: "cancel", label: "Cancel turn", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: true, mutatesPersistentPolicy: false },
]);
export const OPENCODE_APPROVAL_OPTIONS_FIXTURE = ApprovalResponseOptionSchema.array().parse([
  { optionId: "opencode-approve-once", semantic: "approve_once", label: "Approve once", persistence: "request", affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "opencode-allow-instance", semantic: "provider_scoped_allow", label: "Allow matching requests in this OpenCode instance", persistence: "provider_instance", scopeSummary: "Matching permission patterns across sessions in this instance", affectsOtherPendingRequests: true, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
  { optionId: "opencode-reject", semantic: "reject", label: "Reject", persistence: "request", scopeSummary: "Also rejects pending requests in the same native session", affectsOtherPendingRequests: true, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
]);

const FIXTURE_TIME = "2026-09-16T00:00:00.000Z";
export const NATIVE_INTERACTION_FIXTURES = {
  codex: DurableInteractionSchema.parse({
    id: "interaction-codex", revision: 0, workspaceId: "workspace-fixture", workflowId: "workflow-fixture",
    runId: "run-fixture", executionId: "execution-codex", requestingAgentId: "agent-coder", harness: "codex",
    providerVersion: "0.154.0", nativeSessionId: "codex-thread-fixture", nativeRequestId: "codex-request-fixture",
    nativeRequestType: "item/commandExecution/requestApproval", graphThreadId: "graph-thread-fixture",
    request: { command: ["pnpm", "test"] }, approval: { handler: "orchestrator", designatedOrchestratorAgentId: "agent-orchestrator" },
    responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE, status: "pending", deliveryState: "not_started",
    createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME,
  }),
  opencode: DurableInteractionSchema.parse({
    id: "interaction-opencode", revision: 0, workspaceId: "workspace-fixture", workflowId: "workflow-fixture",
    runId: "run-fixture", executionId: "execution-opencode", requestingAgentId: "agent-coder", harness: "opencode",
    providerVersion: "1.18.31", nativeSessionId: "opencode-session-fixture", nativeRequestId: "opencode-request-fixture",
    nativeRequestType: "permission.asked", graphThreadId: "graph-thread-fixture",
    request: { permission: "bash", patterns: ["pnpm test"] }, approval: { handler: "orchestrator", designatedOrchestratorAgentId: "agent-orchestrator" },
    responseOptions: OPENCODE_APPROVAL_OPTIONS_FIXTURE, status: "pending", deliveryState: "not_started",
    createdAt: FIXTURE_TIME, updatedAt: FIXTURE_TIME,
  }),
} as const;

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
