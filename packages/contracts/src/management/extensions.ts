import { z } from "zod";
import { WorkflowVersionV3Schema } from "../wave25/workflowSchemas.js";
import {
  AgentSchema, AgentConfigurationVersionSchema,
  HarnessConfigurationSchema, HarnessQualificationSchema, ScopedMcpDetectionSchema,
  IdSchema, TimestampSchema, ApprovalHandlerSchema,
} from "../index.js";

// Kept separate from index.ts to avoid a management-module initialization cycle.
const Revision = z.number().int().nonnegative();
const Command = z.string().trim().min(8).max(200);
const Page = { cursor: z.string().trim().min(1).optional(), limit: z.number().int().min(1).max(100).default(50) };
const Workspace = { workspaceId: IdSchema };
const Workflow = { ...Workspace, workflowId: IdSchema };
const Mutation = { commandId: Command, expectedRevision: Revision };
const Configuration = HarnessConfigurationSchema.refine(
  (value) => value.harness !== "opencode" || !value.autoApprove,
  "Managed OpenCode requires routed approval",
);

export const AgentCreateInputSchema = z.object({
  ...Workspace, commandId: Command, agentId: IdSchema,
  name: z.string().trim().min(1).max(200),
  productRole: z.enum(["coder", "orchestrator"]).default("coder"),
  description: z.string().max(10_000).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  configuration: Configuration.optional(),
  prompt: AgentSchema.shape.prompt, assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
}).strict();
export const AgentUpdateInputSchema = z.object({
  ...Workspace, agentId: IdSchema, ...Mutation,
  expectedConfigurationVersionId: IdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  role: z.string().trim().min(1).max(200).nullable().optional(),
  configuration: Configuration.optional(),
  prompt: AgentSchema.shape.prompt, assignedSkills: AgentSchema.shape.assignedSkills,
  graphqlTools: AgentSchema.shape.graphqlTools,
}).strict().refine((value) => [value.name, value.description, value.role, value.configuration,
  value.prompt, value.assignedSkills, value.graphqlTools].some((item) => item !== undefined), "At least one editable field is required");
export const AgentCloneInputSchema = z.object({
  ...Workspace, commandId: Command, agentId: IdSchema, sourceAgentId: IdSchema,
  expectedSourceRevision: Revision, expectedSourceConfigurationVersionId: IdSchema,
  name: z.string().trim().min(1).max(200),
}).strict();
export const AgentMutationResultSchema = z.object({
  value: z.object({ agent: AgentSchema, metadataRevision: Revision }).strict(), replayed: z.boolean(),
}).strict();
export type AgentCreateInput = z.infer<typeof AgentCreateInputSchema>;
export type AgentUpdateInput = z.infer<typeof AgentUpdateInputSchema>;
export type AgentCloneInput = z.infer<typeof AgentCloneInputSchema>;

export const HarnessOptionsInputSchema = z.object({ harness: z.enum(["codex", "opencode"]) }).strict();
export const HarnessOptionsRefreshInputSchema = z.object({
  harness: z.enum(["codex", "opencode"]), refresh: z.enum(["catalog", "upstream"]).default("catalog"),
}).strict();
export const OpenCodeModelsRefreshInputSchema = z.object({ harness: z.literal("opencode") }).strict();
export const HarnessModelOptionSchema = z.object({
  id: IdSchema, providerId: IdSchema.optional(), name: z.string().optional(),
  reasoningEfforts: z.array(z.string()), variants: z.array(z.string()), serviceTiers: z.array(z.string()),
}).strict();
export const HarnessOptionsResultSchema = z.object({
  harness: z.enum(["codex", "opencode"]), providerVersion: z.string().min(1),
  authenticated: z.boolean(), models: z.array(HarnessModelOptionSchema), nativeAgents: z.array(z.string()),
  settings: z.array(z.object({
    field: z.string(), support: z.enum(["supported", "conditional", "metadata_only", "unsupported"]),
    detail: z.string(),
  }).strict()),
  restrictions: z.array(z.string()), checkedAt: TimestampSchema,
}).strict();
export type HarnessOptions = z.infer<typeof HarnessOptionsResultSchema>;
export const HarnessMcpDetectionInputSchema = z.object({ ...Workspace, harness: z.enum(["codex", "opencode"]) }).strict();
export const HarnessMcpDetectionResultSchema = ScopedMcpDetectionSchema;
export const NativeConfigurationCheckInputSchema = z.object({ configuration: Configuration }).strict();
export const NativeConfigurationCheckResultSchema = z.object({
  configuration: HarnessConfigurationSchema, qualification: HarnessQualificationSchema, checkedAt: TimestampSchema,
}).strict();

export const WorkflowVersionListInputSchema = z.object({ ...Workflow, ...Page }).strict();
export const WorkflowVersionGetInputSchema = z.object({ ...Workflow, versionId: IdSchema }).strict();
export const WorkflowVersionPageSchema = z.object({
  items: z.array(WorkflowVersionV3Schema), pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const WorkflowVersionResultSchema = z.object({ version: WorkflowVersionV3Schema }).strict();
export const AgentVersionListInputSchema = z.object({ ...Workspace, agentId: IdSchema, ...Page }).strict();
export const AgentVersionGetInputSchema = z.object({ ...Workspace, agentId: IdSchema, versionId: IdSchema }).strict();
export const AgentVersionPageSchema = z.object({
  items: z.array(AgentConfigurationVersionSchema), pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const AgentVersionResultSchema = z.object({ version: AgentConfigurationVersionSchema }).strict();
export const AgentVersionRestoreInputSchema = z.object({
  ...Workspace, agentId: IdSchema, versionId: IdSchema, ...Mutation, expectedConfigurationVersionId: IdSchema,
}).strict();

export const WorkspaceLifecycleInputSchema = z.object({ ...Workspace, ...Mutation }).strict();
export const WorkflowLifecycleInputSchema = z.object({ ...Workflow, ...Mutation }).strict();
export const AgentLifecycleInputSchema = z.object({ ...Workspace, agentId: IdSchema, ...Mutation }).strict();
export const LifecycleResultSchema = z.object({
  value: z.object({ id: IdSchema, revision: Revision, archived: z.boolean() }).strict(), replayed: z.boolean(),
}).strict();
export const LocationClearInputSchema = z.object({
  ...Workspace, commandId: Command, expectedLocationRevision: Revision,
}).strict();
export const LocationClearResultSchema = z.object({
  value: z.object({ workspaceId: IdSchema, executionLocation: z.null(), locationRevision: Revision }).strict(), replayed: z.boolean(),
}).strict();
export const RunnerListInputSchema = z.object({ ...Workspace }).strict();
export const RunnerListResultSchema = z.object({ items: z.array(z.object({
  id: IdSchema, kind: z.literal("local"), available: z.literal(true),
  supportsRemoteDispatch: z.literal(false), supportsProvisioning: z.boolean(),
}).strict()) }).strict();
export const LocationProvisionInputSchema = z.object({
  ...Workspace, commandId: Command, expectedLocationRevision: Revision,
}).strict();
export const LocationProvisionResultSchema = z.object({
  value: z.object({ workspaceId: IdSchema, executionLocation: z.object({runnerId: IdSchema, rootPath: z.string()}).strict(),
    locationRevision: Revision }).strict(), replayed: z.boolean(),
}).strict();

export const SkillReferenceInputSchema = z.object({ ...Workspace, skillId: IdSchema, version: z.string().trim().min(1).max(100) }).strict();
export const SkillPublishInputSchema = SkillReferenceInputSchema.extend({
  commandId: Command, name: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(100_000),
}).strict();
export const SkillListInputSchema = z.object({ ...Workspace, ...Page }).strict();
export const SkillVersionSchema = z.object({
  ...Workspace, skillId: IdSchema, version: z.string().min(1), name: z.string().min(1),
  instructions: z.string().min(1).max(100_000), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: TimestampSchema,
}).strict();
export const SkillGetResultSchema = z.object({ skill: SkillVersionSchema }).strict();
export const SkillPageSchema = z.object({
  items: z.array(SkillVersionSchema.omit({ instructions: true })),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const SkillPublishResultSchema = z.object({ value: SkillVersionSchema, replayed: z.boolean() }).strict();
export type SkillPublishInput = z.infer<typeof SkillPublishInputSchema>;

export const WorkflowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("manual")}).strict(),
  z.object({kind: z.literal("on_message")}).strict(),
  z.object({kind: z.literal("on_event"), eventType: z.string().trim().min(1).max(200)}).strict(),
  z.object({kind: z.literal("schedule"), startsAt: TimestampSchema,
    intervalSeconds: z.number().int().min(60).max(31_536_000),
    missed: z.enum(["skip", "latest"]).default("skip"), input: z.record(z.string(), z.json()).default({}),
  }).strict(),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;
export const WorkflowTriggerUpdateInputSchema = z.object({
  ...Workflow, ...Mutation, workflowVersionId: IdSchema, expectedLocationRevision: Revision,
  trigger: WorkflowTriggerSchema, enabled: z.boolean(),
}).strict();
export type WorkflowTriggerUpdateInput = z.infer<typeof WorkflowTriggerUpdateInputSchema>;
export const WorkflowTriggerDisableInputSchema = z.object({ ...Workflow, ...Mutation }).strict();
export const WorkflowTriggerGetInputSchema = z.object({ ...Workflow }).strict();
export const WorkflowTriggerRecordSchema = z.object({
  ...Workflow, revision: Revision, workflowVersionId: IdSchema, locationRevision: Revision,
  trigger: WorkflowTriggerSchema, enabled: z.boolean(), nextFireAt: TimestampSchema.nullable(),
  lastError: z.string().nullable(),
}).strict();
export const WorkflowTriggerGetResultSchema = z.object({ trigger: WorkflowTriggerRecordSchema.nullable() }).strict();
export const WorkflowTriggerUpdateResultSchema = z.object({ value: WorkflowTriggerRecordSchema, replayed: z.boolean() }).strict();
export const WorkflowTriggerFireInputSchema = z.object({
  ...Workflow, commandId: Command, expectedRevision: Revision,
  eventType: z.string().trim().min(1).max(200).optional(),
  input: z.record(z.string(), z.json()),
}).strict();
export const WorkflowTriggerFireResultSchema = z.object({ value: z.object({ jobId: IdSchema, status: z.literal("queued") }).strict(), replayed: z.boolean() }).strict();
export const TriggerJobListInputSchema = z.object({ ...Workflow, ...Page }).strict();
export const TriggerJobPageSchema = z.object({ items: z.array(z.object({
  jobId: IdSchema, status: z.enum(["queued", "leased", "started", "blocked"]), runId: IdSchema.nullable(), errorCode: z.string().nullable(),
}).strict()), pageInfo: z.object({ nextCursor: z.string().nullable() }).strict() }).strict();

export const RunResumeInputSchema = z.object({ ...Workspace, runId: IdSchema, commandId: Command }).strict();
export const RunResumeResultSchema = z.object({ value: z.object({ runId: IdSchema, status: z.literal("reconciled") }).strict(), replayed: z.boolean() }).strict();
export const RunRetryInputSchema = z.object({ ...Workspace, runId: IdSchema, commandId: Command,
  workflowVersionId: IdSchema, expectedLocationRevision: Revision,
}).strict();

export const InteractionSummaryInputSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(), handler: ApprovalHandlerSchema.optional(),
}).strict();
export const InteractionSummaryResultSchema = z.object({
  pendingCount: Revision, pendingByWorkflow: z.record(z.string(), Revision),
}).strict();
export const OperatorCapabilityInputSchema = z.object({
  workspaceId: IdSchema.optional(), workflowId: IdSchema.optional(), runId: IdSchema.optional(),
}).strict();
