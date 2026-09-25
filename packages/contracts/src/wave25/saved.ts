import { z } from 'zod'
import {
  WorkflowDefinitionSchema, WorkflowDefinitionV2Schema, WorkflowVersionSchema,
  WorkflowRunSchema, GetRunResponseSchema, WorkspaceDetailsSchema,
} from '../index.js'
import { ManagedWorkflowSchema, ManagementPageInfoSchema } from '../management/index.js'
import { WorkflowVersionV2Schema, WorkflowRunV2Schema, RunDetailsV2Schema } from './workflow.js'
import { RepeatWorkflowVersionV1Schema, RepeatWorkflowRunV1Schema } from './repeat.js'
import { sameWorkflowValue } from './meaningfulEdit.js'

/** Persisted/read compatibility, NOT execution admission. Keep the legacy and
 * one-shot schemas strict. Callers opt in explicitly; neither a v3 definition
 * nor a v3 Run is ever retagged or cast to a v2 value. */
export const WorkflowDefinitionV3Schema = RepeatWorkflowVersionV1Schema.shape.definition
export const WorkflowVersionV3Schema = RepeatWorkflowVersionV1Schema
export const WorkflowRunV3Schema = RepeatWorkflowRunV1Schema
export type WorkflowDefinitionV3 = z.infer<typeof WorkflowDefinitionV3Schema>
export type WorkflowVersionV3 = z.infer<typeof WorkflowVersionV3Schema>
export type WorkflowRunV3 = z.infer<typeof WorkflowRunV3Schema>

export const SavedWorkflowDefinitionSchema = z.union([
  WorkflowDefinitionSchema, WorkflowDefinitionV2Schema, WorkflowDefinitionV3Schema,
])
export const SavedWorkflowVersionSchema = z.union([
  WorkflowVersionSchema, WorkflowVersionV2Schema, WorkflowVersionV3Schema,
])
export const SavedWorkflowRunSchema = z.union([
  WorkflowRunSchema, WorkflowRunV2Schema, WorkflowRunV3Schema,
])
export type SavedWorkflowDefinition = z.infer<typeof SavedWorkflowDefinitionSchema>
export type SavedWorkflowVersion = z.infer<typeof SavedWorkflowVersionSchema>
export type SavedWorkflowRun = z.infer<typeof SavedWorkflowRunSchema>

/** Public detail retains existing result authorization/redaction obligations.
 * This is NOT the content-free graph/occurrence metadata contract. A redacted
 * Run may omit location and principal; internal admission uses a stronger schema. */
export const RunDetailsV3Schema = GetRunResponseSchema.extend({ run: WorkflowRunV3Schema }).strict()
  .superRefine(({ run, executions, activity }, context) => {
    const ids = new Set<string>()
    for (const execution of executions) {
      if (ids.has(execution.id) || execution.runId !== run.id
        || execution.agentConfigurationVersionId !== run.agentConfigurationVersionIds[execution.agentId]) {
        context.addIssue({ code: 'custom', message: 'RUN_EXECUTION_PIN_MISMATCH' })
      }
      ids.add(execution.id)
    }
    if (activity.some((event) => event.runId !== run.id)) {
      context.addIssue({ code: 'custom', message: 'RUN_ACTIVITY_PIN_MISMATCH' })
    }
  })
export const SavedRunDetailsSchema = z.union([GetRunResponseSchema, RunDetailsV2Schema, RunDetailsV3Schema])
export type SavedRunDetails = z.infer<typeof SavedRunDetailsSchema>

export const SavedManagedWorkflowSchema = ManagedWorkflowSchema.extend({ workflow: SavedWorkflowDefinitionSchema }).strict()
export type SavedManagedWorkflow = z.infer<typeof SavedManagedWorkflowSchema>
export const SavedManagedWorkflowPageSchema = z.object({
  items: z.array(SavedManagedWorkflowSchema), pageInfo: ManagementPageInfoSchema,
}).strict()
export const SavedManagedWorkflowCommandResultSchema = z.object({
  value: SavedManagedWorkflowSchema, replayed: z.boolean(),
}).strict()
export const SavedWorkspaceDetailsSchema = WorkspaceDetailsSchema.extend({
  workflows: z.array(SavedWorkflowDefinitionSchema),
}).strict()
export const SavedWorkflowVersionPageSchema = z.object({
  items: z.array(SavedWorkflowVersionSchema), pageInfo: ManagementPageInfoSchema,
}).strict()
export const SavedWorkflowVersionDetailSchema = z.object({ version: SavedWorkflowVersionSchema }).strict()
export const SavedRunPageSchema = z.object({ items: z.array(SavedWorkflowRunSchema), pageInfo: ManagementPageInfoSchema }).strict()

/** Loaded immutable snapshots only. No lookup of a moving workflow/Agent head.
 * The DB reader must additionally prove physical row identity and content hash. */
export const SavedRunVersionSnapshotSchema = z.object({
  run: SavedWorkflowRunSchema, version: SavedWorkflowVersionSchema,
}).strict().superRefine(({ run, version }, context) => {
  const runSemantics = 'executionSemanticsVersion' in run ? run.executionSemanticsVersion : 1
  const versionSemantics = 'executionSemanticsVersion' in version ? version.executionSemanticsVersion : 1
  if (runSemantics !== versionSemantics || run.workflowVersionId !== version.id
    || run.workspaceId !== version.workspaceId || run.workflowId !== version.workflowId
    || !sameWorkflowValue(run.agentConfigurationVersionIds, version.agentConfigurationVersionIds)
    || !sameWorkflowValue(run.approval, version.approval)
    || !sameWorkflowValue(run.executionCondition, version.definition.executionCondition)) {
    context.addIssue({ code: 'custom', message: 'RUN_VERSION_SNAPSHOT_PIN_MISMATCH' })
  }
})
export type SavedRunVersionSnapshot = z.infer<typeof SavedRunVersionSnapshotSchema>

export type RunDetailsV3 = z.infer<typeof RunDetailsV3Schema>
export type SavedManagedWorkflowPage = z.infer<typeof SavedManagedWorkflowPageSchema>
export type SavedManagedWorkflowCommandResult = z.infer<typeof SavedManagedWorkflowCommandResultSchema>
export type SavedWorkspaceDetails = z.infer<typeof SavedWorkspaceDetailsSchema>
export type SavedWorkflowVersionPage = z.infer<typeof SavedWorkflowVersionPageSchema>
export type SavedWorkflowVersionDetail = z.infer<typeof SavedWorkflowVersionDetailSchema>
export type SavedRunPage = z.infer<typeof SavedRunPageSchema>
