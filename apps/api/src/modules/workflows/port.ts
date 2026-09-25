import type { WorkflowVersion } from '@graphql/contracts'
import type { SavedWorkflowVersion } from '@graphql/contracts/wave25'

/** Existing engine-facing contract. V3 must not enter an unconverted caller. */
export interface WorkflowRepository {
  getVersion(workflowVersionId: string): Promise<WorkflowVersion | undefined>
  insertVersion(workflowVersion: WorkflowVersion): Promise<void>
}

/** Opt-in immutable history/Run snapshot reader, not an engine or Start port. */
export interface ImmutableWorkflowVersionReader {
  getSavedVersion(workflowVersionId: string): Promise<SavedWorkflowVersion | undefined>
  getCurrentSavedVersion(workspaceId: string, workflowId: string): Promise<SavedWorkflowVersion | undefined>
}
