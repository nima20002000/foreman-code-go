import { z } from 'zod'
import { AcceptedWorkflowApprovalConfigurationSchema, RunExecutionLocationSchema, IdSchema } from '../index.js'
import { GraphDraftSchema, RunStartInputSchema, RunStartResultSchema } from '../management/index.js'
import { GraphDigestSchema, GraphIdSchema } from './protocol.js'
import { ExecutableRepeatWorkflowV1Schema } from './repeat.js'
import { WorkflowDefinitionV3Schema, WorkflowRunV3Schema, SavedRunVersionSnapshotSchema } from './saved.js'
import { sameExecutableWorkflow, sameWorkflowValue } from './meaningfulEdit.js'

/** Deliberately not added to the existing HTTP/MCP/engine Start union. A new
 * command must carry the exact displayed workflow revision and configuration
 * map as well as the existing immutable version, location and optional draft. */
export const RunStartV3InputSchema = RunStartInputSchema.safeExtend({
  executionSemanticsVersion: z.literal(3),
  expectedWorkflowRevision: z.number().int().nonnegative(),
  expectedAgentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
})
export type RunStartV3Input = z.infer<typeof RunStartV3InputSchema>
export const RunStartV3ResultSchema = RunStartResultSchema.extend({ run: WorkflowRunV3Schema }).strict()

/** Shape of a server-validated location, not a filesystem validation capability.
 * Preserve path bytes. Relative paths and incomplete identity hashes fail closed. */
export const RunExecutionLocationV3Schema = RunExecutionLocationSchema.extend({
  identityHash: GraphDigestSchema,
  rootPath: RunExecutionLocationSchema.shape.rootPath.refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value), 'an accepted location must be absolute'),
}).strict()
export const AcceptedWorkflowRunV3Schema = WorkflowRunV3Schema.safeExtend({
  executionLocation: RunExecutionLocationV3Schema,
  approval: AcceptedWorkflowApprovalConfigurationSchema,
  authorizationPrincipalId: IdSchema,
})
export type AcceptedWorkflowRunV3 = z.infer<typeof AcceptedWorkflowRunV3Schema>
export const ExecutableWorkflowV3Schema = ExecutableRepeatWorkflowV1Schema
export const GraphDraftV3Schema = GraphDraftSchema.extend({ graph: WorkflowDefinitionV3Schema }).strict()

/** A read/preflight contract. It supplies no command receipt, owner lease,
 * native qualification, live grant, launch, or publication permission. Both
 * physical identities and live authority must be rechecked under Start locks. */
export const RepeatStartSnapshotV1Schema = z.object({
  request: RunStartV3InputSchema,
  authorizationPrincipalId: IdSchema,
  executable: ExecutableWorkflowV3Schema,
  workflow: z.object({
    id: GraphIdSchema, workspaceId: GraphIdSchema, revision: z.number().int().nonnegative(),
    currentVersionId: GraphIdSchema, archived: z.boolean(), definition: WorkflowDefinitionV3Schema,
  }).strict(),
  workspace: z.object({ id: GraphIdSchema, archived: z.boolean(), location: RunExecutionLocationV3Schema }).strict(),
  draft: GraphDraftV3Schema.nullable(),
}).strict().superRefine(({ request, executable: { version }, workflow, workspace, draft }, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message })
  if (request.workspaceId !== version.workspaceId || request.workflowId !== version.workflowId
    || request.workflowVersionId !== version.id || workspace.id !== version.workspaceId
    || workflow.id !== version.workflowId || workflow.workspaceId !== version.workspaceId
    || workflow.currentVersionId !== version.id) fail('REPEAT_START_VERSION_PIN_MISMATCH')
  if (workspace.archived || workflow.archived) fail('REPEAT_START_PARENT_ARCHIVED')
  if (workflow.revision !== request.expectedWorkflowRevision) fail('REPEAT_START_WORKFLOW_REVISION_CONFLICT')
  if (workspace.location.locationRevision !== request.expectedLocationRevision) fail('REPEAT_START_LOCATION_REVISION_CONFLICT')
  if (!sameWorkflowValue(request.expectedAgentConfigurationVersionIds, version.agentConfigurationVersionIds)) {
    fail('REPEAT_START_CONFIGURATION_PIN_MISMATCH')
  }
  // Management labels and geometry may change without a new executable version.
  // Revision still matches the displayed workflow. No executable field is ignored.
  const sameSavedMeaning = (definition: z.infer<typeof WorkflowDefinitionV3Schema>) => {
    const comparable = { ...definition, name: version.definition.name, description: version.definition.description }
    return definition.version === version.version && sameExecutableWorkflow(version.definition, comparable)
  }
  if (!sameSavedMeaning(workflow.definition)) fail('REPEAT_START_UNPUBLISHED_WORKFLOW')
  if (request.draftId === undefined) {
    if (draft !== null) fail('REPEAT_START_UNREQUESTED_DRAFT')
  } else if (!draft || draft.id !== request.draftId || draft.workspaceId !== version.workspaceId
    || draft.workflowId !== version.workflowId || draft.revision !== request.expectedDraftRevision
    || draft.publishedRevision !== draft.revision || draft.baseWorkflowVersionId !== version.id
    || draft.stagedAgents.length !== 0 || !sameSavedMeaning(draft.graph)) {
    fail('REPEAT_START_DISPLAYED_GRAPH_NOT_PUBLISHED')
  }
})
export type RepeatStartSnapshotV1 = z.infer<typeof RepeatStartSnapshotV1Schema>

/** Internal admission/receipt check before a NEW queued Run is committed. A
 * replay must instead validate the stored snapshot, never today's mutable head. */
export const AcceptedRepeatStartV1Schema = z.object({
  snapshot: RepeatStartSnapshotV1Schema, run: AcceptedWorkflowRunV3Schema,
}).strict().superRefine(({ snapshot, run }, context) => {
  if (!SavedRunVersionSnapshotSchema.safeParse({ run, version: snapshot.executable.version }).success
    || run.authorizationPrincipalId !== snapshot.authorizationPrincipalId
    || run.executionState !== 'queued' || run.outcome !== 'pending'
    || !sameWorkflowValue(run.executionLocation, snapshot.workspace.location)
    || !sameWorkflowValue(run.input, snapshot.request.input)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_START_ACCEPTED_RUN_MISMATCH' })
  }
})

export type RunStartV3Result = z.infer<typeof RunStartV3ResultSchema>
export type RunExecutionLocationV3 = z.infer<typeof RunExecutionLocationV3Schema>
export type ExecutableWorkflowV3 = z.infer<typeof ExecutableWorkflowV3Schema>
export type GraphDraftV3 = z.infer<typeof GraphDraftV3Schema>
export type AcceptedRepeatStartV1 = z.infer<typeof AcceptedRepeatStartV1Schema>
