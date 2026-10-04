import type { JobRunCleanup } from '@graphql/contracts/job-run-cleanup'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { JobSql } from './repository.js'
import type {
  AcceptedJobSpec, JobArtifact, JobAuthoringChoices, JobDefinition, JobDefinitionSpec,
  ResolvedJobDefinitionSpec, JobExecution, JobValidation, PreparedJobSpec,
} from '@graphql/contracts/jobs'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { JobQueueLimitsSchema } from '@graphql/contracts/job-admission'
import type { JobResourceRequest } from '@graphql/contracts/job-verification-policy'
import type { z } from 'zod'

/** Resource envelopes and queue limits come from reviewed application configuration. */
export interface JobQueueConfiguration {
  revision: number
  review: { reviewedByPrincipalId: string; reviewedAt: string; decisionDigest: string }
  limits: z.infer<typeof JobQueueLimitsSchema>
  resources(sql: JobSql, definition: JobDefinition): Promise<JobResourceRequest>
}

/** W08 adapter owns durable dispatch and owner/cancel identity. No job scheduler. */
export interface JobDispatchPort {
  accept(client: JobSql, input: { workspaceId: string; executionId: string; attemptId:string; operationId:string; spec: AcceptedJobSpec;
    workflow: JobExecution['workflow']; principal: ManagementPrincipal }): Promise<Pick<JobExecution, 'operationId' | 'attemptId' | 'owner'>>
  cancel(client: JobSql, execution: JobExecution, commandId: string, principal:ManagementPrincipal,action?:'jobs:cancel'|'runs:stop'): Promise<void>
  cancelForRunCleanup(client:GraphTransactionSql,execution:JobExecution,owner:RunOwnership,reason:JobRunCleanup['reason']):Promise<JobRunCleanup>
  /** Called after COMMIT only. A lost wakeup is recovered by W08's durable dispatch. */
  wake(executionId: string): Promise<void>
}
/** Authority before any source/root probe; again immediately before dispatch/launch. */
export interface JobPreparationPort {
  revalidateAccepted(client:JobSql,principal:ManagementPrincipal,execution:JobExecution):Promise<void>
  adoptFinalBinding(client:JobSql,principal:ManagementPrincipal,execution:JobExecution):Promise<void>
  choices(client: JobSql, principal: ManagementPrincipal, workspaceId: string): Promise<JobAuthoringChoices>
  validate(client: JobSql, principal: ManagementPrincipal, workspaceId: string, spec: JobDefinitionSpec): Promise<JobValidation>
  accept(client: JobSql, principal: ManagementPrincipal, workspaceId: string, spec: ResolvedJobDefinitionSpec, identity:{executionId:string;attemptId:string;operationId:string}): Promise<PreparedJobSpec>
}
/** Canonical W09 file revisions, never a job artifact byte store. */
export interface JobArtifactPort {
  read(client: JobSql, principal: ManagementPrincipal, workspaceId: string, executionId: string, fileId: string, revisionId: string, source?: 'http'|'mcp'): Promise<{artifact:JobArtifact;bytes:Buffer}>
  list(client: JobSql, principal: ManagementPrincipal, workspaceId: string, executionId: string): Promise<JobArtifact[]>
}
