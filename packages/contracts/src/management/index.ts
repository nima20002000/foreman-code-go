import { z } from "zod";

import {
  AgentSchema,
  CodexHarnessConfigurationSchema,
  OpenCodeHarnessConfigurationSchema,
  HarnessQualificationSchema,
  GetRunResponseSchema,
  ExecutionLocationSchema,
  RunActivitySchema,
  IdSchema,
  RunInputSchema,
  TimestampSchema,
  WorkflowDefinitionSchema,
  WorkflowApprovalConfigurationSchema,
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  WorkflowRunSchema,
  WorkflowVersionSchema,
  WorkspaceSchema,
  DurableInteractionSchema,
  InteractionStatusSchema,
} from "../index.js";

export const ManagementAudienceSchema = z.enum(["operator", "worker", "user"]);
export type ManagementAudience = z.infer<typeof ManagementAudienceSchema>;

export const ManagementActionSchema = z.enum([
  "capabilities:read",
  "harnesses:read",
  "harnesses:update",
  "workspaces:read",
  "workspaces:create",
  "workspaces:update",
  "workspaces:archive",
  "workspace_locations:read",
  "workspace_locations:validate",
  "workspace_locations:update",
  "workflows:read",
  "workflows:create",
  "workflows:update",
  "workflows:archive",
  "agents:read",
  "graph:read",
  "graph:edit",
  "graph:save",
  "runs:read",
  "runs:start",
  "runs:stop",
  "interactions:read",
  "interactions:respond",
]);
export type ManagementAction = z.infer<typeof ManagementActionSchema>;

export const ManagementScopeSchema = z
  .object({
    workspaceIds: z.array(IdSchema).max(500).optional(),
    workflowIds: z.array(IdSchema).max(500).optional(),
    runIds: z.array(IdSchema).max(500).optional(),
  })
  .strict();
export type ManagementScope = z.infer<typeof ManagementScopeSchema>;

export const ManagementGrantSchema = z
  .object({
    actions: z.array(ManagementActionSchema).min(1),
    scope: ManagementScopeSchema,
  })
  .strict();
export type ManagementGrant = z.infer<typeof ManagementGrantSchema>;

export const ManagementPrincipalSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    audience: ManagementAudienceSchema,
    /** Immutable backend-issued logical Agent subject for worker/App principals. */
    agentId: IdSchema.optional(),
    grants: z.array(ManagementGrantSchema),
    expiresAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.audience === "worker" && !value.agentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agentId"], message: "worker principals require an immutable Agent subject" });
    }
    if (value.audience !== "worker" && value.agentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agentId"], message: "Operator principals do not impersonate board Agents" });
    }
  });
export type ManagementPrincipal = z.infer<typeof ManagementPrincipalSchema>;

export const ManagementOpenCodeHarnessConfigurationSchema = OpenCodeHarnessConfigurationSchema.safeExtend({
  autoApprove: z.literal(false),
}).strict();
export const ManagementHarnessConfigurationSchema = z.discriminatedUnion("harness", [
  CodexHarnessConfigurationSchema,
  ManagementOpenCodeHarnessConfigurationSchema,
]);
export const ManagementHarnessDefaultsSchema = z.object({
  codex: CodexHarnessConfigurationSchema,
  opencode: ManagementOpenCodeHarnessConfigurationSchema,
}).strict();

export const CommandIdSchema = z.string().trim().min(8).max(200);
export const ExpectedRevisionSchema = z.number().int().nonnegative();
export const ManagementPageInputSchema = z
  .object({
    cursor: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    includeArchived: z.boolean().default(false),
  })
  .strict();
export const ManagementPageInfoSchema = z
  .object({ nextCursor: z.string().nullable() })
  .strict();

export const OperatorEnrollmentRequestSchema = z.object({ token: z.string().trim().min(1) }).strict();
export const OperatorEnrollmentResponseSchema = z.object({
  principal: z.object({ id: IdSchema, name: z.string().trim().min(1), expiresAt: TimestampSchema }).strict(),
}).strict();

export const ManagedWorkspaceSchema = z
  .object({
    workspace: WorkspaceSchema,
    revision: ExpectedRevisionSchema,
    archivedAt: TimestampSchema.nullable(),
    executionLocation: ExecutionLocationSchema.nullable(),
    locationRevision: ExpectedRevisionSchema,
    locationValidation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("unconfigured") }).strict(),
      z.object({ status: z.literal("restricted") }).strict(),
      z.object({ status: z.literal("ready"), checkedAt: TimestampSchema }).strict(),
      z.object({
        status: z.literal("unavailable"), checkedAt: TimestampSchema,
        error: z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict(),
      }).strict(),
    ]),
  })
  .strict();
export type ManagedWorkspace = z.infer<typeof ManagedWorkspaceSchema>;
export const ManagedWorkspacePageSchema = z.object({
  items: z.array(ManagedWorkspaceSchema), pageInfo: ManagementPageInfoSchema,
}).strict();
export const ManagedWorkspaceCommandResultSchema = z.object({ value: ManagedWorkspaceSchema, replayed: z.boolean() }).strict();

export const ManagedWorkflowSchema = z
  .object({
    workflow: WorkflowDefinitionSchema,
    revision: ExpectedRevisionSchema,
    currentVersionId: IdSchema.nullable(),
    archivedAt: TimestampSchema.nullable(),
  })
  .strict();
export type ManagedWorkflow = z.infer<typeof ManagedWorkflowSchema>;
export const ManagedWorkflowPageSchema = z.object({
  items: z.array(ManagedWorkflowSchema), pageInfo: ManagementPageInfoSchema,
}).strict();
export const ManagedWorkflowCommandResultSchema = z.object({ value: ManagedWorkflowSchema, replayed: z.boolean() }).strict();

const WorkspaceScopeSchema = z.object({ workspaceId: IdSchema }).strict();
const WorkflowScopeSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema }).strict();
const DraftScopeSchema = z.object({ workspaceId: IdSchema, workflowId: IdSchema, draftId: IdSchema }).strict();
const MutationFields = { commandId: CommandIdSchema } as const;
const RevisionMutationFields = { ...MutationFields, expectedRevision: ExpectedRevisionSchema } as const;

export const WorkspaceListInputSchema = ManagementPageInputSchema;
export const WorkspaceGetInputSchema = WorkspaceScopeSchema;
export const WorkspaceCreateInputSchema = z.object({
  ...MutationFields,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
}).strict();
export const WorkspaceUpdateInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...RevisionMutationFields,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined, "name or description is required");
export const WorkspaceArchiveInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...RevisionMutationFields,
}).strict();
export const WorkspaceLocationAccessModeSchema = z.enum(["read-only", "read-write"]);
export type WorkspaceLocationAccessMode = z.infer<typeof WorkspaceLocationAccessModeSchema>;
export const WorkspaceLocationValidateInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  runnerId: IdSchema,
  rootPath: z.string().min(1).refine((value) => !value.includes("\0"), "rootPath cannot contain NUL"),
  accessMode: WorkspaceLocationAccessModeSchema.default("read-only"),
}).strict();
export const WorkspaceLocationSetInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...MutationFields,
  expectedLocationRevision: ExpectedRevisionSchema,
  runnerId: IdSchema,
  rootPath: z.string().min(1).refine((value) => !value.includes("\0"), "rootPath cannot contain NUL"),
}).strict();
export const WorkspaceLocationValidationSchema = z.object({
  workspaceId: IdSchema,
  location: ExecutionLocationSchema,
  accessMode: WorkspaceLocationAccessModeSchema,
  checkedAt: TimestampSchema,
}).strict();
export const WorkspaceLocationSetResultSchema = z.object({
  value: z.object({
    workspaceId: IdSchema,
    executionLocation: ExecutionLocationSchema,
    locationRevision: ExpectedRevisionSchema,
    validation: WorkspaceLocationValidationSchema,
  }).strict(),
  replayed: z.boolean(),
}).strict();
export type WorkspaceLocationValidateInput = z.infer<typeof WorkspaceLocationValidateInputSchema>;
export type WorkspaceLocationSetInput = z.infer<typeof WorkspaceLocationSetInputSchema>;
export type WorkspaceCreateInput = z.infer<typeof WorkspaceCreateInputSchema>;
export type WorkspaceUpdateInput = z.infer<typeof WorkspaceUpdateInputSchema>;
export type WorkspaceArchiveInput = z.infer<typeof WorkspaceArchiveInputSchema>;

export const WorkflowListInputSchema = z.object({
  workspaceId: IdSchema,
  ...ManagementPageInputSchema.shape,
}).strict();
export const WorkflowGetInputSchema = WorkflowScopeSchema;
export const WorkflowCreateInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...MutationFields,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional(),
}).strict();
export const WorkflowUpdateInputSchema = z.object({
  ...WorkflowScopeSchema.shape,
  ...RevisionMutationFields,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
}).strict().refine((value) => value.name !== undefined || value.description !== undefined, "name or description is required");
export const WorkflowArchiveInputSchema = z.object({
  ...WorkflowScopeSchema.shape,
  ...RevisionMutationFields,
}).strict();
export type WorkflowCreateInput = z.infer<typeof WorkflowCreateInputSchema>;
export type WorkflowUpdateInput = z.infer<typeof WorkflowUpdateInputSchema>;
export type WorkflowArchiveInput = z.infer<typeof WorkflowArchiveInputSchema>;

export const AgentListInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema.optional(),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const AgentGetInputSchema = z.object({ workspaceId: IdSchema, agentId: IdSchema }).strict();
export const ManagedAgentSchema = z.object({ agent: AgentSchema, metadataRevision: ExpectedRevisionSchema }).strict();
export const ManagedAgentPageSchema = z.object({ items: z.array(ManagedAgentSchema), pageInfo: ManagementPageInfoSchema }).strict();
export const ManagedAgentDetailSchema = ManagedAgentSchema.extend({ workflowIds: z.array(IdSchema) }).strict();

const AgentAddOperationSchema = z.object({
  type: z.literal("agent.add"),
  agentId: IdSchema,
  nodeId: IdSchema,
  name: z.string().trim().min(1).max(200),
  nodeName: z.string().trim().min(1).max(200).optional(),
  harness: z.enum(["codex", "opencode"]),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
}).strict();
/** Select a product template; callers cannot fabricate a privileged Agent role. */
const AgentAddFromTemplateOperationSchema = AgentAddOperationSchema.omit({ harness: true }).extend({
  type: z.literal("agent.add_from_template"), template: z.enum(["orchestrator", "coder"]),
}).strict();
const WorkflowApprovalOperationSchema = z.object({
  type: z.literal("workflow.set_approval"), approval: WorkflowApprovalConfigurationSchema,
}).strict();
const AgentRenameOperationSchema = z.object({
  type: z.literal("agent.rename"), agentId: IdSchema,
  expectedAgentRevision: ExpectedRevisionSchema, name: z.string().trim().min(1).max(200),
}).strict();
const AgentConfigureOperationSchema = z.object({
  type: z.literal("agent.configure"), agentId: IdSchema,
  expectedAgentRevision: ExpectedRevisionSchema, configuration: ManagementHarnessConfigurationSchema,
  prompt: AgentSchema.shape.prompt,
  assignedSkills: AgentSchema.shape.assignedSkills,
  description: z.string().max(10_000).nullable().optional(),
  role: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const AgentCloneOperationSchema = z.object({
  type: z.literal("agent.clone"), sourceAgentId: IdSchema, agentId: IdSchema,
  expectedSourceConfigurationVersionId: IdSchema.nullable().optional(),
  expectedSourceAgentRevision: ExpectedRevisionSchema.nullable().optional(),
  nodeId: IdSchema, name: z.string().trim().min(1).max(200),
}).strict();
const NodeRenameOperationSchema = z.object({
  type: z.literal("node.rename"), nodeId: IdSchema, name: z.string().trim().min(1).max(200),
}).strict();
const NodePromptOperationSchema = z.object({
  type: z.literal("node.set_initial_prompt"), nodeId: IdSchema,
  initialPrompt: z.string().trim().min(1).max(100_000).nullable(),
}).strict();
const NodeMoveOperationSchema = z.object({
  type: z.literal("node.move"), nodeId: IdSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
}).strict();
const NodeRemoveOperationSchema = z.object({ type: z.literal("node.remove"), nodeId: IdSchema }).strict();
const EdgeConnectOperationSchema = z.object({
  type: z.literal("edge.connect"), edgeId: IdSchema, sourceNodeId: IdSchema, targetNodeId: IdSchema,
}).strict();
const EdgeDisconnectOperationSchema = z.object({ type: z.literal("edge.disconnect"), edgeId: IdSchema }).strict();
const ExecutionLimitsOperationSchema = z.object({
  type: z.literal("workflow.set_execution_limits"),
  maxParallelism: z.number().int().positive().max(100),
  maxNodeExecutions: z.number().int().positive().max(10_000),
}).strict();
const RequiredAgentCountOperationSchema = z.object({
  type: z.literal("workflow.set_required_agent_count"),
  requiredAgentCount: z.number().int().positive().max(10_000),
}).strict();

const NodeReplaceOperationSchema = z.object({
  type: z.literal("node.replace"), node: WorkflowNodeSchema,
}).strict();
const NodeOrderOperationSchema = z.object({
  type: z.literal("nodes.reorder"), nodeIds: z.array(IdSchema).max(10_000),
}).strict();
const EdgeOrderOperationSchema = z.object({
  type: z.literal("edges.reorder"), edgeIds: z.array(IdSchema).max(50_000),
}).strict();
const EdgePutOperationSchema = z.object({
  type: z.literal("edge.put"), edge: WorkflowEdgeSchema,
}).strict();
const ResetExecutionLimitsOperationSchema = z.object({ type: z.literal("workflow.reset_execution_limits") }).strict();
const ResetRequiredAgentCountOperationSchema = z.object({ type: z.literal("workflow.reset_required_agent_count") }).strict();

export const GraphDraftOperationSchema = z.discriminatedUnion("type", [
  NodeReplaceOperationSchema,
  NodeOrderOperationSchema,
  EdgePutOperationSchema,
  EdgeOrderOperationSchema,
  ResetExecutionLimitsOperationSchema,
  RequiredAgentCountOperationSchema,
  ResetRequiredAgentCountOperationSchema,
  AgentAddOperationSchema,
  AgentAddFromTemplateOperationSchema,
  WorkflowApprovalOperationSchema,
  AgentRenameOperationSchema,
  AgentConfigureOperationSchema,
  AgentCloneOperationSchema,
  NodeRenameOperationSchema,
  NodePromptOperationSchema,
  NodeMoveOperationSchema,
  NodeRemoveOperationSchema,
  EdgeConnectOperationSchema,
  EdgeDisconnectOperationSchema,
  ExecutionLimitsOperationSchema,
]);
export type GraphDraftOperation = z.infer<typeof GraphDraftOperationSchema>;

export const StagedAgentSchema = z.object({ agent: AgentSchema, baseRevision: ExpectedRevisionSchema.nullable() }).strict();
export const GraphDraftSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  workflowId: IdSchema,
  revision: ExpectedRevisionSchema,
  baseWorkflowVersionId: IdSchema.nullable(),
  // Missing markers on older records are conservatively treated as unpublished.
  publishedRevision: ExpectedRevisionSchema.nullable().optional(),
  graph: WorkflowDefinitionSchema,
  stagedAgents: z.array(StagedAgentSchema),
  updatedByPrincipalId: IdSchema,
  updatedAt: TimestampSchema,
}).strict();
export type GraphDraft = z.infer<typeof GraphDraftSchema>;
export const GraphDraftEffectSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("ENTRY_NODE_CHANGED"),
    previousEntryNodeId: IdSchema,
    nextEntryNodeId: IdSchema.nullable(),
  }).strict(),
  z.object({
    code: z.literal("SHARED_AGENT_CHANGED"),
    agentId: IdSchema,
    workflowIds: z.array(IdSchema).min(2),
  }).strict(),
]);
export type GraphDraftEffect = z.infer<typeof GraphDraftEffectSchema>;
export const GraphDraftApplyResultSchema = z.object({
  draft: GraphDraftSchema,
  effects: z.array(GraphDraftEffectSchema),
}).strict();
export const GraphDraftCommandResultSchema = z.object({ value: GraphDraftApplyResultSchema, replayed: z.boolean() }).strict();

export const GraphDraftOpenInputSchema = WorkflowScopeSchema;
export const GraphDraftGetInputSchema = DraftScopeSchema;
export const GraphDraftApplyInputSchema = z.object({
  ...DraftScopeSchema.shape,
  ...RevisionMutationFields,
  operations: z.array(GraphDraftOperationSchema).min(1).max(100),
}).strict();
export const GraphValidateInputSchema = DraftScopeSchema;
export const GraphSaveInputSchema = z.object({ ...DraftScopeSchema.shape, ...RevisionMutationFields }).strict();
export const GraphDraftDiscardInputSchema = z.object({ ...DraftScopeSchema.shape, ...RevisionMutationFields }).strict();

export const HarnessDefaultsUpdateInputSchema = z.object({
  ...RevisionMutationFields,
  defaults: ManagementHarnessDefaultsSchema,
}).strict();
export const HarnessGetInputSchema = z.object({ harness: z.enum(["codex", "opencode"]) }).strict();
export const HarnessCatalogEntrySchema = z.object({
  harness: z.enum(["codex", "opencode"]),
  defaults: ManagementHarnessConfigurationSchema,
  defaultsRevision: ExpectedRevisionSchema,
  capability: HarnessQualificationSchema.nullable(),
  discoveryError: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
}).strict();
export const HarnessCatalogSchema = z.array(HarnessCatalogEntrySchema);
export const HarnessCatalogResultSchema = z.object({ items: HarnessCatalogSchema }).strict();
export const HarnessDefaultsUpdateResultSchema = z.object({
  value: z.object({ defaults: ManagementHarnessDefaultsSchema, revision: ExpectedRevisionSchema }).strict(),
  replayed: z.boolean(),
}).strict();

export const RunListInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema.optional(),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const RunGetInputSchema = z.object({ workspaceId: IdSchema, runId: IdSchema }).strict();
export const RunEventsListInputSchema = z.object({
  workspaceId: IdSchema,
  runId: IdSchema,
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
export const RunStartInputSchema = z.object({
  ...WorkflowScopeSchema.shape,
  ...MutationFields,
  workflowVersionId: IdSchema,
  draftId: IdSchema.optional(),
  expectedDraftRevision: ExpectedRevisionSchema.optional(),
  expectedLocationRevision: ExpectedRevisionSchema,
  input: RunInputSchema,
}).strict().refine((value) => (value.draftId === undefined) === (value.expectedDraftRevision === undefined),
  "draftId and expectedDraftRevision must be supplied together");
export const RunStopInputSchema = z.object({
  workspaceId: IdSchema,
  runId: IdSchema,
  ...MutationFields,
}).strict();

export const InteractionListInputSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(),
  status: InteractionStatusSchema.optional(),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const InteractionGetInputSchema = z.object({ interactionId: IdSchema }).strict();
export const InteractionRespondInputSchema = z.object({
  interactionId: IdSchema, optionId: IdSchema, expectedRevision: ExpectedRevisionSchema, ...MutationFields,
}).strict();
export const ManagedInteractionPageSchema = z.object({
  items: z.array(DurableInteractionSchema), pageInfo: ManagementPageInfoSchema,
}).strict();
export const ManagedInteractionSchema = z.object({ interaction: DurableInteractionSchema }).strict();
export const InteractionRespondResultSchema = z.object({
  value: DurableInteractionSchema, replayed: z.boolean(),
}).strict();

export const OperatorToolNameSchema = z.enum([
  "operator_get_capabilities", "harness_list", "harness_get", "harness_defaults_update",
  "workspace_list", "workspace_get", "workspace_create", "workspace_update", "workspace_archive",
  "workspace_location_validate", "workspace_location_set",
  "workflow_list", "workflow_get", "workflow_create", "workflow_update", "workflow_archive",
  "agent_list", "agent_get", "graph_draft_open", "graph_draft_get", "graph_draft_apply",
  "graph_validate", "graph_save", "graph_draft_discard", "run_list", "run_get",
  "run_events_list", "run_start", "run_stop",
  "interaction_list", "interaction_get", "interaction_respond",
]);
export type OperatorToolName = z.infer<typeof OperatorToolNameSchema>;

export const GraphValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict()),
}).strict();
export const GraphSaveResultSchema = z.object({
  draft: GraphDraftSchema, version: WorkflowVersionSchema,
  // Returned by the publication transaction, not an optional follow-up read.
  agents: z.array(ManagedAgentSchema).default([]),
}).strict();
export const GraphSaveCommandResultSchema = z.object({ value: GraphSaveResultSchema, replayed: z.boolean() }).strict();
export const RunStartResultSchema = z.object({ run: WorkflowRunSchema, accepted: z.literal(true), replayed: z.boolean() }).strict();
export const RunStopResultSchema = z.object({
  runId: IdSchema,
  status: z.enum(["accepted", "already_terminal", "not_owner"]),
  // false means native process exit was not observed; database-terminal is not proof.
  processStopped: z.boolean(),
  replayed: z.boolean(),
}).strict();
export const RunPageSchema = z.object({ items: z.array(WorkflowRunSchema), pageInfo: ManagementPageInfoSchema }).strict();
export const RunDetailsSchema = GetRunResponseSchema;
export const RunEventsPageSchema = z.object({ items: z.array(RunActivitySchema), pageInfo: ManagementPageInfoSchema }).strict();
export const GraphDraftDiscardResultSchema = z.object({
  value: z.object({ discarded: z.literal(true), draftId: IdSchema, revision: ExpectedRevisionSchema }).strict(),
  replayed: z.boolean(),
}).strict();
export const OperatorCapabilitiesSchema = z.object({
  endpoint: z.literal("/mcp/operator"), audience: z.literal("operator"), protocol: z.literal("2026-07-28"),
  tools: z.array(OperatorToolNameSchema),
  workerToolsMcp: z.object({ implemented: z.boolean(), endpoint: z.literal("/mcp/tools") }).strict(),
}).strict();
