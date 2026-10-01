import type { RunInput } from '@graphql/contracts'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { JobArtifactSchema, AcceptedJobSpecSchema, JobDefinitionSaveSchema, JobDefinitionSchema, JobDefinitionSpecSchema, JobExecutionSchema, JobLogPageSchema,
  JobStartSchema, type JobDefinition, type JobDefinitionSave, type JobDefinitionSpec, type JobExecution, type JobStart } from '@graphql/contracts/jobs'
import type { ManagementAction, ManagementPrincipal } from '@graphql/contracts/management'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { canonical, JobRepository, type JobSql } from './repository.js'
import type { JobArtifactPort, JobDispatchPort, JobPreparationPort } from './ports.js'

export const jobDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError('INVALID_REQUEST','The request does not match the job contract.',400)
  return result.data
}
export class JobService {
  readonly repository = new JobRepository()
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly ports: { preparation: JobPreparationPort; dispatch: JobDispatchPort; artifacts: JobArtifactPort },
    private readonly clock: () => Date = () => new Date()) {}
  private async authorize(sql: pg.PoolClient, principal: ManagementPrincipal, workspaceId: string, action: ManagementAction) {
    const live = await readLiveManagementPrincipal(sql,principal.id)
    requireAuthorization(live,action,{workspaceId})
    return live
  }
  private async read<T>(principal: ManagementPrincipal, workspaceId: string, action: ManagementAction, work:(sql: pg.PoolClient, live: ManagementPrincipal)=>Promise<T>):Promise<T> {
    try { requireAuthorization(principal,action,{workspaceId}) } catch(error) {
      await this.commands.recordDenied(principal.id,'http',action,workspaceId); throw error
    }
    const sql = await this.pool.connect()
    let releaseError: Error | undefined
    try {
      await sql.query('begin')
      const live = await this.authorize(sql,principal,workspaceId,action)
      const result = await work(sql,live)
      await this.authorize(sql,principal,workspaceId,action)
      await sql.query('commit'); return result
    } catch(error) {
      await sql.query('rollback').catch((failure:unknown) => { releaseError = failure instanceof Error ? failure : new Error('Job rollback failed.') })
      throw error
    } finally { sql.release(releaseError) }
  }
  private async command<T>(principal:ManagementPrincipal, source:'http'|'mcp', workspaceId:string, action:ManagementAction,
    commandId:string, operation:string, payload:unknown, perform:(sql:pg.PoolClient,live:ManagementPrincipal)=>Promise<T>):Promise<T> {
    try { requireAuthorization(principal,action,{workspaceId}) } catch(error) {
      await this.commands.recordDenied(principal.id,source,operation,workspaceId); throw error
    }
    let live = principal
    return (await this.commands.execute({principal,source,commandId,operation,targetKey:workspaceId,payload,
      authorize:async sql => { live = await this.authorize(sql,principal,workspaceId,action) },
      perform:async sql => { await lockActiveWorkspace(sql,workspaceId); const value=await perform(sql,live); await this.authorize(sql,principal,workspaceId,action); return value },
    })).value
  }
  choices(principal:ManagementPrincipal,workspaceId:string) {
    return this.read(principal,workspaceId,'job_definitions:read',(sql,live)=>this.ports.preparation.choices(sql,live,workspaceId))
  }
  readArtifact(principal:ManagementPrincipal,workspaceId:string,id:string,fileId:string,revisionId:string,source:'http'|'mcp'='http') {
    return this.read(principal,workspaceId,'job_artifacts:read',async(sql,live)=>{
      await this.repository.execution(sql,workspaceId,id)
      const result=await this.ports.artifacts.read(sql,live,workspaceId,id,fileId,revisionId,source)
      const artifact=JobArtifactSchema.parse(result.artifact)
      if(artifact.executionId!==id||artifact.fileId!==fileId||artifact.revisionId!==revisionId||artifact.state!=='available'
        ||result.bytes.length!==artifact.byteSize||createHash('sha256').update(result.bytes).digest('hex')!==artifact.sha256) {
        throw new DomainError('JOB_ARTIFACT_INVALID','The exact artifact bytes are missing, expired or corrupt.',409)
      }
      return {artifact,bytes:result.bytes}
    })
  }
  listDefinitions(principal:ManagementPrincipal, workspaceId:string) {
    return this.read(principal,workspaceId,'job_definitions:read',async sql => (await sql.query<{record:unknown}>('select record from job_definitions where workspace_id=$1 order by id limit 100',[workspaceId])).rows.map(row=>JobDefinitionSchema.parse(row.record)))
  }
  getDefinition(principal:ManagementPrincipal,workspaceId:string,id:string) {
    return this.read(principal,workspaceId,'job_definitions:read',sql=>this.repository.definition(sql,workspaceId,id))
  }
  async saveDefinition(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:JobDefinitionSave) {
    const input = parse(JobDefinitionSaveSchema,raw)
    return this.command(principal,source,workspaceId,'job_definitions:write',input.commandId,'job.definition.save',input,async(sql,live)=>{
      const old = input.id ? await this.repository.definition(sql,workspaceId,input.id,true) : null
      if ((old?.revision ?? null) !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT','The job definition changed since it was read.',409)
      const checked = await this.ports.preparation.validate(sql,live,workspaceId,input.spec)
      if (!checked.valid) throw new DomainError('JOB_NOT_READY','Job source, target or isolation is not authorized and ready.',409,{reasons:checked.reasons})
      const now=this.clock().toISOString()
      const value:JobDefinition=JobDefinitionSchema.parse({schemaVersion:1,id:old?.id??randomUUID(),workspaceId,name:input.name,revision:(old?.revision??0)+1,versionId:randomUUID(),spec:input.spec,createdAt:old?.createdAt??now,updatedAt:now})
      await sql.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by) values($1,$2,$3,$4,$5::jsonb,$6)
        on conflict(id) do update set revision=excluded.revision,version_id=excluded.version_id,record=excluded.record,updated_by=excluded.updated_by`,[value.id,workspaceId,value.revision,value.versionId,JSON.stringify(value),live.id])
      await sql.query('insert into job_definition_versions(id,definition_id,workspace_id,revision,record) values($1,$2,$3,$4,$5::jsonb)',[value.versionId,value.id,workspaceId,value.revision,JSON.stringify(value)])
      return value
    })
  }
  validate(principal:ManagementPrincipal,workspaceId:string,raw:JobDefinitionSpec) {
    const spec=parse(JobDefinitionSpecSchema,raw)
    return this.read(principal,workspaceId,'job_definitions:read',(sql,live)=>this.ports.preparation.validate(sql,live,workspaceId,spec))
  }
  async start(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:JobStart) {
    const input=parse(JobStartSchema,raw)
    const execution=await this.command(principal,source,workspaceId,'jobs:start',input.commandId,'job.start',input,async(sql,live)=>{
      const definition=await this.repository.definition(sql,workspaceId,input.definitionId,true)
      if(definition.revision!==input.expectedRevision) throw new DomainError('REVISION_CONFLICT','The job definition changed since it was read.',409)
      return this.admit(sql,live,definition,null)
    })
    await this.ports.dispatch.wake(execution.id).catch(()=>undefined)
    return this.read(principal,workspaceId,'jobs:start',sql=>this.repository.execution(sql,workspaceId,execution.id))
  }
  /** Workflow adapter calls inside its own accepted-node transaction; no Operator token enters a build. */
  async admit(sql:JobSql,principal:ManagementPrincipal,definition:JobDefinition,workflow:JobExecution['workflow'],workflowInput:RunInput|null=null):Promise<JobExecution> {
    if((workflow===null)!==(workflowInput===null))throw new DomainError('JOB_INPUT_BINDING_MISSING','A workflow job requires its exact accepted input snapshot.',409)
    const id=workflow?.nodeExecutionId??randomUUID(),attemptId=randomUUID()
    const spec=await this.ports.preparation.accept(sql,principal,definition.workspaceId,definition.spec,{executionId:id,attemptId})
    const request=definition.spec
    const {materializationId:_materialization,materializationDigest:_digest,...source}=spec.source
    const selection=(target:JobDefinitionSpec['target'])=>({mainId:target.mainId,hostRef:target.hostRef,registration:target.registration,mainInstallationId:target.mainInstallationId,
      rootPolicyId:target.destination.rootPolicyId,rootPolicyRevision:target.destination.rootPolicyRevision,locationRevision:target.destination.locationRevision})
    if(canonical(source)!==canonical(request.source)||canonical(selection(spec.target))!==canonical(selection(request.target))
      ||canonical({argv:spec.argv,inputs:spec.inputs,policy:spec.policy,outputs:spec.outputs,relativeCwd:spec.relativeCwd??null})!==canonical({argv:request.argv,inputs:request.inputs,policy:request.policy,outputs:request.outputs,relativeCwd:request.relativeCwd??null})) {
      throw new DomainError('JOB_ACCEPTANCE_PIN_CONFLICT','Preparation cannot change the saved source selection, command, policy or target authority.',409)
    }
    const acceptedSpec=AcceptedJobSpecSchema.parse({...spec,workflowInput,definitionId:definition.id,definitionRevision:definition.revision,definitionVersionId:definition.versionId,
      scriptDigest:jobDigest(spec.argv),outputSpecDigest:jobDigest(spec.outputs),specDigest:jobDigest({...spec,workflowInput}),bindingHash:jobDigest({target:spec.target,source:spec.source})})
    const now=this.clock().toISOString()
    const binding=await this.ports.dispatch.accept(sql,{workspaceId:definition.workspaceId,executionId:id,attemptId,spec:acceptedSpec,workflow,principal})
    const execution=JobExecutionSchema.parse({schemaVersion:1,id,workspaceId:definition.workspaceId,acceptedSpec,...binding,workflow,
      process:{phase:'queued',outcome:null,exitCode:null,signal:null,processStopped:false},transport:'unknown',publication:'pending',
      startedAt:null,finishedAt:null,lastSeenAt:null,resultIssue:null,cancelRequestedAt:null,createdAt:now,updatedAt:now})
    await sql.query('insert into job_executions(id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',[id,definition.workspaceId,definition.versionId,execution.operationId,execution.attemptId,JSON.stringify(execution),JSON.stringify(acceptedSpec),principal.id])
    return execution
  }
  getExecution(principal:ManagementPrincipal,workspaceId:string,id:string) {
    return this.read(principal,workspaceId,'jobs:read',sql=>this.repository.execution(sql,workspaceId,id))
  }
  listExecutions(principal:ManagementPrincipal,workspaceId:string) {
    return this.read(principal,workspaceId,'jobs:read',async sql=>(await sql.query<{record:unknown}>('select record from job_executions where workspace_id=$1 order by id desc limit 100',[workspaceId])).rows.map(row=>JobExecutionSchema.parse(row.record)))
  }
  async cancel(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,id:string,commandId:string) {
    parse(z.string().min(1),commandId)
    await this.command(principal,source,workspaceId,'jobs:cancel',commandId,'job.cancel',{id},async(sql,live)=>{
      const execution=await this.repository.execution(sql,workspaceId,id,true)
      if(execution.process.phase!=='terminal') {
        await this.ports.dispatch.cancel(sql,execution,commandId,live)
        execution.cancelRequestedAt??=this.clock().toISOString(); execution.updatedAt=this.clock().toISOString()
        await this.repository.putExecution(sql,execution)
      }
      return {executionId:id}
    })
    await this.ports.dispatch.wake(id).catch(()=>undefined)
    return this.read(principal,workspaceId,'jobs:cancel',sql=>this.repository.execution(sql,workspaceId,id))
  }
  readLogs(principal:ManagementPrincipal,workspaceId:string,id:string,afterSequence:number,limit:number) {
    parse(z.number().int().nonnegative(),afterSequence); parse(z.number().int().min(1).max(100),limit)
    return this.read(principal,workspaceId,'job_logs:read',async sql=>{
      await this.repository.execution(sql,workspaceId,id)
      const chunks=await this.repository.logs(sql,id,afterSequence,limit)
      const row=(await sql.query<{log_truncated:boolean}>('select log_truncated from job_executions where id=$1',[id])).rows[0]!
      return JobLogPageSchema.parse({chunks,nextCursor:chunks.at(-1)?.sequence??afterSequence,truncated:row.log_truncated,gap:null})
    })
  }
  listArtifacts(principal:ManagementPrincipal,workspaceId:string,id:string) {
    return this.read(principal,workspaceId,'job_artifacts:read',async(sql,live)=>{
      await this.repository.execution(sql,workspaceId,id)
      return this.ports.artifacts.list(sql,live,workspaceId,id)
    })
  }
}
