import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { WorkflowRunSchema, WorkflowVersionSchema } from '@graphql/contracts'
import {
  WorkflowTriggerRecordSchema, WorkflowTriggerUpdateInputSchema,
  type ManagementPrincipal, type WorkflowTriggerUpdateInput,
} from '@graphql/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator, commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { RunManagementService } from '../runs/management.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { firstScheduleAt,dueSchedule } from './triggerTiming.js'
import { readTriggerAuthority,TriggerJobPayloadSchema } from './triggerAuthority.js'

type TriggerRow={workspace_id:string;workflow_id:string;revision:string;principal_id:string;record:unknown;enabled:boolean;next_fire_at:Date|null;last_error:string|null}
type JobRow={id:string;workspace_id:string;workflow_id:string;principal_id:string;trigger_revision:string;payload:unknown;attempts:number;lease_owner:string}
function projection(row:TriggerRow) {
  const record=WorkflowTriggerRecordSchema.parse(row.record)
  return WorkflowTriggerRecordSchema.parse({...record,revision:Number(row.revision),enabled:row.enabled,
    nextFireAt:row.next_fire_at?.toISOString() ?? null,lastError:row.last_error})
}
function jobId(parts:unknown[]):string{return `trigger-${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`}

export class WorkflowTriggerService {
  private running:Promise<void>|undefined
  constructor(private readonly pool:pg.Pool,private readonly commands:PostgresCommandCoordinator,private readonly runs:RunManagementService) {}

  async get(principal:ManagementPrincipal,input:{workspaceId:string;workflowId:string}) {
    requireAuthorization(principal,'workflow_triggers:read',input)
    const rows=await this.pool.query<TriggerRow>('select * from workflow_triggers where workspace_id=$1 and workflow_id=$2',[input.workspaceId,input.workflowId])
    return {trigger:rows.rows[0] ? projection(rows.rows[0]):null}
  }
  update(principal:ManagementPrincipal,raw:WorkflowTriggerUpdateInput) {
    const input=WorkflowTriggerUpdateInputSchema.parse(raw)
    const scope={workspaceId:input.workspaceId,workflowId:input.workflowId}
    requireAuthorization(principal,'workflow_triggers:update',scope)
    requireAuthorization(principal,'workflows:read',scope)
    if (input.enabled) {
      requireAuthorization(principal,'runs:start',scope)
      requireAuthorization(principal,'workspace_locations:read',{workspaceId:input.workspaceId})
    }
    return this.commands.execute({principal,source:'mcp',operation:'workflow.trigger.update',commandId:input.commandId,
      targetKey:`workflow:${input.workflowId}:trigger`,payload:input,perform:async(client)=>{
        await lockActiveWorkspace(client,input.workspaceId)
        const workflow=await client.query<{current_version_id:string|null;record:unknown}>(
          'select current_version_id,record from workflows where workspace_id=$1 and id=$2 and archived_at is null for update',[input.workspaceId,input.workflowId],
        )
        if (!workflow.rows[0]) throw new DomainError('WORKFLOW_NOT_FOUND','The active workflow was not found.',404)
        if (workflow.rows[0].current_version_id!==input.workflowVersionId) throw new DomainError('WORKFLOW_VERSION_UNSUPPORTED','Configure triggers only for the current saved version.',409)
        const versions=await client.query<{record:unknown}>('select record from workflow_versions where workspace_id=$1 and workflow_id=$2 and id=$3',[input.workspaceId,input.workflowId,input.workflowVersionId])
        const version=WorkflowVersionSchema.parse(versions.rows[0]?.record)
        if (version.definition.executionCondition.kind!==input.trigger.kind) throw new DomainError('TRIGGER_CONDITION_MISMATCH','Save the matching workflow execution condition before configuring its trigger.',409)
        const location=await client.query<{location_revision:string;execution_location:unknown}>('select location_revision,execution_location from workspaces where id=$1',[input.workspaceId])
        if (input.enabled && (!location.rows[0]?.execution_location || Number(location.rows[0].location_revision)!==input.expectedLocationRevision)) {
          throw new DomainError('LOCATION_REVISION_CONFLICT','The trigger must pin the current configured workspace location.',409)
        }
        const rows=await client.query<TriggerRow>('select * from workflow_triggers where workflow_id=$1 for update',[input.workflowId])
        if (Number(rows.rows[0]?.revision ?? 0)!==input.expectedRevision) throw new DomainError('REVISION_CONFLICT','The workflow trigger changed.',409)
        const revision=input.expectedRevision+1
        const nextFireAt=input.enabled && input.trigger.kind==='schedule' ? new Date(firstScheduleAt(input.trigger,Date.now())).toISOString():null
        const value=WorkflowTriggerRecordSchema.parse({workspaceId:input.workspaceId,workflowId:input.workflowId,revision,
          workflowVersionId:input.workflowVersionId,locationRevision:input.expectedLocationRevision,trigger:input.trigger,
          enabled:input.enabled,nextFireAt,lastError:null})
        await client.query(`insert into workflow_triggers(workspace_id,workflow_id,revision,principal_id,record,enabled,next_fire_at)
          values($1,$2,$3,$4,$5::jsonb,$6,$7) on conflict(workflow_id) do update set revision=excluded.revision,
          principal_id=excluded.principal_id,record=excluded.record,enabled=excluded.enabled,next_fire_at=excluded.next_fire_at,last_error=null`,
          [input.workspaceId,input.workflowId,revision,principal.id,JSON.stringify(value),input.enabled,nextFireAt])
        // An in-flight admission holds the same workspace lock. It either won
        // before this change or must observe the changed revision before launch.
        await client.query(`update workflow_trigger_jobs j set status='blocked',error_code='TRIGGER_CHANGED',lease_owner=null,lease_expires_at=null
          where workflow_id=$1 and status in ('queued','leased') and not exists (
            select 1 from management_command_receipts r where r.principal_id=j.principal_id
              and r.operation='run.start' and r.command_id='trigger-job:' || j.id
          )`,[input.workflowId])
        return value
      }})
  }
  disable(principal:ManagementPrincipal,input:{workspaceId:string;workflowId:string;commandId:string;expectedRevision:number}) {
    requireAuthorization(principal,'workflow_triggers:update',{workspaceId:input.workspaceId,workflowId:input.workflowId})
    return this.commands.execute({principal,source:'mcp',operation:'workflow.trigger.disable',commandId:input.commandId,
      targetKey:`workflow:${input.workflowId}:trigger`,payload:input,perform:async(client)=>{
        await client.query('select pg_advisory_xact_lock(hashtext($1))',[`admission:workspace:${input.workspaceId}`])
        const rows=await client.query<TriggerRow>('select * from workflow_triggers where workspace_id=$1 and workflow_id=$2 for update',[input.workspaceId,input.workflowId])
        const row=rows.rows[0]
        if (!row) throw new DomainError('TRIGGER_NOT_FOUND','The trigger was not found.',404)
        if (Number(row.revision)!==input.expectedRevision) throw new DomainError('REVISION_CONFLICT','The trigger changed.',409)
        const updated=await client.query<TriggerRow>('update workflow_triggers set enabled=false,next_fire_at=null,revision=revision+1 where workflow_id=$1 returning *',[input.workflowId])
        await client.query(`update workflow_trigger_jobs j set status='blocked',error_code='TRIGGER_DISABLED',lease_owner=null,lease_expires_at=null
          where workflow_id=$1 and status in ('queued','leased') and not exists (
            select 1 from management_command_receipts r where r.principal_id=j.principal_id
              and r.operation='run.start' and r.command_id='trigger-job:' || j.id
          )`,[input.workflowId])
        return projection(updated.rows[0]!)
      }})
  }
  fire(principal:ManagementPrincipal,input:{workspaceId:string;workflowId:string;commandId:string;expectedRevision:number;eventType?:string|undefined;input:Record<string,unknown>}) {
    const scope={workspaceId:input.workspaceId,workflowId:input.workflowId}
    requireAuthorization(principal,'workflow_triggers:fire',scope)
    requireAuthorization(principal,'runs:start',scope)
    requireAuthorization(principal,'workspace_locations:read',{workspaceId:input.workspaceId})
    return this.commands.execute({principal,source:'mcp',operation:'workflow.trigger.fire',commandId:input.commandId,
      targetKey:`workflow:${input.workflowId}:trigger`,payload:input,perform:async(client)=>{
        await lockActiveWorkspace(client,input.workspaceId)
        const rows=await client.query<TriggerRow>('select * from workflow_triggers where workspace_id=$1 and workflow_id=$2 for share',[input.workspaceId,input.workflowId])
        const row=rows.rows[0]
        if (!row || !row.enabled || Number(row.revision)!==input.expectedRevision) throw new DomainError('TRIGGER_CHANGED','The trigger is disabled or changed.',409)
        const record=projection(row)
        if (record.trigger.kind==='on_event' ? input.eventType!==record.trigger.eventType
          : record.trigger.kind!=='on_message' || input.eventType!==undefined || typeof input.input.message!=='string' || !input.input.message.trim()) {
          throw new DomainError('TRIGGER_EVENT_MISMATCH','Supply the accepted event type or a nonempty message for an on_message trigger.',400)
        }
        const id=jobId([principal.id,input.workflowId,input.commandId])
        const payload=TriggerJobPayloadSchema.parse({mode:'event',workflowVersionId:record.workflowVersionId,expectedLocationRevision:record.locationRevision,input:input.input})
        await client.query('insert into workflow_trigger_jobs(id,workspace_id,workflow_id,principal_id,trigger_revision,payload) values($1,$2,$3,$4,$5,$6::jsonb)',
          [id,input.workspaceId,input.workflowId,principal.id,record.revision,JSON.stringify(payload)])
        return {jobId:id,status:'queued' as const}
      }})
  }
  async jobs(principal:ManagementPrincipal,input:{workspaceId:string;workflowId:string;cursor?:string|undefined;limit:number}) {
    requireAuthorization(principal,'workflow_triggers:read',{workspaceId:input.workspaceId,workflowId:input.workflowId})
    const rows=await this.pool.query<{id:string;status:'queued'|'leased'|'started'|'blocked';run_id:string|null;error_code:string|null}>(
      'select id,status,run_id,error_code from workflow_trigger_jobs where workspace_id=$1 and workflow_id=$2 and ($3::text is null or id>$3) order by id limit $4',
      [input.workspaceId,input.workflowId,input.cursor ?? null,input.limit+1],
    )
    const items=rows.rows.slice(0,input.limit).map((row)=>({jobId:row.id,status:row.status,runId:row.run_id,errorCode:row.error_code}))
    return {items,pageInfo:{nextCursor:rows.rows.length>input.limit ? items.at(-1)!.jobId:null}}
  }

  private closing = false

  shutdown(): Promise<void> {
    this.closing = true
    return this.running ?? Promise.resolve()
  }

  tick(report:(error:unknown)=>void):Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.running) return this.running
    const work=(async()=>{
      await this.reserveSchedules()
      for(let index=0;index<10 && !this.closing;index+=1) {
        const owner=randomUUID()
        const rows=await this.pool.query<JobRow>(`with candidate as (
          select id from workflow_trigger_jobs where (status='queued' and available_at<=now())
            or (status='leased' and lease_expires_at<=now()) order by available_at,created_at,id limit 1 for update skip locked)
          update workflow_trigger_jobs j set status='leased',lease_owner=$1,lease_expires_at=now()+interval '2 minutes',attempts=attempts+1
          from candidate where j.id=candidate.id returning j.*`,[owner])
        if (!rows.rows[0]) return
        await this.dispatch(rows.rows[0]).catch(report)
      }
    })().finally(()=>{this.running=undefined})
    this.running=work
    return work
  }
  private async reserveSchedules():Promise<void> {
    const client=await this.pool.connect()
    try {
      await client.query('begin')
      const rows=await client.query<TriggerRow>('select * from workflow_triggers where enabled and next_fire_at<=now() order by next_fire_at,workflow_id limit 25 for update skip locked')
      const now=Date.now()
      for(const row of rows.rows) {
        const record=projection(row)
        if (record.trigger.kind!=='schedule' || !row.next_fire_at) continue
        const timing=dueSchedule(record.trigger,row.next_fire_at.getTime(),now)
        if (timing.fireAt!==null) {
          const id=jobId([row.workflow_id,row.revision,new Date(timing.fireAt).toISOString()])
          const payload=TriggerJobPayloadSchema.parse({mode:'schedule',workflowVersionId:record.workflowVersionId,
            expectedLocationRevision:record.locationRevision,input:record.trigger.input})
          await client.query(`insert into workflow_trigger_jobs(id,workspace_id,workflow_id,principal_id,trigger_revision,payload)
            values($1,$2,$3,$4,$5,$6::jsonb) on conflict(id) do nothing`,
            [id,row.workspace_id,row.workflow_id,row.principal_id,record.revision,JSON.stringify(payload)])
        }
        await client.query('update workflow_triggers set next_fire_at=$2 where workflow_id=$1',[row.workflow_id,new Date(timing.nextAt)])
      }
      await client.query('commit')
    } catch(error) {await client.query('rollback');throw error} finally {client.release()}
  }
  private async dispatch(job:JobRow):Promise<void> {
    if (this.closing) return // Leave the lease for restart recovery; never launch new work during shutdown.
    const commandId=`trigger-job:${job.id}`
    let acceptedRunId: string | undefined
    try {
      // Repair acknowledgement after an already-committed launch, without
      // requiring a now-expired credential or launching another Run.
      const payload=TriggerJobPayloadSchema.parse(job.payload)
      const acceptedInput={workspaceId:job.workspace_id,workflowId:job.workflow_id,workflowVersionId:payload.workflowVersionId,
        expectedLocationRevision:payload.expectedLocationRevision,input:payload.input,commandId,triggerJobId:job.id}
      const receipts=await this.pool.query<{result:unknown;input_hash:string;target_key:string}>(
        "select result,input_hash,target_key from management_command_receipts where principal_id=$1 and operation='run.start' and command_id=$2",[job.principal_id,commandId])
      let runId:string
      if (receipts.rows[0]) {
        if (receipts.rows[0].input_hash!==commandInputHash(acceptedInput)
          || receipts.rows[0].target_key!==`workflow:${job.workflow_id}:version:${payload.workflowVersionId}`) {
          throw new DomainError('TRIGGER_RECEIPT_MISMATCH','A different command already occupies this trigger job identity.',409)
        }
        const run=WorkflowRunSchema.parse(receipts.rows[0].result)
        if (run.workspaceId!==job.workspace_id || run.workflowId!==job.workflow_id) throw new DomainError('TRIGGER_RECEIPT_MISMATCH','The launch receipt has a different scope.',409)
        runId=run.id
      } else {
        const principal=await readTriggerAuthority(this.pool,job.principal_id,{workspaceId:job.workspace_id,workflowId:job.workflow_id},payload.mode)
        if (this.closing) return
        const result=await this.runs.start(principal,'mcp',acceptedInput)
        runId=result.run.id
      }
      acceptedRunId = runId
      await this.pool.query("update workflow_trigger_jobs set status='started',run_id=$3,error_code=null,lease_owner=null,lease_expires_at=null where id=$1 and lease_owner=$2",[job.id,job.lease_owner,runId])
    } catch(error) {
      // Acknowledgement failure never changes accepted work into a blocked job.
      // Leave its lease for receipt-based recovery without launching another Run.
      if (acceptedRunId) throw error
      const permanent=error instanceof DomainError
      const code=error instanceof DomainError ? error.code:permanent?'TRIGGER_DISPATCH_FAILED':'TRIGGER_DISPATCH_RETRYING'
      await this.pool.query(`update workflow_trigger_jobs set status=$3,error_code=$4,lease_owner=null,lease_expires_at=null,
        available_at=now()+($5::integer * interval '1 second') where id=$1 and lease_owner=$2`,
        [job.id,job.lease_owner,permanent?'blocked':'queued',code,Math.min(900,60*2**Math.min(job.attempts-1,4))])
      if (permanent) {
        // Failed schedule admission requires explicit re-enablement; revoked
        // credentials do not become an unattended future authority grant.
        const scheduled=TriggerJobPayloadSchema.safeParse(job.payload)
        if (scheduled.success && scheduled.data.mode==='schedule') {
          await this.pool.query('update workflow_triggers set enabled=false,next_fire_at=null,last_error=$3,revision=revision+1 where workflow_id=$1 and revision=$2 and principal_id=$4',
            [job.workflow_id,job.trigger_revision,code,job.principal_id])
        }
        await this.commands.recordAudit(job.principal_id,'mcp','workflow.trigger.dispatch',`workflow:${job.workflow_id}`,'failed',{jobId:job.id,code})
      }
    }
  }
}
