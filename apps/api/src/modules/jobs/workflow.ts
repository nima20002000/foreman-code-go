import { JobExecutionSchema, type JobDefinition, type JobExecution } from '@graphql/contracts/jobs'
import { JobWorkflowNodeSchema, JobWorkflowExecutionReferenceSchema, JobWorkflowAdmissionReferenceSchema, type JobWorkflowAdmissionReference, type JobWorkflowExecutionReference } from '@graphql/contracts/job-workflow'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type pg from 'pg'
import { DomainError } from '../errors.js'
import { JobService } from './service.js'

/** Shared Run owner authority validates the exact saved node, occurrence, input and budget
 * inside the existing graph transaction. A job relationship is not a launch capability. */
export interface WorkflowJobAuthority {
  require(sql:pg.PoolClient,reference:JobWorkflowAdmissionReference):Promise<{principal:ManagementPrincipal;definition:JobDefinition;node:unknown}>
  acceptResult(sql:pg.PoolClient,reference:JobWorkflowExecutionReference,execution:JobExecution):Promise<void>
}
export class WorkflowJobService {
  constructor(private readonly jobs:JobService,private readonly authority:WorkflowJobAuthority) {}
  async admit(sql:pg.PoolClient,raw:JobWorkflowAdmissionReference) {
    const reference=JobWorkflowAdmissionReferenceSchema.parse(raw)
    const {principal,definition,node:rawNode}=await this.authority.require(sql,reference)
    const node=JobWorkflowNodeSchema.parse(rawNode)
    if(node.id!==reference.nodeId||definition.workspaceId!==reference.workspaceId||node.jobDefinitionId!==definition.id||node.jobDefinitionRevision!==definition.revision||node.jobDefinitionVersionId!==definition.versionId) {
      throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT','The saved job node does not match its immutable definition version.',409)
    }
    const existing=(await sql.query<{job_execution_id:string}>(`select job_execution_id from workflow_job_executions where run_id=$1 and node_execution_id=$2 for update`,[reference.runId,reference.nodeExecutionId])).rows[0]
    if(existing) return this.jobs.repository.execution(sql,reference.workspaceId,existing.job_execution_id)
    const execution=await this.jobs.admit(sql,principal,definition,{workflowId:reference.workflowId,runId:reference.runId,nodeId:reference.nodeId,nodeExecutionId:reference.nodeExecutionId})
    await sql.query(`insert into workflow_job_executions(run_id,node_execution_id,job_execution_id,reference) values($1,$2,$3,$4::jsonb)`,[reference.runId,reference.nodeExecutionId,execution.id,JSON.stringify({...reference,jobExecutionId:execution.id})])
    return execution
  }
  async acceptResult(sql:pg.PoolClient,raw:JobWorkflowExecutionReference):Promise<JobExecution> {
    const reference=JobWorkflowExecutionReferenceSchema.parse(raw)
    await this.authority.require(sql,reference)
    const row=(await sql.query<{job_execution_id:string;accepted:boolean}>(`select job_execution_id,accepted from workflow_job_executions where run_id=$1 and node_execution_id=$2 for update`,[reference.runId,reference.nodeExecutionId])).rows[0]
    if(!row||row.job_execution_id!==reference.jobExecutionId) throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT','Job execution relationship is missing or changed.',409)
    const execution=JobExecutionSchema.parse(await this.jobs.repository.execution(sql,reference.workspaceId,row.job_execution_id,true))
    if(execution.process.phase!=='terminal'||!execution.process.processStopped||execution.publication==='pending'||execution.publication==='collecting') throw new DomainError('JOB_RESULT_PENDING','The required durable process/output result is not settled.',409)
    if(!row.accepted) {
      await this.authority.acceptResult(sql,reference,execution)
      await sql.query('update workflow_job_executions set accepted=true where run_id=$1 and node_execution_id=$2',[reference.runId,reference.nodeExecutionId])
    }
    return execution
  }
}
