import { SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { JobRuntimeApprovalSchema, JobRuntimeFingerprintSchema, JobRuntimeMeasurementSchema, JobRuntimeNativeAdmissionSchema, JobRuntimeProfileInputSchema, JobRuntimeProfileSchema, JobRuntimeProfileSaveSchema,
  JobRuntimeQualificationRequestSchema, type JobRuntimeProfile, type JobRuntimeProfileSave, type JobRuntimeApproval } from '@graphql/contracts/job-runtime'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { SourceRootRecord } from '@graphql/contracts/source-admission'
import type { ResolvedJobDefinitionSpec } from '@graphql/contracts/jobs'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { DomainError } from '../errors.js'
import { canonical, type JobSql } from './repository.js'
import { jobDigest } from './service.js'
import type { JobRuntimeInventory } from './sourcePreparation.js'
import { PostgresJobRuntimeHumanAuthority } from './runtimeHumanAuthority.js'
import type { JobRuntimeHumanAuthority, JobRuntimeQualificationProducer, JobRuntimeQualificationResult } from './runtimeProfilePorts.js'

/** Main CI policy metadata; machine/root identity continues to come from W07/W09/W12. */
export class JobRuntimeProfiles implements JobRuntimeInventory {
  constructor(private readonly pool:pg.Pool,private readonly commands:PostgresCommandCoordinator,private readonly sources:PostgresSourceService,
    private readonly producer:JobRuntimeQualificationProducer,private readonly human:JobRuntimeHumanAuthority=new PostgresJobRuntimeHumanAuthority(),
    private readonly changed?: () => void) {}
  private async transaction<T>(work:(sql:pg.PoolClient)=>Promise<T>) {
    const sql=await this.pool.connect()
    try {await sql.query('begin');const value=await work(sql);await sql.query('commit');return value}
    catch(error){await sql.query('rollback');throw error}finally{sql.release()}
  }
  private async authorize(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,write=false) {
    requireAuthorization(principal,write?'job_definitions:write':'job_definitions:read',{workspaceId})
    const live=await readLiveManagementPrincipal(sql,principal.id)
    requireAuthorization(live,write?'job_definitions:write':'job_definitions:read',{workspaceId})
    if(write)await lockActiveWorkspace(sql,workspaceId)
    return live
  }
  async record(sql:JobSql,workspaceId:string,id:string,lock=false) {
    const row=(await sql.query<{record:unknown}>(`select record from job_runtime_profiles where workspace_id=$1 and id=$2${lock?' for update':' for share'}`,[workspaceId,id])).rows[0]
    if(!row)throw new DomainError('JOB_RUNTIME_PROFILE_NOT_FOUND','The exact workspace CI runtime profile is missing.',404)
    const profile=JobRuntimeProfileSchema.parse(row.record)
    if(profile.id!==id||profile.workspaceId!==workspaceId)throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT','The stored profile scope differs from its identifier.',409)
    return profile
  }
  async list(principal:ManagementPrincipal,workspaceId:string) {
    return this.transaction(async sql=>{
      await this.authorize(sql,principal,workspaceId)
      const rows=await sql.query<{record:unknown}>('select record from job_runtime_profiles where workspace_id=$1 order by id limit 100',[workspaceId])
      const profiles=await Promise.all(rows.rows.map(async row=>{
        const profile=JobRuntimeProfileSchema.parse(row.record)
        const readiness=profile.status==='qualified'&&profile.measurement&&Date.parse(profile.measurement.expiresAt)>Date.now()?await this.producer.revalidate(sql,profile):{ready:false,reasons:[`RUNTIME_${profile.status.toUpperCase().replaceAll('-','_')}`]}
        return {profile,...readiness,sideEffects:false as const}
      }))
      const approvals=(await sql.query<{record:unknown}>(`select record from job_runtime_qualification_approvals where workspace_id=$1 and record->>'status' in ('awaiting-approval','approved') order by id limit 100`,[workspaceId])).rows.map(row=>JobRuntimeApprovalSchema.parse(row.record))
      await this.authorize(sql,principal,workspaceId);return {profiles,approvals}
    })
  }
  async save(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:JobRuntimeProfileSave) {
    const input=JobRuntimeProfileSaveSchema.parse(raw)
    requireAuthorization(principal,'job_definitions:write',{workspaceId})
    const result = await this.commands.execute({principal,source,operation:'job.runtime-profile.save',commandId:input.commandId,targetKey:workspaceId,payload:input,
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),perform:async sql=>{
        await lockActiveWorkspace(sql,workspaceId)
        const old=input.id?await this.record(sql,workspaceId,input.id,true):null
        if((old?.revision??null)!==input.expectedRevision)throw new DomainError('REVISION_CONFLICT','The runtime profile changed since it was read.',409)
        const rootRow=(await sql.query<{record:unknown}>('select record from source_root_bindings where workspace_id=$1 and root_id=$2 and binding_revision=$3 for share',[workspaceId,input.spec.rootId,input.spec.bindingRevision])).rows[0]
        if(!rootRow)throw new DomainError('SOURCE_ROOT_NOT_FOUND','The exact existing root binding is missing.',404)
        const rootRecord=SourceRootRecordSchema.parse(rootRow.record)
        const root=await this.sources.resolveRootBinding(sql,principal,{workspaceId,rootId:input.spec.rootId,bindingRevision:input.spec.bindingRevision,source:rootRecord.source})
        if(root.binding.accessMode!=='exclusive-write')throw new DomainError('SOURCE_READ_ONLY','CI requires an approved exclusive source namespace.',403)
        const id=old?.id??randomUUID(),revision=(old?.revision??0)+1,policy={...input.spec.policy,isolationPolicyId:id,isolationPolicyRevision:revision}
        const now=new Date().toISOString(),specDigest=jobDigest({workspaceId,id,revision,root,policy,limits:input.spec.limits})
        const profile=JobRuntimeProfileSchema.parse({schemaVersion:1,id,workspaceId,revision,name:input.name,root,policy,limits:input.spec.limits,specDigest,status:'unqualified',measurement:null,createdAt:old?.createdAt??now,updatedAt:now})
        await sql.query('insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(id) do update set revision=excluded.revision,root_id=excluded.root_id,binding_revision=excluded.binding_revision,record=excluded.record',[id,workspaceId,revision,root.binding.rootId,root.binding.bindingRevision,JSON.stringify(profile)])
        await sql.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,$2,$3::jsonb)',[id,revision,JSON.stringify(profile)])
        return profile
      }})
    this.changed?.()
    return result.value
  }
  async requestQualification(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:unknown) {
    const input=JobRuntimeQualificationRequestSchema.parse(raw)
    requireAuthorization(principal,'job_definitions:write',{workspaceId})
    let captured:{profile:JobRuntimeProfile;fingerprint:ReturnType<typeof JobRuntimeFingerprintSchema.parse>}|undefined
    const result = await this.commands.execute({principal,source,operation:'job.runtime-profile.request',commandId:input.commandId,targetKey:workspaceId,payload:input,dedicatedConnection:true,
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),
      prepare:async()=>{
        const profile=await this.transaction(async sql=>{await this.authorize(sql,principal,workspaceId,true);return this.record(sql,workspaceId,input.profileId)})
        if(profile.revision!==input.expectedRevision)throw new DomainError('REVISION_CONFLICT','The runtime profile changed.',409)
        const {isolationPolicyId,isolationPolicyRevision,...policy}=profile.policy
        JobRuntimeProfileInputSchema.parse({rootId:profile.root.binding.rootId,bindingRevision:profile.root.binding.bindingRevision,limits:profile.limits,policy})
        if(isolationPolicyId!==profile.id||isolationPolicyRevision!==profile.revision)throw new DomainError('JOB_RUNTIME_PROFILE_SCOPE_CONFLICT','The policy differs from its exact profile revision.',409)
        const fingerprint=JobRuntimeFingerprintSchema.parse(await this.producer.capture(profile))
        if(fingerprint.profileId!==profile.id||fingerprint.profileRevision!==profile.revision||fingerprint.specDigest!==profile.specDigest||canonical(fingerprint.root)!==canonical(profile.root)||canonical(fingerprint.hostRef)!==canonical(profile.root.selection.hostRef)||canonical(fingerprint.registration)!==canonical(profile.root.registration)||canonical(fingerprint.limits)!==canonical(profile.limits))throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Installed metadata does not match this profile revision.',409)
        captured={profile,fingerprint}
      },perform:async sql=>{
        if(!captured)throw new DomainError('JOB_RUNTIME_FINGERPRINT_MISSING','The actual installed candidate metadata is missing.',409)
        const profile=await this.record(sql,workspaceId,input.profileId,true)
        if(profile.specDigest!==captured.profile.specDigest)throw new DomainError('REVISION_CONFLICT','The runtime profile changed during candidate capture.',409)
        const approval=JobRuntimeApprovalSchema.parse({schemaVersion:1,id:randomUUID(),qualificationId:randomUUID(),workspaceId,profileId:profile.id,profileRevision:profile.revision,fingerprint:captured.fingerprint,fingerprintDigest:jobDigest(captured.fingerprint),requestedByPrincipalId:principal.id,status:'awaiting-approval',approvedByPrincipalId:null,approvedAt:null,expiresAt:new Date(Date.now()+3600000).toISOString()})
        await sql.query('insert into job_runtime_qualification_approvals(id,qualification_id,profile_id,profile_revision,workspace_id,record,requested_by) values($1,$2,$3,$4,$5,$6::jsonb,$7)',[approval.id,approval.qualificationId,profile.id,profile.revision,workspaceId,JSON.stringify(approval),principal.id])
        await this.put(sql,{...profile,status:'awaiting-approval',updatedAt:new Date().toISOString()});return approval
      }})
    this.changed?.()
    return result.value
  }
  async approve(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,commandId:string,approvalId:string) {
    if(source!=='http')throw new DomainError('JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED','Physical runtime qualification approval is a human-only action; MCP can request and read it.',403)
    requireAuthorization(principal,'job_definitions:write',{workspaceId})
    const result = await this.commands.execute({principal,source,operation:'job.runtime-profile.approve',commandId,targetKey:workspaceId,payload:{approvalId},
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),perform:async sql=>{
        const live=await this.authorize(sql,principal,workspaceId,true),approval=await this.approval(sql,workspaceId,approvalId,true)
        const profile=await this.record(sql,workspaceId,approval.profileId,true)
        if(approval.status!=='awaiting-approval'||profile.revision!==approval.profileRevision||profile.specDigest!==approval.fingerprint.specDigest||Date.parse(approval.expiresAt)<=Date.now())throw new DomainError('JOB_RUNTIME_APPROVAL_EXPIRED','Approve a new exact installed fingerprint.',409)
        const approved={...approval,status:'approved' as const,approvedByPrincipalId:live.id,approvedAt:new Date().toISOString()}
        await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb,approved_by=$3 where id=$1',[approvalId,JSON.stringify(approved),live.id]);return approved
      }})
    this.changed?.()
    return result.value
  }
  async qualify(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,commandId:string,approvalId:string) {
    let measurement:ReturnType<typeof JobRuntimeMeasurementSchema.parse>|undefined
    let result:JobRuntimeQualificationResult|undefined
    let claimed=false
    try {
      const outcome = await this.commands.execute({principal,source,operation:'job.runtime-profile.qualify',commandId,targetKey:workspaceId,payload:{approvalId},dedicatedConnection:true,
      authorize:sql=>this.authorize(sql,principal,workspaceId,true).then(()=>undefined),prepare:async()=>{
        const approval=await this.transaction(async sql=>{
          await this.authorize(sql,principal,workspaceId,true)
          const value=await this.approval(sql,workspaceId,approvalId,true),profile=await this.record(sql,workspaceId,value.profileId,true)
          if(!['approved','qualifying','failed','recovery-required'].includes(value.status)||!value.approvedByPrincipalId||!value.approvedAt||Date.parse(value.expiresAt)<=Date.now()||profile.revision!==value.profileRevision||profile.specDigest!==value.fingerprint.specDigest)throw new DomainError('JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED','This physical qualification requires current human approval of its exact installed fingerprint.',409)
          await this.human.require(sql,await readLiveManagementPrincipal(sql,value.approvedByPrincipalId),value)
          const owner=(await sql.query<{run_command_id:string|null;run_principal_id:string|null;measurement:unknown;run_result:JobRuntimeQualificationResult|null}>('select run_command_id,run_principal_id,measurement,run_result from job_runtime_qualification_approvals where id=$1 for update',[approvalId])).rows[0]!
          if(owner.run_command_id&&(owner.run_command_id!==commandId||owner.run_principal_id!==principal.id))throw new DomainError('JOB_RUNTIME_QUALIFICATION_IN_PROGRESS','Reconcile the original approved qualification command.',409)
          if(owner.measurement)measurement=JobRuntimeMeasurementSchema.parse(owner.measurement)
          if(owner.run_result)result=owner.run_result
          if(owner.run_command_id&&!result&&!measurement)throw new DomainError('JOB_RUNTIME_RECOVERY_REQUIRED','The original physical qualification requires owner reconciliation before another probe.',409)
          await sql.query('update job_runtime_qualification_approvals set run_command_id=$2,run_principal_id=$3 where id=$1',[approvalId,commandId,principal.id])
          const next={...value,status:'qualifying' as const};await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',[approvalId,JSON.stringify(next)]);await this.put(sql,{...profile,status:'qualifying'});return next
        })
        claimed=true
        result??=await this.producer.run(approval,AbortSignal.timeout(240000))
        if(result.outcome==='qualified') {
          measurement=JobRuntimeMeasurementSchema.parse(result.measurement)
          if(measurement.approvalId!==approval.id||measurement.qualificationId!==approval.qualificationId||measurement.fingerprintDigest!==approval.fingerprintDigest||canonical(measurement.fingerprint)!==canonical(approval.fingerprint)||measurement.fingerprintDigest!==jobDigest(measurement.fingerprint)||canonical(measurement.root)!==canonical(approval.fingerprint.root)||canonical(measurement.hostRef)!==canonical(approval.fingerprint.hostRef)||canonical(measurement.registration)!==canonical(approval.fingerprint.registration)||measurement.runtime.imageDigest!==approval.fingerprint.imageDigest||measurement.runtime.toolchainDigest!==approval.fingerprint.toolchainDigest||measurement.runtimeBinarySha256!==approval.fingerprint.runtimeBinarySha256||measurement.ociBinarySha256!==approval.fingerprint.ociBinarySha256||measurement.runtimeExecutable!==approval.fingerprint.runtimeExecutable||Date.parse(measurement.expiresAt)>Date.parse(approval.expiresAt)||Date.parse(measurement.expiresAt)<=Date.now())throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Measured evidence changed the approved installed context or lifetime.',409)
          for(const [key,value] of Object.entries(approval.fingerprint.limits))if(measurement.runtime[key as keyof typeof approval.fingerprint.limits]!==value)throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Measured runtime limits differ from the approved profile.',409)
        }
        await this.transaction(async sql=>{await this.authorize(sql,principal,workspaceId,true);await sql.query('update job_runtime_qualification_approvals set measurement=$2::jsonb,run_result=$5::jsonb where id=$1 and run_command_id=$3 and run_principal_id=$4',[approvalId,measurement?JSON.stringify(measurement):null,commandId,principal.id,JSON.stringify(result)])})
      },perform:async sql=>{
        if(!result)throw new DomainError('JOB_RUNTIME_EVIDENCE_MISSING','Actual qualification result is missing.',409)
        const approval=await this.approval(sql,workspaceId,approvalId,true),profile=await this.record(sql,workspaceId,approval.profileId,true)
        if(result.outcome==='denied') {
          const status=result.closure==='unconfirmed'?'recovery-required' as const:'failed' as const
          const denied={...profile,status,measurement:null,updatedAt:new Date().toISOString()}
          if(profile.revision===approval.profileRevision&&profile.specDigest===approval.fingerprint.specDigest)await this.put(sql,denied)
          await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',[approvalId,JSON.stringify({...approval,status})]);return profile.revision===approval.profileRevision?denied:profile
        }
        if(!measurement)throw new DomainError('JOB_RUNTIME_EVIDENCE_MISSING','Actual measured evidence is missing.',409)
        if(approval.status!=='qualifying'||profile.revision!==measurement.profileRevision||profile.specDigest!==measurement.specDigest||Date.parse(approval.expiresAt)<=Date.now()||Date.parse(measurement.expiresAt)<=Date.now())throw new DomainError('JOB_RUNTIME_FINGERPRINT_CONFLICT','Qualification context changed before publication.',409)
        await this.human.require(sql,await readLiveManagementPrincipal(sql,approval.approvedByPrincipalId!),approval)
        const qualified={...profile,status:'qualified' as const,measurement,updatedAt:new Date().toISOString()}
        const current=await this.producer.revalidate(sql,qualified)
        if(!current.ready)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The actual approved host/root/runtime fingerprint changed.',409,{reasons:current.reasons})
        await this.put(sql,qualified);await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb,measurement=$3::jsonb where id=$1',[approvalId,JSON.stringify({...approval,status:'complete'}),JSON.stringify(measurement)]);return qualified
      }})
      this.changed?.()
      return outcome.value
    } catch(error) {
      if(claimed) {
        try {await this.transaction(async sql=>{
          await this.authorize(sql,principal,workspaceId,true)
          const approval=await this.approval(sql,workspaceId,approvalId,true)
          const owner=(await sql.query<{run_command_id:string|null;run_principal_id:string|null;measurement:unknown;run_result:JobRuntimeQualificationResult|null}>('select run_command_id,run_principal_id,measurement,run_result from job_runtime_qualification_approvals where id=$1 for update',[approvalId])).rows[0]!
          if(approval.status!=='qualifying'||owner.run_command_id!==commandId||owner.run_principal_id!==principal.id)return
          // A thrown producer cannot prove physical closure. Retain ownership and any original evidence; never launch a replacement.
          if(!owner.run_result&&!owner.measurement)await sql.query('update job_runtime_qualification_approvals set run_result=$2::jsonb where id=$1',[approvalId,JSON.stringify({outcome:'denied',closure:'unconfirmed',reasons:['JOB_RUNTIME_QUALIFICATION_FAILED']})])
          await sql.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',[approvalId,JSON.stringify({...approval,status:'recovery-required'})])
          const profile=await this.record(sql,workspaceId,approval.profileId,true)
          if(profile.status==='qualifying'&&profile.revision===approval.profileRevision&&profile.specDigest===approval.fingerprint.specDigest)await this.put(sql,{...profile,status:'recovery-required',measurement:null,updatedAt:new Date().toISOString()})
        })
        this.changed?.()
        } catch(settlementError) {throw new AggregateError([error,settlementError],'Qualification failed and its recovery state could not be persisted.',{cause:settlementError})}
      }
      throw error
    }
  }
  async getQualification(principal:ManagementPrincipal,workspaceId:string,id:string) {
    return this.transaction(async sql=>{
      await this.authorize(sql,principal,workspaceId)
      const approval=await this.approval(sql,workspaceId,id),profile=await this.record(sql,workspaceId,approval.profileId)
      const row=(await sql.query<{measurement:unknown;run_result:JobRuntimeQualificationResult|null;native_admission:unknown}>('select measurement,run_result,native_admission from job_runtime_qualification_approvals where id=$1',[id])).rows[0]!
      const measurement=row.measurement?JobRuntimeMeasurementSchema.parse(row.measurement):null
      const readiness=profile.status==='qualified'&&measurement&&Date.parse(measurement.expiresAt)>Date.now()?await this.producer.revalidate(sql,profile):{ready:false,reasons:row.run_result?.outcome==='denied'?row.run_result.reasons:[`RUNTIME_${profile.status.toUpperCase().replaceAll('-','_')}`]}
      await this.authorize(sql,principal,workspaceId)
      return {approval,measurement,nativeAdmission:row.native_admission?JobRuntimeNativeAdmissionSchema.parse(row.native_admission):null,profile,readiness:{...readiness,sideEffects:false as const}}
    })
  }
  private async approval(sql:JobSql,workspaceId:string,id:string,lock=false):Promise<JobRuntimeApproval> {
    const row=(await sql.query<{record:unknown}>(`select record from job_runtime_qualification_approvals where workspace_id=$1 and id=$2${lock?' for update':' for share'}`,[workspaceId,id])).rows[0]
    if(!row)throw new DomainError('JOB_RUNTIME_APPROVAL_NOT_FOUND','The exact workspace qualification approval is missing.',404)
    return JobRuntimeApprovalSchema.parse(row.record)
  }
  private async put(sql:JobSql,profile:JobRuntimeProfile) {await sql.query('update job_runtime_profiles set record=$3::jsonb where workspace_id=$1 and id=$2',[profile.workspaceId,profile.id,JSON.stringify(JobRuntimeProfileSchema.parse(profile))])}
  async choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string) {
    await this.authorize(sql,principal,workspaceId)
    const rows=await sql.query<{record:unknown}>('select record from job_runtime_profiles where workspace_id=$1 and record->>\'status\'=\'qualified\' order by id limit 100',[workspaceId])
    const profiles=rows.rows.map(row=>JobRuntimeProfileSchema.parse(row.record)),policies=[]
    for(const profile of profiles)if(profile.measurement&&Date.parse(profile.measurement.expiresAt)>Date.now()&&(await this.producer.revalidate(sql,profile)).ready)policies.push(profile.policy)
    return policies
  }
  readiness(sql: JobSql, profile: JobRuntimeProfile) {
    if (profile.status !== 'qualified' || !profile.measurement || Date.parse(profile.measurement.expiresAt) <= Date.now()) {
      return Promise.resolve({ ready: false, reasons: ['runtime_setup_required'] })
    }
    return this.producer.revalidate(sql, profile)
  }
  async revalidate(sql:JobSql,principal:ManagementPrincipal,root:SourceRootRecord,spec:ResolvedJobDefinitionSpec) {
    requireAuthorization(principal,'source_roots:read',{workspaceId:root.binding.workspaceId})
    requireAuthorization(await readLiveManagementPrincipal(sql,principal.id),'source_roots:read',{workspaceId:root.binding.workspaceId})
    const currentProfile=await this.record(sql,root.binding.workspaceId,spec.policy.isolationPolicyId)
    if(currentProfile.status==='revoked')throw new DomainError('JOB_RUNTIME_UNQUALIFIED','The runtime profile authority was revoked.',403)
    const version=(await sql.query<{record:unknown}>('select record from job_runtime_profile_versions where profile_id=$1 and revision=$2 for share',[spec.policy.isolationPolicyId,spec.policy.isolationPolicyRevision])).rows[0]
    if(!version)throw new DomainError('JOB_RUNTIME_UNQUALIFIED','The exact immutable runtime policy version is missing.',409)
    const saved=JobRuntimeProfileSchema.parse(version.record)
    const evidence=(await sql.query<{measurement:unknown}>('select measurement from job_runtime_qualification_approvals where profile_id=$1 and profile_revision=$2 and workspace_id=$3 and record->>\'status\'=\'complete\' order by id',[saved.id,saved.revision,root.binding.workspaceId])).rows
      .map(row=>JobRuntimeMeasurementSchema.parse(row.measurement)).find(value=>Date.parse(value.expiresAt)>Date.now()&&value.specDigest===saved.specDigest)
    const profile:JobRuntimeProfile={...saved,status:'qualified',measurement:evidence??null}
    const sameNamespace=canonical(profile.root.selection.hostRef)===canonical(root.selection.hostRef)&&canonical(profile.root.registration)===canonical(root.registration)&&profile.root.selection.rootPolicyId===root.selection.rootPolicyId&&profile.root.selection.rootPolicyRevision===root.selection.rootPolicyRevision&&canonical(profile.root.binding.filesystem)===canonical(root.binding.filesystem)&&profile.root.binding.canonicalPath===root.binding.canonicalPath
    if(profile.status!=='qualified'||!profile.measurement||profile.revision!==spec.policy.isolationPolicyRevision||canonical(profile.policy)!==canonical(spec.policy)||!sameNamespace)throw new DomainError('JOB_RUNTIME_UNQUALIFIED','The exact policy/root/host has no current actual qualification.',409)
    const current=await this.producer.revalidate(sql,profile)
    if(!current.ready)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The qualified runtime context changed.',409,{reasons:current.reasons})
  }
}
