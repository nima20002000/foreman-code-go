import type { JobSql } from './repository.js'
import type { AcceptedJobSpec, JobArtifact, JobAuthoringChoices, JobDefinitionSpec, JobExecution, JobValidation, PreparedJobSpec } from '@graphql/contracts/jobs'
import type { ManagementPrincipal } from '@graphql/contracts/management'

/** W08 adapter owns durable dispatch and owner/cancel identity. No job scheduler. */
export interface JobDispatchPort {
  accept(client: JobSql, input: { workspaceId: string; executionId: string; attemptId:string; spec: AcceptedJobSpec;
    workflow: JobExecution['workflow']; principal: ManagementPrincipal }): Promise<Pick<JobExecution, 'operationId' | 'attemptId' | 'owner'>>
  cancel(client: JobSql, execution: JobExecution, commandId: string, principal:ManagementPrincipal): Promise<void>
  /** Called after COMMIT only. A lost wakeup is recovered by W08's durable dispatch. */
  wake(executionId: string): Promise<void>
}
/** Authority before any source/root probe; again immediately before dispatch/launch. */
export interface JobPreparationPort {
  choices(client: JobSql, principal: ManagementPrincipal, workspaceId: string): Promise<JobAuthoringChoices>
  validate(client: JobSql, principal: ManagementPrincipal, workspaceId: string, spec: JobDefinitionSpec): Promise<JobValidation>
  accept(client: JobSql, principal: ManagementPrincipal, workspaceId: string, spec: JobDefinitionSpec, identity:{executionId:string;attemptId:string}): Promise<PreparedJobSpec>
}
/** Canonical W09 file revisions, never a job artifact byte store. */
export interface JobArtifactPort {
  read(client: JobSql, principal: ManagementPrincipal, workspaceId: string, executionId: string, fileId: string, revisionId: string, source?: 'http'|'mcp'): Promise<{artifact:JobArtifact;bytes:Buffer}>
  list(client: JobSql, principal: ManagementPrincipal, workspaceId: string, executionId: string): Promise<JobArtifact[]>
}
