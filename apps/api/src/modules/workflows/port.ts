import type { WorkflowVersion } from '@graphql/contracts'

/** ENG-02 implements durable definitions and append-only versions behind this boundary. */
export interface WorkflowRepository {
  getVersion(workflowVersionId: string): Promise<WorkflowVersion | undefined>
  insertVersion(workflowVersion: WorkflowVersion): Promise<void>
}
