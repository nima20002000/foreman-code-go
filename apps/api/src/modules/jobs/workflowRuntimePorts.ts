import type { JobArtifact, JobExecution, PreparedJobSpec } from '@graphql/contracts/jobs'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatNodeRef, RepeatResolution } from '../runs/repeatResolution.js'
import type { WorkflowJobPreparation } from './workflowPreparation.js'

export type WorkflowJobAdmission={kind:'waiting'}|{kind:'resolved';resolution:RepeatResolution}
  |{kind:'preparation';preparation:WorkflowJobPreparation;ref:RepeatNodeRef}|{kind:'admitted';execution:JobExecution}
/** Narrow composition on the one existing Run owner/graph. No scheduler or provider identifiers. */
export interface WorkflowJobLockedPort {
  admitPrepared(sql:GraphTransactionSql,ref:RepeatNodeRef,preparation:WorkflowJobPreparation,spec:PreparedJobSpec):Promise<JobExecution>
  read(sql:GraphTransactionSql,executionId:string):Promise<JobExecution>
  artifacts(sql:GraphTransactionSql,execution:JobExecution):Promise<JobArtifact[]>
  verifyResult(sql:GraphTransactionSql,execution:JobExecution):Promise<void>
}
export interface WorkflowJobDriver {
  /** Source/byte I/O happens outside the owner's GraphTransactionSql. */
  prepare(preparation:WorkflowJobPreparation,signal:AbortSignal):Promise<PreparedJobSpec>
  observe(execution:JobExecution,signal:AbortSignal,observe:()=>Promise<JobExecution>):Promise<void>
}
