import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'

/** One current immutable reader for the existing engine and management clients.
 * Publication belongs to authenticated CurrentWorkflowAuthoringService, never a
 * raw repository INSERT that lacks a command, live grants or a typed witness. */
export interface WorkflowRepository {
  getVersion(workflowVersionId: string): Promise<WorkflowVersionV3 | undefined>
}
export interface ImmutableWorkflowVersionReader {
  getSavedVersion(workflowVersionId: string): Promise<WorkflowVersionV3 | undefined>
  getCurrentSavedVersion(workspaceId: string, workflowId: string): Promise<WorkflowVersionV3 | undefined>
}
