import { readRunJobCleanup,requestRunJobCleanup } from './runCleanup.js'
import type { JobRunCleanup } from '@graphql/contracts/job-run-cleanup'
import type { RunOwnership } from '../runs/ownership.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { RemoteJobDispatchIntentSchema, RemoteJobOperationReceiptSchema, type RemoteJobDispatchPort, type RemoteJobOperationReceipt } from '@graphql/contracts/remote-job-execution'
import type { AcceptedJobSpec, JobExecution } from '@graphql/contracts/jobs'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { JobOwnership } from './ownership.js'
import { canonical, JobRepository, type JobSql } from './repository.js'
import type { JobDispatchPort } from './ports.js'
import type { JobRuntimeAuthority } from './authority.js'
import type { JobWorkerFence } from './worker.js'

export interface JobDispatchHost {
  /** Actual W07 registration/boot/current connection and W09 source/root qualification. */
  revalidate(sql:JobSql,execution:JobExecution,principal:ManagementPrincipal):Promise<void>
  authorizeControl(sql:JobSql,execution:JobExecution,principal:ManagementPrincipal):Promise<void>
  observe(sql:JobSql,execution:JobExecution,receipt:RemoteJobOperationReceipt):Promise<void>
}
/** Durable job intent is consumed by the same W08 carrier/journal, never a new scheduler. */
export class PostgresJobDispatch implements JobDispatchPort,JobRuntimeAuthority {
  private readonly repository=new JobRepository()
  private readonly owners=new Map<string,{owner:JobOwnership;abort:AbortController}>()
  constructor(private readonly pool:pg.Pool,private readonly remote:RemoteJobDispatchPort,private readonly host:JobDispatchHost) {}
  async accept(sql:JobSql,input:{workspaceId:string;executionId:string;attemptId:string;operationId:string;spec:AcceptedJobSpec;workflow:JobExecution['workflow'];principal:ManagementPrincipal}) {
    const intent=RemoteJobDispatchIntentSchema.parse({schemaVersion:1,protocolVersion:1,mainId:input.spec.target.mainId,
      subject:input.workflow?{kind:'workflow-node',workspaceId:input.workspaceId,...input.workflow}:{kind:'manual-job',workspaceId:input.workspaceId,jobExecutionId:input.executionId,definitionId:input.spec.definitionId},
      executionId:input.executionId,attemptId:input.attemptId,operationId:input.operationId,bindingHash:input.spec.bindingHash,inputDigest:`sha256:${input.spec.specDigest}`,owner:{grantId:randomUUID(),epoch:'1'}})
    await sql.query('insert into job_dispatch_intents(execution_id,workspace_id,intent) values($1,$2,$3::jsonb)',[input.executionId,input.workspaceId,JSON.stringify(intent)])
    return {operationId:intent.operationId,attemptId:intent.attemptId,owner:intent.owner}
  }
  async cancel(sql:JobSql,execution:JobExecution,commandId:string,principal:ManagementPrincipal,action:'jobs:cancel'|'runs:stop'='jobs:cancel'):Promise<void> {
    await sql.query('update job_dispatch_intents set cancel_command_id=coalesce(cancel_command_id,$2),cancel_principal_id=coalesce(cancel_principal_id,$3),cancel_action=coalesce(cancel_action,$4) where execution_id=$1',[execution.id,commandId,principal.id,action])
  }
  cancelForRunCleanup(sql:GraphTransactionSql,execution:JobExecution,owner:RunOwnership,reason:JobRunCleanup['reason']) {return requestRunJobCleanup(sql,execution,owner,reason)}
  private async requireOwner(sql:JobSql,execution:JobExecution,fence:JobWorkerFence):Promise<void> {
    const row=(await sql.query<{intent:unknown;owner_id:string|null;owner_fence:string|null}>('select intent,owner_id,owner_fence from job_dispatch_intents where execution_id=$1 for share',[execution.id])).rows[0]
    if(!row)throw new DomainError('JOB_DISPATCH_MISSING','The accepted W08 job dispatch intent is missing.',409)
    const intent=RemoteJobDispatchIntentSchema.parse(row.intent)
    if(intent.executionId!==execution.id||intent.operationId!==execution.operationId||intent.mainId!==execution.acceptedSpec.target.mainId||intent.subject.workspaceId!==execution.workspaceId||intent.inputDigest!==`sha256:${execution.acceptedSpec.specDigest}`||intent.attemptId!==fence.attemptId||intent.owner.grantId!==fence.owner.grantId||intent.owner.epoch!==fence.owner.epoch||intent.bindingHash!==execution.acceptedSpec.bindingHash||!row.owner_id||!row.owner_fence)throw new DomainError('JOB_OWNER_FENCE_INVALID','The accepted job owner/attempt binding is not live.',409)
    const live=(await sql.query(`select 1 from pg_stat_activity a where a.pid::text=$1 and (extract(epoch from a.backend_start)*1000000)::bigint::text=$2 and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=810038::oid and l.objid=(hashtext($3)::bigint & 4294967295)::oid and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)`,[row.owner_id,row.owner_fence,execution.id])).rows.length
    if(!live)throw new DomainError('JOB_OWNERSHIP_LOST','The original main job owner session is no longer live.',409)
  }
  /** Launch/publication never borrow committed cleanup stop authority. */
  async require(sql:JobSql,execution:JobExecution,fence:JobWorkerFence):Promise<void> {
    await this.requireOwner(sql,execution,fence)
    if(await readRunJobCleanup(sql,execution))throw new DomainError('JOB_CLEANUP_ONLY','The original Run owner admitted stop/closure only, not launch or publication.',409)
    const accepted=(await sql.query<{accepted_by:string;cancel_principal_id:string|null;cancel_action:'jobs:cancel'|'runs:stop'|null}>(`select e.accepted_by,d.cancel_principal_id,d.cancel_action from job_executions e join job_dispatch_intents d on d.execution_id=e.id where e.id=$1`,[execution.id])).rows[0]!
    const principal=await readLiveManagementPrincipal(sql,accepted.cancel_principal_id??accepted.accepted_by)
    requireAuthorization(principal,accepted.cancel_principal_id?accepted.cancel_action!:execution.workflow?'runs:start':'jobs:start',{workspaceId:execution.workspaceId,...(execution.workflow?{workflowId:execution.workflow.workflowId,runId:execution.workflow.runId}:{})})
    if(accepted.cancel_principal_id)await this.host.authorizeControl(sql,execution,principal)
    else await this.host.revalidate(sql,execution,principal)
  }
  async requireControl(sql:JobSql,execution:JobExecution,fence:JobWorkerFence):Promise<void> {
    await this.requireOwner(sql,execution,fence)
    if(await readRunJobCleanup(sql,execution))return
    await this.require(sql,execution,fence)
  }
  /** Only trusted carrier receipt ingress uses this. No file write/read capability. */
  async requireEvidence(sql:JobSql,execution:JobExecution,fence:JobWorkerFence):Promise<void> {return this.requireControl(sql,execution,fence)}
  async wake(executionId:string):Promise<void> {
    let active=this.owners.get(executionId)
    if(!active) {
      const abort=new AbortController(),owner=await JobOwnership.acquire(this.pool,executionId,()=>abort.abort())
      if(!owner)return
      active={owner,abort};this.owners.set(executionId,active)
    }
    const {owner,abort}=active
    try {
      const prepared=await owner.connection.transaction(async sql=>{
        const scope=(await sql.query<{workspace_id:string}>('select workspace_id from job_executions where id=$1',[executionId])).rows[0]
        if(!scope)throw new DomainError('JOB_NOT_FOUND','The accepted job is missing.',404)
        const execution=await this.repository.execution(sql,scope.workspace_id,executionId,true)
        const row=(await sql.query<{intent:unknown;delivery_attempted:boolean;cancel_command_id:string|null;cancel_principal_id:string|null;cancel_action:'jobs:cancel'|'runs:stop'|null}>('select intent,delivery_attempted,cancel_command_id,cancel_principal_id,cancel_action from job_dispatch_intents where execution_id=$1 for update',[executionId])).rows[0]!
        const accepted=(await sql.query<{accepted_by:string}>('select accepted_by from job_executions where id=$1',[executionId])).rows[0]!
        const cleanup=await readRunJobCleanup(sql,execution)
        if(!cleanup) {
          const principal=await readLiveManagementPrincipal(sql,row.cancel_command_id?row.cancel_principal_id!:accepted.accepted_by)
          requireAuthorization(principal,row.cancel_command_id?row.cancel_action!:execution.workflow?'runs:start':'jobs:start',{workspaceId:execution.workspaceId,...(execution.workflow?{workflowId:execution.workflow.workflowId,runId:execution.workflow.runId}:{})})
          if(row.cancel_command_id)await this.host.authorizeControl(sql,execution,principal)
          else await this.host.revalidate(sql,execution,principal)
        }
        const fence=await owner.readFence(sql)
        await sql.query('update job_dispatch_intents set owner_id=$2,owner_fence=$3 where execution_id=$1',[executionId,fence.ownerId,fence.fence])
        beforeGraphCommit(sql,()=>cleanup?this.requireControl(sql,execution,{attemptId:execution.attemptId,owner:execution.owner}):this.require(sql,execution,{attemptId:execution.attemptId,owner:execution.owner}))
        if(execution.process.phase==='terminal'&& !['pending','collecting'].includes(execution.publication))return {execution,intent:RemoteJobDispatchIntentSchema.parse(row.intent),action:'none' as const,cancelCommandId:row.cancel_command_id}
        if(row.cancel_command_id&&!row.delivery_attempted) {
          execution.process={phase:'terminal',outcome:'cancelled',exitCode:null,signal:null,processStopped:true};execution.finishedAt=new Date().toISOString();execution.publication='complete';execution.updatedAt=execution.finishedAt
          await this.repository.putExecution(sql,execution)
          return {execution,intent:RemoteJobDispatchIntentSchema.parse(row.intent),action:'none' as const,cancelCommandId:row.cancel_command_id}
        }
        await sql.query('update job_dispatch_intents set delivery_attempted=true where execution_id=$1',[executionId])
        return {execution,intent:RemoteJobDispatchIntentSchema.parse(row.intent),action:row.delivery_attempted?'reconcile' as const:'deliver' as const,cancelCommandId:row.cancel_command_id}
      })
      if(prepared.action==='none') {await this.release(executionId);return}
      abort.signal.throwIfAborted();owner.assertOwned()
      let status=prepared.action==='deliver'?await this.remote.deliver(prepared.intent,prepared.execution):await this.remote.reconcile(prepared.intent)
      if(prepared.cancelCommandId&&prepared.execution.process.phase!=='terminal') status=await this.remote.control({schemaVersion:1,protocolVersion:1,commandId:prepared.cancelCommandId,operationId:prepared.intent.operationId,attemptId:prepared.intent.attemptId,executionId,subject:prepared.intent.subject,bindingHash:prepared.intent.bindingHash,owner:prepared.intent.owner,action:{kind:'stop'}})
      owner.assertOwned()
      const finished=await owner.connection.transaction(async sql=>{
        const execution=await this.repository.execution(sql,prepared.execution.workspaceId,executionId,true)
        await this.requireEvidence(sql,execution,{attemptId:execution.attemptId,owner:execution.owner})
        beforeGraphCommit(sql,()=>this.requireControl(sql,execution,{attemptId:execution.attemptId,owner:execution.owner}))
        if(status.status==='known'&&await this.acceptReceipt(sql,execution,status.receipt))await this.host.observe(sql,execution,status.receipt)
        else {execution.transport='unknown';execution.updatedAt=new Date().toISOString();await this.repository.putExecution(sql,execution)}
        const current=await this.repository.execution(sql,prepared.execution.workspaceId,executionId)
        return current.process.phase==='terminal'&&!['pending','collecting'].includes(current.publication)
      })
      if(finished)await this.release(executionId)
    } catch(error) {
      if(abort.signal.aborted)await this.release(executionId)
      throw error
    }
  }
  /** W07/W08 validated receipt ingress. Retains the original main owner across asynchronous work. */
  async observeReceipt(workspaceId:string,executionId:string,receipt:RemoteJobOperationReceipt):Promise<void> {
    const active=this.owners.get(executionId)
    if(!active)throw new DomainError('JOB_RECONCILIATION_REQUIRED','Acquire the original job owner and reconcile its journal before accepting a receipt.',409)
    active.owner.assertOwned()
    const terminal=await active.owner.connection.transaction(async sql=>{
      const execution=await this.repository.execution(sql,workspaceId,executionId,true)
      await this.requireEvidence(sql,execution,{attemptId:receipt.intent.attemptId,owner:receipt.intent.owner})
      beforeGraphCommit(sql,()=>this.requireEvidence(sql,execution,{attemptId:receipt.intent.attemptId,owner:receipt.intent.owner}))
      if(await this.acceptReceipt(sql,execution,receipt))await this.host.observe(sql,execution,receipt)
      const current=await this.repository.execution(sql,workspaceId,executionId)
      return current.process.phase==='terminal'&&!['pending','collecting'].includes(current.publication)
    })
    if(terminal)await this.release(executionId)
  }
  private async acceptReceipt(sql:JobSql,execution:JobExecution,receipt:RemoteJobOperationReceipt):Promise<boolean> {
    receipt=RemoteJobOperationReceiptSchema.parse(receipt)
    const row=(await sql.query<{intent:unknown;receipt_sequence:string;last_receipt:unknown}>('select intent,receipt_sequence::text,last_receipt from job_dispatch_intents where execution_id=$1 for update',[execution.id])).rows[0]!
    if(canonical(row.intent)!==canonical(receipt.intent))throw new DomainError('JOB_RECEIPT_PIN_CONFLICT','Remote receipt does not match the accepted operation/attempt/subject.',409)
    if(row.last_receipt) {
      const previous=RemoteJobOperationReceiptSchema.parse(row.last_receipt)
      if(canonical(previous.connection)!==canonical(receipt.connection)||previous.workerIncarnationId!==receipt.workerIncarnationId)throw new DomainError('JOB_RECEIPT_IDENTITY_CONFLICT','Original worker receipt identity cannot change during recovery.',409)
      if(previous.native && (!receipt.native||previous.native.containerId!==receipt.native.containerId||previous.native.supervisorIdentity!==receipt.native.supervisorIdentity||previous.native.processIdentityDigest!==receipt.native.processIdentityDigest||previous.native.startedAt!==receipt.native.startedAt))throw new DomainError('JOB_NATIVE_IDENTITY_CONFLICT','Original supervised container/process identity cannot change.',409)
      if(previous.terminal && (!receipt.terminal||previous.terminal.outcome!==receipt.terminal.outcome||previous.terminal.exitCode!==receipt.terminal.exitCode||previous.terminal.signal!==receipt.terminal.signal||previous.terminal.finishedAt!==receipt.terminal.finishedAt||previous.terminal.closureEvidenceDigest!==receipt.terminal.closureEvidenceDigest))throw new DomainError('JOB_TERMINAL_CONFLICT','Original observed process closure cannot change.',409)
    }
    if(receipt.sequence<=Number(row.receipt_sequence)) {
      if(receipt.sequence===Number(row.receipt_sequence)&&canonical(receipt)===canonical(row.last_receipt))return false
      throw new DomainError('JOB_RECEIPT_STALE','Remote receipt is stale or conflicts with an acknowledged sequence.',409)
    }
    await sql.query('update job_dispatch_intents set receipt_sequence=$2,last_receipt=$3::jsonb where execution_id=$1',[execution.id,receipt.sequence,JSON.stringify(receipt)])
    return true
  }
  private async release(executionId:string) {const active=this.owners.get(executionId);if(!active)return;this.owners.delete(executionId);await active.owner.release()}
  async close():Promise<void> {await Promise.allSettled([...this.owners.keys()].map(id=>this.release(id)))}
}
