import type pg from 'pg'
import { JobRuntimeApprovalSchema,JobRuntimeProfileSchema,type JobRuntimeProfile,type JobRuntimeFingerprint,type JobRuntimeApproval } from '@graphql/contracts/job-runtime'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { canonical,type JobSql } from './repository.js'
import { JobRuntimeProfiles } from './runtimeProfiles.js'
import { PostgresJobRuntimeHumanAuthority } from './runtimeHumanAuthority.js'
import { createPhysicalJobRuntimeProducer,type InstalledJobRuntimeDescriptor,type JobQualificationCandidate,type QualificationNativeOwner } from './qualification.js'
/** Implemented by the existing installed HRT host. No public descriptor, caller
 * readiness flag, native exit claim or second runtime registry is admitted. */
export interface InstalledJobRuntimeHost {
  descriptor(profile:JobRuntimeProfile):Promise<InstalledJobRuntimeDescriptor>
  currentMetadata(sql:JobSql,profile:JobRuntimeProfile):Promise<JobRuntimeFingerprint|null>
  reserveQualification(input:{approval:JobRuntimeApproval;profile:JobRuntimeProfile;candidate:JobQualificationCandidate;operationId:string;signal:AbortSignal}):Promise<QualificationNativeOwner>
}
export function createJobRuntimeProfileService(input:{pool:pg.Pool;commands:PostgresCommandCoordinator;sources:PostgresSourceService;host:InstalledJobRuntimeHost}) {
  const human=new PostgresJobRuntimeHumanAuthority()
  async function transaction<T>(work:(sql:pg.PoolClient)=>Promise<T>) {
    const sql=await input.pool.connect()
    try{await sql.query('begin');const value=await work(sql);await sql.query('commit');return value}
    catch(error){await sql.query('rollback');throw error}finally{sql.release()}
  }
  async function authorized(sql:JobSql,approval:JobRuntimeApproval) {
    const row=(await sql.query<{record:unknown;run_command_id:string|null;run_principal_id:string|null}>(`select record,run_command_id,run_principal_id from job_runtime_qualification_approvals where id=$1 and workspace_id=$2 for share`,[approval.id,approval.workspaceId])).rows[0]
    if(!row)throw new DomainError('JOB_RUNTIME_APPROVAL_NOT_FOUND','The original physical qualification authority is missing.',403)
    const current=JobRuntimeApprovalSchema.parse(row.record)
    if(current.status!=='qualifying'||current.fingerprintDigest!==approval.fingerprintDigest||canonical(current.fingerprint)!==canonical(approval.fingerprint)||current.qualificationId!==approval.qualificationId||!current.approvedByPrincipalId||!row.run_command_id||!row.run_principal_id||Date.parse(current.expiresAt)<=Date.now())throw new DomainError('JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED','The original qualification owner or exact approval is no longer active.',403)
    requireAuthorization(await readLiveManagementPrincipal(sql,row.run_principal_id),'job_definitions:write',{workspaceId:approval.workspaceId})
    await human.require(sql,await readLiveManagementPrincipal(sql,current.approvedByPrincipalId),current)
    return current
  }
  async function immutableProfile(approval:JobRuntimeApproval) {
    return transaction(async sql=>{
      await authorized(sql,approval)
      const row=(await sql.query<{record:unknown}>(`select v.record from job_runtime_profile_versions v join job_runtime_profiles p on p.id=v.profile_id where p.workspace_id=$1 and v.profile_id=$2 and v.revision=$3 and p.revision=$3 and p.record->>'status'='qualifying' for share of p,v`,[approval.workspaceId,approval.profileId,approval.profileRevision])).rows[0]
      if(!row)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The original profile was edited or revoked.',409)
      const profile=JobRuntimeProfileSchema.parse(row.record)
      if(profile.workspaceId!==approval.workspaceId||profile.specDigest!==approval.fingerprint.specDigest)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The original immutable profile differs from the approved fingerprint.',409)
      return profile
    })
  }
  const producer=createPhysicalJobRuntimeProducer({descriptor:profile=>input.host.descriptor(profile),immutableProfile,currentMetadata:(sql,profile)=>input.host.currentMetadata(sql,profile),
    admission:async(approval,profile)=>({operationId:approval.qualificationId,authority:{
      readApproval:async id=>{
        if(id!==approval.id)return null
        try{return await transaction(async sql=>{const current=await authorized(sql,approval);return {status:'approved' as const,fingerprint:current.fingerprintDigest,expiresAt:current.expiresAt}})}
        catch(error){if(error instanceof DomainError&&error.status<500)return null;throw error}
      },
      assertCurrent:async candidate=>{
        await immutableProfile(approval)
        await transaction(async sql=>{
          await authorized(sql,approval)
          const current=await input.host.currentMetadata(sql,profile)
          if(!current||canonical(current)!==canonical(candidate.fingerprint))throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','Current installed HRT metadata changed.',409)
        })
      },
      reserve:async(candidate,signal)=>{
        await immutableProfile(approval)
        if(candidate.operationId!==approval.qualificationId||candidate.approvalId!==approval.id||candidate.qualificationId!==approval.qualificationId||canonical(candidate.fingerprint)!==canonical(approval.fingerprint))throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The native reservation differs from its original qualified operation.',409)
        return input.host.reserveQualification({approval,profile,candidate,operationId:approval.qualificationId,signal})
      },
    }}),
  })
  return new JobRuntimeProfiles(input.pool,input.commands,input.sources,producer,human)
}
