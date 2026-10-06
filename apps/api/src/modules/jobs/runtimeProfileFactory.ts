import type pg from 'pg'
import { componentLogger } from '../../infrastructure/logger.js'
import { JobRuntimeProfileSchema, JobRuntimeFingerprintSchema, InstalledJobRuntimeDescriptorSchema }
  from '@foreman-code/contracts/job-runtime'
import { JobRuntimeApprovalRecordSchema, JobRuntimeProfileRecordSchema, JobRuntimeFingerprintRecordSchema,
  JobQualificationCandidateRecordSchema, JobVerificationInstalledRuntimeDescriptorSchema,
  type JobRuntimeProfileRecord, type JobRuntimeFingerprintRecord, type JobRuntimeApprovalRecord,
  type JobRuntimeNativeAdmissionRecord, type JobQualificationCandidateRecord, InstalledJobRuntimeDescriptorRecordSchema,
  jobRuntimeProfilePolicy, jobRuntimeProfileLimits } from '@foreman-code/contracts/job-verification-runtime'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { canonical,type JobSql } from './repository.js'
import { JobRuntimeProfiles } from './runtimeProfiles.js'
import { PostgresJobRuntimeHumanAuthority } from './runtimeHumanAuthority.js'
import type { JobRuntimeQualificationResult } from './runtimeProfilePorts.js'
import { createPhysicalJobRuntimeProducer,type QualificationNativeOwner } from './qualification.js'
import { admitInstalledJobQualification,assertInstalledJobQualification,assertInstalledJobQualificationRead } from './runtimeQualificationAdmission.js'
/** Implemented by the existing installed HRT host. No public descriptor, caller
 * readiness flag, native exit claim or second runtime registry is admitted. */
export interface InstalledJobRuntimeHost {
  capture?(profile:JobRuntimeProfileRecord):Promise<JobRuntimeFingerprintRecord>
  runAdmitted?(input:{approval:JobRuntimeApprovalRecord;profile:JobRuntimeProfileRecord;candidate:JobQualificationCandidateRecord;descriptor:ReturnType<typeof InstalledJobRuntimeDescriptorRecordSchema.parse>;nativeAdmission:JobRuntimeNativeAdmissionRecord;assertAdmission():Promise<void>;signal:AbortSignal;intent?:'execute'|'reconcile'}):Promise<JobRuntimeQualificationResult>
  descriptor(profile:JobRuntimeProfileRecord):Promise<ReturnType<typeof InstalledJobRuntimeDescriptorRecordSchema.parse>>
  currentMetadata(sql:JobSql,profile:JobRuntimeProfileRecord):Promise<JobRuntimeFingerprintRecord|null>
  currentConnection(sql:JobSql,profile:JobRuntimeProfileRecord):Promise<DeviceSessionBinding|null>
  reserveQualification(input:{approval:JobRuntimeApprovalRecord;profile:JobRuntimeProfileRecord;candidate:JobQualificationCandidateRecord;nativeAdmission:JobRuntimeNativeAdmissionRecord;assertAdmission():Promise<void>;operationId:string;signal:AbortSignal;intent?:'execute'|'reconcile'}):Promise<QualificationNativeOwner>
}
export function createJobRuntimeProfileService(input:{pool:pg.Pool;commands:PostgresCommandCoordinator;sources:PostgresSourceService;host:InstalledJobRuntimeHost;changed?: () => void}) {
  const human=new PostgresJobRuntimeHumanAuthority()
  async function transaction<T>(work:(sql:pg.PoolClient)=>Promise<T>) {
    const sql=await input.pool.connect()
    try{await sql.query('begin');const value=await work(sql);await sql.query('commit');return value}
    catch(error){await sql.query('rollback');throw error}finally{sql.release()}
  }
  async function authorized(sql:JobSql,approval:JobRuntimeApprovalRecord) {
    const row=(await sql.query<{record:unknown;run_command_id:string|null;run_principal_id:string|null}>(`select record,run_command_id,run_principal_id from job_runtime_qualification_approvals where id=$1 and workspace_id=$2 for share`,[approval.id,approval.workspaceId])).rows[0]
    if(!row)throw new DomainError('JOB_RUNTIME_APPROVAL_NOT_FOUND','The original physical qualification authority is missing.',403)
    const current=JobRuntimeApprovalRecordSchema.parse(row.record)
    if(current.status!=='qualifying'||current.fingerprintDigest!==approval.fingerprintDigest||canonical(current.fingerprint)!==canonical(approval.fingerprint)||current.qualificationId!==approval.qualificationId||!current.approvedByPrincipalId||!row.run_command_id||!row.run_principal_id||Date.parse(current.expiresAt)<=Date.now())throw new DomainError('JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED','The original qualification owner or exact approval is no longer active.',403)
    requireAuthorization(await readLiveManagementPrincipal(sql,row.run_principal_id),'job_definitions:write',{workspaceId:approval.workspaceId})
    await human.require(sql,await readLiveManagementPrincipal(sql,current.approvedByPrincipalId),current)
    return current
  }
  async function immutableProfile(approval:JobRuntimeApprovalRecord) {
    return transaction(async sql=>{
      await authorized(sql,approval)
      const row=(await sql.query<{record:unknown}>(`select v.record from job_runtime_profile_versions v join job_runtime_profiles p on p.id=v.profile_id where p.workspace_id=$1 and v.profile_id=$2 and v.revision=$3 and p.revision=$3 and p.record->>'status'='qualifying' for share of p,v`,[approval.workspaceId,approval.profileId,approval.profileRevision])).rows[0]
      if(!row)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The original profile was edited or revoked.',409)
      const profile=JobRuntimeProfileRecordSchema.parse(row.record)
      if(profile.workspaceId!==approval.workspaceId||profile.specDigest!==approval.fingerprint.specDigest)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The original immutable profile differs from the approved fingerprint.',409)
      return profile
    })
  }
  async function qualificationAuthority(approval:JobRuntimeApprovalRecord,profile:JobRuntimeProfileRecord) {
      const claim=await transaction(async sql=>{
        await authorized(sql,approval)
        const row=(await sql.query<{run_command_id:string;run_principal_id:string}>('select run_command_id,run_principal_id from job_runtime_qualification_approvals where id=$1 for share',[approval.id])).rows[0]!
        return {runCommandId:row.run_command_id,runPrincipalId:row.run_principal_id}
      })
      let retained:JobRuntimeNativeAdmissionRecord|undefined
      const context=(candidate:JobQualificationCandidateRecord)=>({candidate,...claim,
        resolveRoot:async(sql:JobSql,saved:JobRuntimeProfileRecord,runner:Parameters<PostgresSourceService['resolveRootBinding']>[1])=>input.sources.resolveRootBinding(sql,runner,{workspaceId:saved.workspaceId,rootId:saved.root.binding.rootId,bindingRevision:saved.root.binding.bindingRevision,source:saved.root.source}),
        readCurrent:async(sql:JobSql,saved:JobRuntimeProfileRecord)=>{
          const fingerprint=await input.host.currentMetadata(sql,saved)
          if(!fingerprint)throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','Current installed runtime metadata is unavailable.',409)
          return {fingerprint,connection:await input.host.currentConnection(sql,saved)}
        }})
      const admitNative=async(candidate:JobQualificationCandidateRecord,intent:'execute'|'reconcile'='execute')=>{
        retained=await transaction(sql=>admitInstalledJobQualification(sql,context(candidate),{ access: intent === 'reconcile' ? 'read' : 'launch' }))
        return {nativeAdmission:retained,assertAdmission:()=>transaction(sql=>intent === 'reconcile'
          ? assertInstalledJobQualificationRead(sql,context(candidate),retained!)
          : assertInstalledJobQualification(sql,context(candidate),retained!))}
      }
      return {admitNative,operationId:approval.qualificationId,authority:{
      readApproval:async(id:string)=>{
        if(id!==approval.id)return null
        try{return await transaction(async sql=>{const current=await authorized(sql,approval);return {status:'approved' as const,fingerprint:current.fingerprintDigest,expiresAt:current.expiresAt}})}
        catch(error){if(error instanceof DomainError&&error.status<500)return null;throw error}
      },
      assertCurrent:async(candidate:JobQualificationCandidateRecord)=>{
        if(retained){await transaction(sql=>assertInstalledJobQualification(sql,context(candidate),retained!));return}
        await immutableProfile(approval)
        await transaction(async sql=>{
          await authorized(sql,approval)
          const current=await input.host.currentMetadata(sql,profile)
          if(!current||canonical(current)!==canonical(candidate.fingerprint))throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','Current installed HRT metadata changed.',409)
        })
      },
      reserve:async(candidate:JobQualificationCandidateRecord,signal:AbortSignal)=>{
        await immutableProfile(approval)
        if(candidate.operationId!==approval.qualificationId||candidate.approvalId!==approval.id||candidate.qualificationId!==approval.qualificationId||canonical(candidate.fingerprint)!==canonical(approval.fingerprint))throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The native reservation differs from its original qualified operation.',409)
        return input.host.reserveQualification({approval,profile,candidate,...await admitNative(candidate),operationId:approval.qualificationId,signal})
      },
    }}
  }
  const localProducer = createPhysicalJobRuntimeProducer({
    descriptor: async profile => InstalledJobRuntimeDescriptorSchema.parse(await input.host.descriptor(profile)),
    immutableProfile: async approval => JobRuntimeProfileSchema.parse(await immutableProfile(approval)),
    currentMetadata: async (sql, profile) => {
      const fingerprint = await input.host.currentMetadata(sql, profile)
      return fingerprint ? JobRuntimeFingerprintSchema.parse(fingerprint) : null
    },
    admission: qualificationAuthority,
  })
  const run = async (approval:JobRuntimeApprovalRecord,signal:AbortSignal,intent:'execute'|'reconcile'):Promise<JobRuntimeQualificationResult>=>{
    if (approval.schemaVersion === 1 && approval.fingerprint.hostRef.kind === 'main') return localProducer.run(approval, signal)
    if(!input.host.capture||!input.host.runAdmitted)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The installed worker qualification carrier is unavailable.',503)
    const profile=await immutableProfile(approval),fingerprint=await input.host.capture(profile),descriptor=await input.host.descriptor(profile)
    if(canonical(fingerprint)!==canonical(approval.fingerprint))throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED','The installed worker fingerprint changed.',409)
    let backingBytes: number | null = jobRuntimeProfileLimits(profile).diskBytes
    let verification: { volumeCapacityBytes: number; profile: JobRuntimeProfileRecord; approvedAt: string | null } | undefined
    if (fingerprint.schemaVersion === 3) {
      const installed = JobVerificationInstalledRuntimeDescriptorSchema.parse(descriptor)
      backingBytes = installed.backingFile === null ? null : installed.volumeCapacityBytes
      verification = { volumeCapacityBytes: installed.volumeCapacityBytes, profile, approvedAt: approval.approvedAt }
    }
    const candidate = JobQualificationCandidateRecordSchema.parse({
      approvalId: approval.id, qualificationId: approval.qualificationId, operationId: approval.qualificationId,
      fingerprint, findmntBinary: descriptor.findmntExecutable, findmntBinarySha256: descriptor.findmntBinarySha256,
      backingFile: descriptor.backingFile, backingBytes, ...verification,
      controllerEnvironment: descriptor.controllerEnvironment, sourceParent: profile.root.binding.canonicalPath,
      runtimeRoot: descriptor.runtimeRoot, spoolBytes: jobRuntimeProfilePolicy(profile).maxWorkerSpoolBytes,
      ttlSeconds: fingerprint.schemaVersion === 3
        ? Math.max(1, Math.floor((Date.parse(approval.expiresAt) - Date.now()) / 1000)) : 3600,
    })
    const authority=await qualificationAuthority(approval,profile),admitted=await authority.admitNative(candidate,intent)
    await admitted.assertAdmission()
    const result=await input.host.runAdmitted({approval,profile,candidate,descriptor,...admitted,signal,intent})
    await admitted.assertAdmission()
    return result
    }
  const producer={...localProducer,
    capture:async(profile:JobRuntimeProfileRecord)=>{
      if (profile.schemaVersion === 1 && profile.root.selection.hostRef.kind === 'main') return localProducer.capture(profile)
      if(!input.host.capture)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The installed worker qualification capture is unavailable.',503)
      return JobRuntimeFingerprintRecordSchema.parse(await input.host.capture(profile))
    },
    run: (approval: JobRuntimeApprovalRecord, signal: AbortSignal) => run(approval, signal, 'execute'),
    reconcile: (approval: JobRuntimeApprovalRecord, signal: AbortSignal) => run(approval, signal, 'reconcile'),
    revalidate: async (sql: JobSql, profile: JobRuntimeProfileRecord) => {
      if (profile.schemaVersion === 1) return localProducer.revalidate(sql, profile)
      const measurement = profile.measurement
      if (profile.status !== 'qualified' || !measurement) return { ready: false, reasons: ['unqualified'] }
      if (Date.parse(measurement.expiresAt) <= Date.now()) return { ready: false, reasons: ['expired'] }
      const current = await input.host.currentMetadata(sql, profile)
      if (!current || canonical(current) !== canonical(measurement.fingerprint)) {
        componentLogger('jobs').warn({ profileId: profile.id, currentAvailable: !!current,
          changedFields: current ? Object.keys(measurement.fingerprint).filter(key =>
            canonical(Reflect.get(current, key)) !== canonical(Reflect.get(measurement.fingerprint, key))) : [] },
        'Job runtime fingerprint comparison failed')
      }
      return current && canonical(current) === canonical(measurement.fingerprint)
        ? { ready: true, reasons: [] } : { ready: false, reasons: ['context_changed'] }
    },
  }
  return new JobRuntimeProfiles(input.pool,input.commands,input.sources,producer,human,input.changed)
}
