import { ClaudeHarnessConfigurationSchema } from '../claude.js';
import { RunStartV3InputSchema } from '../wave25/startRequest.js'
import { InteractionActivityProjectionSchema } from '../interaction-activity.js'
import { z } from "zod";
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema, WorkflowRunV3Schema } from "../wave25/workflowSchemas.js";
import { CurrentWorkflowNodeSchema, CurrentWorkflowRelationshipSchema } from "../wave25/workflowShape.js";

export * from "./extensions.js";
export * from "./harnessSettings.js";
export * from "./codexPlugins.js";
export * from "./settingsExperience.js";
export * from "./browserAuth.js";

import {
  AgentSchema,
  AgentDefaultsSchema,
  CodexHarnessConfigurationSchema,
  OpenCodeHarnessConfigurationSchema,
  HarnessQualificationSchema,
  HarnessConfigurationSchema,
  GetRunResponseSchema,
  ExecutionLocationSchema,
  RunActivitySchema,
  ReviewStatusSchema,
  IdSchema,
  TimestampSchema,
  WorkflowApprovalConfigurationSchema,
  ExecutionConditionSchema,
  WorkspaceSchema,
  DurableInteractionSchema,
  InteractionStatusSchema,
  ApprovalHandlerSchema,
  WorkflowDefaultsSchema,
} from "../index.js";

export const ManagementAudienceSchema = z.enum(["operator", "worker", "user"]);
export type ManagementAudience = z.infer<typeof ManagementAudienceSchema>;

export const ManagementActionSchema = z.enum([
  "sources:read", "sources:approve", "source_roots:read", "source_roots:bind",
  "job_definitions:read", "job_definitions:write", "jobs:start", "jobs:read", "jobs:cancel", "job_logs:read", "job_artifacts:read",
  "agents:create",
  "agents:update",
  "agents:archive",
  "agents:restore",
  "workspaces:restore",
  "workflows:restore",
  "workspace_locations:provision",
  "skills:read",
  "skills:publish",
  "workflow_triggers:read",
  "workflow_triggers:update",
  "workflow_triggers:fire",
  "runs:resume",

  "capabilities:read",
  "operator_chat:read",
  "operator_chat:write",
  "operator_chat:cancel",
  "operator_chat:respond",
  "operator_handoff:read",
  "agent_chat:read",
  "agent_chat:write",
  "agent_chat:cancel",
  "agent_chat:respond",
  "harnesses:read",
  "harnesses:update",
  "devices:read",
  "devices:metrics:read",
  "settings:read",
  "settings:update",
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

/** Host telemetry requires a separately selected grant, including for broad presets. */
export const DEFAULT_MANAGEMENT_ACTIONS = ManagementActionSchema.options.filter(
  (action) => action !== "devices:metrics:read",
);

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

/** Browser identity readback. No bearer token, cookie, or token hash is returned. */
export const BrowserAccessSessionSchema = z.object({
  localDev: z.literal(true).optional(),
  principal: z.object({
    id: IdSchema, name: z.string().min(1), expiresAt: TimestampSchema,
    grants: z.array(ManagementGrantSchema),
  }).strict(),
  account: z.object({ name: z.string().min(1), email: z.string().email() }).strict().optional(),
}).strict();
export const BrowserAccessLogoutSchema = z.object({ signedOut: z.literal(true) }).strict();

// Native automatic handling is supported by the server. The shared schema
// still enforces agreement between autoApprove and Advanced permission handling.
export const ManagementOpenCodeHarnessConfigurationSchema = OpenCodeHarnessConfigurationSchema;
export const ManagementHarnessConfigurationSchema = z.discriminatedUnion("harness", [
  CodexHarnessConfigurationSchema,
  ManagementOpenCodeHarnessConfigurationSchema,
  ClaudeHarnessConfigurationSchema,
]);
export const ManagementHarnessDefaultsSchema = z.object({
  codex: CodexHarnessConfigurationSchema,
  opencode: ManagementOpenCodeHarnessConfigurationSchema,
  claude: ClaudeHarnessConfigurationSchema.optional(),
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

export const ManagedWorkflowRecordFields = {
  revision: ExpectedRevisionSchema, currentVersionId: IdSchema.nullable(), archivedAt: TimestampSchema.nullable(),
};
export const ManagedWorkflowSchema = z.object({ ...ManagedWorkflowRecordFields, workflow: WorkflowDefinitionV3Schema }).strict();
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
  parentPath: z.string().trim().min(1).max(4096).refine((value) => !value.includes("\0"), "Invalid folder path").optional().describe("Existing parent folder on Local Runner. Pass workspace_defaults_get.value.parentPath to use the configured default; creates a new child named after the workspace. Omit only to leave execution location unconfigured."),
  ...MutationFields,
  name: z.string().trim().min(1).max(200).optional().describe("Omit to use the configured suggested name, adding (1), (2), etc. when a workspace name or project folder is already taken. An explicit name is used exactly and existing folders are rejected."),
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
export const WorkspaceBatchArchiveInputSchema = z.object({
  ...MutationFields,
  workspaces: z.array(z.object({ workspaceId: IdSchema, expectedRevision: ExpectedRevisionSchema }).strict())
    .min(1).max(100).refine((items) => new Set(items.map((item) => item.workspaceId)).size === items.length,
      "Each workspace must appear only once"),
}).strict();
export type WorkspaceBatchArchiveInput = z.infer<typeof WorkspaceBatchArchiveInputSchema>;
export const WorkspaceBatchArchiveResultSchema = z.object({
  value: z.object({ workspaceIds: z.array(IdSchema) }).strict(), replayed: z.boolean(),
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
export const WorkflowBatchArchiveInputSchema = z.object({
  ...WorkspaceScopeSchema.shape,
  ...MutationFields,
  workflows: z.array(z.object({ workflowId: IdSchema, expectedRevision: ExpectedRevisionSchema }).strict())
    .min(1).max(100).refine((items) => new Set(items.map((item) => item.workflowId)).size === items.length,
      "Each workflow must appear only once"),
}).strict();
export type WorkflowBatchArchiveInput = z.infer<typeof WorkflowBatchArchiveInputSchema>;
export const WorkflowBatchArchiveResultSchema = z.object({
  value: z.object({ workflowIds: z.array(IdSchema) }).strict(), replayed: z.boolean(),
}).strict();
export type WorkflowCreateInput = z.infer<typeof WorkflowCreateInputSchema>;
export type WorkflowUpdateInput = z.infer<typeof WorkflowUpdateInputSchema>;
export type WorkflowArchiveInput = z.infer<typeof WorkflowArchiveInputSchema>;

export const AgentListInputSchema = z.object({
  workspaceId: IdSchema,
  workflowId: IdSchema.optional(),
  includeArchived: z.boolean().default(false),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const AgentGetInputSchema = z.object({ workspaceId: IdSchema, agentId: IdSchema }).strict();
export const ManagedAgentSchema = z.object({ agent: AgentSchema, metadataRevision: ExpectedRevisionSchema, archivedAt: TimestampSchema.nullable().optional() }).strict();
export const ManagedAgentPageSchema = z.object({ items: z.array(ManagedAgentSchema), pageInfo: ManagementPageInfoSchema }).strict();
export const ManagedAgentDetailSchema = ManagedAgentSchema.extend({ workflowIds: z.array(IdSchema) }).strict();

const AgentAddOperationSchema = z.object({
  type: z.literal("agent.add"),
  agentId: IdSchema,
  nodeId: IdSchema,
  name: z.string().trim().min(1).max(200),
  nodeName: z.string().trim().min(1).max(200).optional(),
  productRole: z.enum(["orchestrator", "coder"]).optional(),
  /** Omit to copy the role template. A different harness requires an explicit configuration. */
  harness: z.enum(["codex", "opencode", "claude"]).optional(),
  configuration: ManagementHarnessConfigurationSchema.optional(),
  prompt: AgentSchema.shape.prompt,
  assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
  description: z.string().max(10_000).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
}).strict();
/** Select a product template; callers cannot fabricate a privileged Agent role. */
const AgentAddFromTemplateOperationSchema = AgentAddOperationSchema.omit({ harness: true }).extend({
  type: z.literal("agent.add_from_template"), template: z.enum(["orchestrator", "coder"]),
}).strict().refine((value) => value.productRole === undefined || value.productRole === value.template,
  "productRole must match the selected template");
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
  harnessProfileSelection: AgentSchema.shape.harnessProfileSelection,
  prompt: AgentSchema.shape.prompt,
  assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
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
  type: z.literal("edge.connect"), kind: z.enum(["execution", "approval"]), edgeId: IdSchema, sourceNodeId: IdSchema, targetNodeId: IdSchema,
}).strict();
const EdgeDisconnectOperationSchema = z.object({ type: z.literal("edge.disconnect"), edgeId: IdSchema }).strict();
const ExecutionLimitsOperationSchema = z.object({
  type: z.literal("workflow.set_execution_limits"),
  maxParallelism: z.number().int().positive().max(100),
  maxNodeExecutions: z.number().int().positive().max(10_000),
}).strict();
const RequiredAgentCountOperationSchema = z.object({
  type: z.literal("workflow.set_required_agent_count"),
  requiredAgentCount: z.number().int().nonnegative().max(10_000),
}).strict();

const NodeReplaceOperationSchema = z.object({
  type: z.literal("node.replace"), node: CurrentWorkflowNodeSchema,
}).strict();
const NodeOrderOperationSchema = z.object({
  type: z.literal("nodes.reorder"), nodeIds: z.array(IdSchema).max(10_000),
}).strict();
const EdgeOrderOperationSchema = z.object({
  type: z.literal("edges.reorder"), edgeIds: z.array(IdSchema).max(50_000),
}).strict();
const EdgePutOperationSchema = z.object({
  type: z.literal("edge.put"), edge: CurrentWorkflowRelationshipSchema,
}).strict();
const ResetExecutionLimitsOperationSchema = z.object({ type: z.literal("workflow.reset_execution_limits") }).strict();
const ResetRequiredAgentCountOperationSchema = z.object({ type: z.literal("workflow.reset_required_agent_count") }).strict();

export const CurrentCommonGraphOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.attach"), agentId: IdSchema, nodeId: IdSchema,
    expectedAgentRevision: ExpectedRevisionSchema, expectedConfigurationVersionId: IdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal("workflow.set_execution_condition"),
    executionCondition: ExecutionConditionSchema,
  }).strict(),
  WorkflowApprovalOperationSchema,
  NodeOrderOperationSchema,
  EdgeOrderOperationSchema,
  ResetExecutionLimitsOperationSchema,
  RequiredAgentCountOperationSchema,
  ResetRequiredAgentCountOperationSchema,
  AgentAddOperationSchema,
  AgentAddFromTemplateOperationSchema,
  AgentRenameOperationSchema,
  AgentConfigureOperationSchema,
  AgentCloneOperationSchema,
  NodeRenameOperationSchema,
  NodePromptOperationSchema,
  NodeMoveOperationSchema,
  NodeRemoveOperationSchema,
  EdgeDisconnectOperationSchema,
  ExecutionLimitsOperationSchema,
]);

export const GraphDraftOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent.attach"), agentId: IdSchema, nodeId: IdSchema,
    expectedAgentRevision: ExpectedRevisionSchema, expectedConfigurationVersionId: IdSchema,
    name: z.string().trim().min(1).max(200).optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal("workflow.restore_version"), versionId: IdSchema }).strict(),
  z.object({ type: z.literal("workflow.set_execution_condition"),
    executionCondition: ExecutionConditionSchema,
  }).strict(),
  WorkflowApprovalOperationSchema,
  NodeReplaceOperationSchema,
  NodeOrderOperationSchema,
  EdgePutOperationSchema,
  EdgeOrderOperationSchema,
  ResetExecutionLimitsOperationSchema,
  RequiredAgentCountOperationSchema,
  ResetRequiredAgentCountOperationSchema,
  AgentAddOperationSchema,
  AgentAddFromTemplateOperationSchema,
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
export const GraphDraftRecordFields = {
  id: IdSchema,
  workspaceId: IdSchema,
  workflowId: IdSchema,
  revision: ExpectedRevisionSchema,
  layoutRevision: ExpectedRevisionSchema.optional(),
  baseWorkflowVersionId: IdSchema.nullable(),
  // Missing markers on older records are conservatively treated as unpublished.
  publishedRevision: ExpectedRevisionSchema.nullable().optional(),
  stagedAgents: z.array(StagedAgentSchema),
  sourceAgentPins: z.array(z.object({agentId: IdSchema, metadataRevision: ExpectedRevisionSchema, configurationVersionId: IdSchema}).strict()).optional(),
  updatedByPrincipalId: IdSchema,
  updatedAt: TimestampSchema,
};
export const GraphDraftSchema = z.object({ ...GraphDraftRecordFields, graph: WorkflowDefinitionV3Schema }).strict();
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
  previousDraft: GraphDraftSchema.optional(),
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
export const GraphDraftLayoutInputSchema = z.object({
  ...DraftScopeSchema.shape, ...MutationFields,
  expectedLayoutRevision: ExpectedRevisionSchema,
  nodeId: IdSchema,
  position: NodeMoveOperationSchema.shape.position,
}).strict();
export const GraphDraftLayoutResultSchema = z.object({
  value: z.object({ draftId: IdSchema, layoutRevision: ExpectedRevisionSchema,
    nodeId: IdSchema, position: NodeMoveOperationSchema.shape.position }).strict(),
  replayed: z.boolean(),
}).strict();
export const GraphDraftRevertAppliedInputSchema = z.object({
  ...DraftScopeSchema.shape, ...RevisionMutationFields, applyCommandId: IdSchema,
}).strict();
export const GraphDraftRevertAppliedResultSchema = z.object({
  value: z.object({ draft: GraphDraftSchema, revertedApplyCommandId: IdSchema,
    priorRevision: ExpectedRevisionSchema }).strict(), replayed: z.boolean(),
}).strict();

export const HarnessDefaultsUpdateInputSchema = z.object({
  ...RevisionMutationFields,
  defaults: ManagementHarnessDefaultsSchema,
}).strict();
export const HarnessConfigurationCheckInputSchema = z.object({
  configuration: HarnessConfigurationSchema,
}).strict();
export const HarnessConfigurationCheckResultSchema = z.object({
  configuration: HarnessConfigurationSchema,
  qualification: HarnessQualificationSchema,
  checkedAt: TimestampSchema,
}).strict();

export const HarnessGetInputSchema = z.object({ harness: z.enum(["codex", "opencode", "claude"]) }).strict();
export const HarnessCatalogEntrySchema = z.object({
  harness: z.enum(["codex", "opencode", "claude"]),
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

export const ManagedAgentDefaultsSchema = z.object({
  value: AgentDefaultsSchema, revision: ExpectedRevisionSchema, versionId: IdSchema.nullable(),
}).strict();
export const ManagedWorkflowDefaultsSchema = z.object({
  value: WorkflowDefaultsSchema, revision: ExpectedRevisionSchema, versionId: IdSchema.nullable(),
}).strict();
export const AgentDefaultsUpdateInputSchema = z.object({
  ...RevisionMutationFields, value: AgentDefaultsSchema,
}).strict();
export const WorkflowDefaultsUpdateInputSchema = z.object({
  ...RevisionMutationFields, value: WorkflowDefaultsSchema,
}).strict();
export const AgentDefaultsUpdateResultSchema = z.object({ value: ManagedAgentDefaultsSchema, replayed: z.boolean() }).strict();
export const WorkflowDefaultsUpdateResultSchema = z.object({ value: ManagedWorkflowDefaultsSchema, replayed: z.boolean() }).strict();

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
/** Generic management spelling, one canonical explicit V3 Start request. */
export const RunStartInputSchema = RunStartV3InputSchema;
export const RunStopInputSchema = z.object({
  workspaceId: IdSchema,
  runId: IdSchema,
  ...MutationFields,
}).strict();

export const InteractionListInputSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(),
  handler: ApprovalHandlerSchema.optional(),
  status: InteractionStatusSchema.optional(),
  ...ManagementPageInputSchema.omit({ includeArchived: true }).shape,
}).strict();
export const InteractionGetInputSchema = z.object({ interactionId: IdSchema }).strict();
export const ManagedInteractionPageSchema = z.object({
  items: z.array(DurableInteractionSchema), pageInfo: ManagementPageInfoSchema,
  pendingCount: z.number().int().nonnegative().optional(),
  pendingByWorkflow: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).strict();
export const ManagedInteractionSchema = z.object({ interaction: DurableInteractionSchema, activity: InteractionActivityProjectionSchema.optional(), review: ReviewStatusSchema.optional() }).strict();

/** Deployment capability, separate from the candidate-only A0 schema. False
 * stays literal until native admission AND durable repeat edit intents qualify.
 * No caller-controlled flag can enable either unfinished runtime boundary. */
export const RepeatCapabilitiesResultSchema = z.object({
  contractVersion: z.literal(1),
  executionSemanticsVersion: z.literal(3),
  supported: z.literal(false),
  authoring: z.object({
    flatScopesOnly: z.literal(true), nesting: z.literal(false), arbitraryCycles: z.literal(false),
    maxOccurrencesMin: z.literal(1), maxOccurrencesMax: z.literal(2147483647),
    explicitLimitExit: z.literal(true), earlyExitOutcome: z.literal(true),
  }).strict(),
  availability: z.object({
    savedAuthoring: z.literal(true),
    persistedReadback: z.boolean(),
    runtimeAdmission: z.literal(false),
    meaningfulEdit: z.literal(false),
    reasons: z.tuple([z.literal("NATIVE_START_NOT_READY"), z.literal("REPEAT_EDIT_INTENT_NOT_READY")]),
  }).strict(),
}).strict();
export type RepeatCapabilitiesResult = z.infer<typeof RepeatCapabilitiesResultSchema>;

export const REPEAT_OPERATOR_TOOL_NAMES = [
  "repeat_capabilities_get", "repeat_get", "repeat_update", "repeat_run_get",
] as const;
export type RepeatOperatorToolName = typeof REPEAT_OPERATOR_TOOL_NAMES[number];

export const OperatorToolNameSchema = z.enum([
  "source_list", "source_get", "source_approve", "source_root_bind", "source_root_get", "source_root_list",
  "job_runtime_profile_list","job_runtime_profile_save","job_runtime_qualification_request","job_runtime_qualification_run","job_runtime_qualification_get",
  "job_choices_get","job_workflow_execution_get","job_definition_list","job_definition_get","job_definition_version_get","job_definition_save","job_validate","job_start","job_get","job_list","job_cancel","job_logs_read","job_artifacts_list","job_artifact_read",
  "device_main_identity_get", "devices_list", "device_pairing_grant_create", "device_revoke",
  "device_setup_code_create",
  "device_setup_options_get",
  "device_connection_host_discover", "device_connection_read", "device_connection_inspect", "device_connection_check", "device_connection_configure",
  "harness_registry_get", "workspace_root_choices_list", "workspace_root_location_get", "workspace_root_location_validate", "workspace_root_directories_list", "workspace_root_location_set",
  "resource_telemetry_read", "resource_telemetry_selector_get",
  ...REPEAT_OPERATOR_TOOL_NAMES,
  "operator_mcp_setup_get",
  "operator_chat_create", "operator_chat_get", "operator_chat_send", "operator_chat_cancel", "operator_chat_respond", "operator_handoff_history_get",
  "agent_chat_read", "agent_chat_send", "agent_chat_interrupt", "agent_chat_cancel_queued", "agent_chat_respond",
  "workspace_defaults_get",
  "workspace_defaults_update",
  "harness_mcp_servers_list", "harness_mcp_change_request", "harness_mcp_managed_request", "harness_mcp_change_get",
  "codex_plugins_list", "codex_plugin_get",
  "harness_configuration_check",
  "execution_readiness_get",
  "claude_setup_options_get",
  "harness_options_get",
  "harness_options_refresh",
  "opencode_models_cache_update",
  "harness_mcp_detection_get",
  "agent_create",
  "agent_update",
  "agent_clone",
  "workflow_versions_list",
  "workflow_version_get",
  "agent_configuration_versions_list",
  "agent_configuration_version_get",
  "agent_configuration_restore",
  "workspace_restore",
  "workflow_restore",
  "agent_archive",
  "agent_restore",
  "workspace_location_clear",
  "workspace_location_provision",
  "runner_list",
  "skill_list",
  "skill_get",
  "skill_versions_list",
  "skill_create",
  "skill_update",
  "skill_archive",
  "workflow_trigger_get",
  "workflow_trigger_update",
  "workflow_trigger_disable",
  "workflow_trigger_fire",
  "workflow_trigger_jobs_list",
  "run_resume",
  "run_retry",
  "interaction_summary",
  "operator_get_capabilities", "harness_list", "harness_get", "harness_defaults_update", "harness_qualifications_list", "harness_qualification_run",
  "agent_defaults_get", "agent_defaults_update", "workflow_defaults_get", "workflow_defaults_update",
  "workspace_folders_list", "workspace_folder_create", "workspace_folder_rename", "workspace_folder_undo", "workspace_folders_delete",
  "workspace_storage_folders_list", "workspace_storage_folder_delete",
  "workspace_list", "workspace_get", "workspace_create", "workspace_update", "workspace_archive", "workspace_batch_archive",
  "workspace_location_validate", "workspace_location_set",
  "workflow_list", "workflow_get", "workflow_create", "workflow_update", "workflow_archive", "workflow_batch_archive",
  "agent_list", "agent_get", "graph_draft_open", "graph_draft_get", "graph_draft_apply",
  "graph_draft_layout", "graph_draft_revert_applied", "graph_validate", "graph_save", "graph_draft_discard", "run_list", "run_get", "run_current_get_v1", "run_history_get_v1",
  "run_events_list", "run_handoffs_get_v1", "run_activities_get_v1", "run_start", "run_stop",
  "interaction_list", "interaction_get",
]);
export type OperatorToolName = z.infer<typeof OperatorToolNameSchema>;

export const GraphValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ code: z.string().trim().min(1), message: z.string().trim().min(1) }).strict()),
}).strict();
export const GraphSaveResultSchema = z.object({
  draft: GraphDraftSchema, version: WorkflowVersionV3Schema,
  // Returned by the publication transaction, not an optional follow-up read.
  agents: z.array(ManagedAgentSchema).default([]),
}).strict();
export const GraphSaveCommandResultSchema = z.object({ value: GraphSaveResultSchema, replayed: z.boolean() }).strict();
export const RunStartResultSchema = z.object({ run: WorkflowRunV3Schema, accepted: z.literal(true), replayed: z.boolean() }).strict();
export const RunStopResultSchema = z.object({
  runId: IdSchema,
  status: z.enum(["accepted", "already_terminal", "not_owner"]),
  // false means native process exit was not observed; database-terminal is not proof.
  processStopped: z.boolean(),
  replayed: z.boolean(),
}).strict();
export const RunPageSchema = z.object({ items: z.array(WorkflowRunV3Schema), pageInfo: ManagementPageInfoSchema }).strict();
export const RunDetailsSchema = GetRunResponseSchema;
export const RunEventsPageSchema = z.object({ items: z.array(RunActivitySchema), pageInfo: ManagementPageInfoSchema }).strict();
export const GraphDraftDiscardResultSchema = z.object({
  value: z.object({ discarded: z.literal(true), draftId: IdSchema, revision: ExpectedRevisionSchema }).strict(),
  replayed: z.boolean(),
}).strict();
export const OperatorCapabilitiesSchema = z.object({
  endpoint: z.literal("/mcp"), audience: z.literal("operator"), protocol: z.literal("2026-07-28"),
  tools: z.array(OperatorToolNameSchema),
  principal: z.object({id: IdSchema, name: z.string(), expiresAt: TimestampSchema}).strict().optional(),
  grants: z.array(ManagementGrantSchema).optional(),
  requestedResource: z.object({workspaceId: IdSchema.optional(),workflowId: IdSchema.optional(),runId: IdSchema.optional()}).strict().optional(),
  requirements: z.array(z.object({name: OperatorToolNameSchema, actions: z.array(ManagementActionSchema), detail: z.string()}).strict()).optional(),
  runtimeLimits: z.array(z.object({feature: z.string(), state: z.enum(["unsupported", "protected", "limited"]), detail: z.string()}).strict()).optional(),
  workerToolsMcp: z.object({ implemented: z.boolean(), endpoint: z.literal("/mcp") }).strict(),
}).strict();

export * from './executionReadiness.js'
export * from './workspaceStorageFolders.js'
