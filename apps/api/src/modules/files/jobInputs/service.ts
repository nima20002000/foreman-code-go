import type pg from 'pg'
import { JobInputAdmissionSchema, type JobInputAdmission } from '@graphql/contracts/job-inputs'
import { TransferIntentSchema, type TransferIntent, type TransferContext } from '@graphql/contracts/byte-transfer'
import { type JobExecution } from '@graphql/contracts/jobs'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { PostgresCommandCoordinator } from '../../commands/postgres.js'
import { JobRepository, type JobSql } from '../../jobs/repository.js'
import type { FileByteStorage } from '../storage.js'
import { byteRange } from '../tools/transfers.js'
import { DeviceRegistrationSchema, authorizeDevice } from '@graphql/contracts/device-identity'
import { DomainError } from '../../errors.js'
import type { JobInputAuthority } from './authority.js'
import { inputHash, makeManifest, manifestBytes, recipient, snapshotDigest } from './manifest.js'
import { outputTransferContext } from '../jobs/outputAdmission.js'
export const JOB_INPUT_NAMESPACE='job-inputs-v1'
/** Main canonical pin/grant authority. Neither callers nor workers supply paths or bytes. */
export class CanonicalJobInputs {
  private readonly commands:PostgresCommandCoordinator
  constructor(private readonly pool:pg.Pool,private readonly authority:JobInputAuthority,private readonly bytes:FileByteStorage,
    private readonly connection:Pick<DeviceEndpoint,'currentBinding'>,
    private readonly clock:()=>Date=()=>new Date()){this.commands=new PostgresCommandCoordinator(pool)}
  private async transaction<T>(work:(sql:JobSql)=>Promise<T>):Promise<T>{const sql=await this.pool.connect();try{await sql.query('begin');const value=await work(sql);await sql.query('commit');return value}catch(error){await sql.query('rollback').catch(()=>{});throw error}finally{sql.release()}}
  private binding(execution:JobExecution) {
    const target=execution.acceptedSpec.target
    if(target.hostRef.kind!=='device'||!target.registration)throw new DomainError('JOB_INPUT_REMOTE_DEVICE_REQUIRED','Remote delivery requires its actual accepted device.',403)
    const binding=this.connection.currentBinding(target.hostRef.deviceId,JOB_INPUT_NAMESPACE)
    if(!binding||binding.mainId!==target.mainId||binding.workerInstallationId!==target.registration.workerInstallationId||binding.keyRevision!==target.registration.keyRevision||binding.authorizationRevision!==target.registration.authorizationRevision)throw new DomainError('JOB_INPUT_DEVICE_CONFLICT','Current authenticated recipient differs from acceptance.',403)
    return binding
  }
  assertChannel(execution:JobExecution,binding:Readonly<DeviceSessionBinding>):void {
    if(!isDeepStrictEqual(this.binding(execution),binding))throw new DomainError('JOB_INPUT_CONNECTION_STALE','The incoming opaque recipient channel is not current.',403)
  }
  async bind(execution:JobExecution):Promise<JobInputAdmission> {
    const initial=await this.transaction(sql=>this.authority.recipient(sql,execution))
    const commandId=`job-input:${inputHash(recipient(execution))}`
    const prepared=await this.commands.execute({principal:initial.principal,source:'device',commandId,operation:'job.inputs.bind',targetKey:`job:${execution.id}:inputs`,payload:{recipient:recipient(execution),inputSnapshotDigest:snapshotDigest(execution)},
      authorize:async sql=>{const current=await this.authority.recipient(sql,execution);if(current.principal.id!==initial.principal.id)throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED','Original accepted input actor changed.',403)},
      replayResult:value=>JobInputAdmissionSchema.parse(value),perform:async sql=>{
        const current=await this.authority.recipient(sql,execution),entries=await this.authority.entries(sql,execution,current.principal),manifest=makeManifest(execution,entries)
        await this.device(sql,execution)
        const binding=execution.acceptedSpec.target.hostRef.kind==='device'?this.binding(execution):null
        const source=(await sql.query<{root_id:string;binding_revision:string}>('select root_id,binding_revision::text from source_execution_materializations where materialization_id=$1 and execution_id=$2 and attempt_id=$3 for share',[execution.acceptedSpec.source.materializationId,execution.id,execution.attemptId])).rows[0]
        if(!source)throw new DomainError('JOB_INPUT_ROOT_MISSING','The actual accepted input destination is not materialized.',409)
        const descriptors=[{relativePath:'manifest.json',sha256:manifest.manifestSha256,byteSize:manifest.manifestByteSize},
          {relativePath:'workflow-input.json',sha256:createHash('sha256').update(JSON.stringify(manifest.workflowInput)).digest('hex'),byteSize:Buffer.byteLength(JSON.stringify(manifest.workflowInput))},
          ...entries.map(entry=>({relativePath:entry.relativePath,sha256:entry.pin.sha256,byteSize:entry.pin.byteSize}))]
        return JobInputAdmissionSchema.parse({version:1,manifest,principalId:current.principal.id,principalGrantsDigest:inputHash(current.principal.grants),issuedAt:this.clock().toISOString(),
          transfers:binding?descriptors.map(value=>({relativePath:value.relativePath,intent:TransferIntentSchema.parse({version:1,...outputTransferContext(binding),transferId:randomUUID(),operationId:randomUUID(),executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:source.root_id,rootBindingRevision:Number(source.binding_revision),direction:'to-worker',byteClass:'artifact',sha256:value.sha256,byteSize:value.byteSize,manifestDigest:manifest.manifestSha256,expiresAt:new Date(this.clock().getTime()+3600_000).toISOString(),chunkBytes:8192})})):[]})
      }})
    await this.recheck(execution,prepared.value)
    return prepared.value
  }
  async recheck(execution:JobExecution,admission:JobInputAdmission) {
    return this.transaction(async sql=>{
      const current=await this.authority.recipient(sql,execution)
      if(inputHash(current.principal.grants)!==admission.principalGrantsDigest||inputHash(recipient(execution))!==inputHash(admission.manifest.recipient)||snapshotDigest(execution)!==admission.manifest.inputSnapshotDigest)throw new DomainError('JOB_INPUT_AUTHORITY_CHANGED','Accepted input snapshot or actor grant changed.',403)
      for(const entry of admission.manifest.entries)await this.authority.recheck(sql,execution,entry)
      await this.device(sql,execution)
    })
  }
  private async device(sql:JobSql,execution:JobExecution) {
      if(execution.acceptedSpec.target.hostRef.kind==='device'){
        const installation=(await sql.query<{id:string}>('select id from application_installation where singleton=true for share')).rows[0]
        if(installation?.id!==execution.acceptedSpec.target.mainId)throw new DomainError('JOB_INPUT_WRONG_MAIN','Accepted input belongs to a different main installation.',403)
        const currentBinding=this.binding(execution),row=(await sql.query<{record:unknown;credential_expires_at:Date|null}>('select record,credential_expires_at from device_registrations where id=$1 and main_id=$2 for share',[currentBinding.deviceId,currentBinding.mainId])).rows[0]
        if(!row?.credential_expires_at||!authorizeDevice(DeviceRegistrationSchema.parse(row.record),{audience:'graphql-worker',mainId:currentBinding.mainId,deviceId:currentBinding.deviceId,workerInstallationId:currentBinding.workerInstallationId,keyRevision:currentBinding.keyRevision,authorizationRevision:currentBinding.authorizationRevision,expiresAt:row.credential_expires_at.toISOString()},'heartbeat',this.clock().getTime()))throw new DomainError('JOB_INPUT_DEVICE_REVOKED','Recipient device authority expired or was revoked.',403)
        this.binding(execution)
      }
  }
  async read(execution:JobExecution,admission:JobInputAdmission,relativePath:string,offset:number,length:number):Promise<Buffer> {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>8192)throw new DomainError('JOB_INPUT_RANGE_INVALID','Input delivery ranges are bounded.',416)
    await this.recheck(execution,admission)
    let data:Buffer
    if(relativePath==='manifest.json')data=manifestBytes(admission.manifest).subarray(offset,offset+length)
    else if(relativePath==='workflow-input.json')data=Buffer.from(JSON.stringify(admission.manifest.workflowInput)).subarray(offset,offset+length)
    else {
      const entry=admission.manifest.entries.find(value=>value.relativePath===relativePath)
      if(!entry)throw new DomainError('JOB_INPUT_NOT_ADMITTED','Only declared immutable input entries may be read.',403)
      const stored=await this.authority.files.read(entry.pin.fileId,entry.pin.revisionId)
      if(!stored)throw new DomainError('FILE_BYTES_UNAVAILABLE','The canonical input is unavailable.',410)
      data=await byteRange(await this.bytes.download(stored.storageKey,stored.value.revision),offset,length)
    }
    await this.recheck(execution,admission)
    await this.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details) values($1,'device','job.input.read',$2,'succeeded',$3::jsonb)`,[admission.principalId,`job:${execution.id}`,JSON.stringify({bindingId:admission.manifest.bindingId,relativePath,offset,length,executionId:execution.id,attemptId:execution.attemptId})])
    return data
  }
  async execution(executionId:string):Promise<JobExecution>{
    const row=(await this.pool.query<{workspace_id:string}>('select workspace_id from job_executions where id=$1',[executionId])).rows[0]
    if(!row)throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Actual recipient is unavailable.',404)
    return new JobRepository().execution(this.pool,row.workspace_id,executionId)
  }
  async accepted(executionId:string):Promise<{execution:JobExecution;admission:JobInputAdmission}> {
    return this.transaction(async sql=>{
      const row=(await sql.query<{workspace_id:string}>('select workspace_id from job_executions where id=$1',[executionId])).rows[0]
      if(!row)throw new DomainError('JOB_INPUT_RECIPIENT_CONFLICT','Actual recipient is unavailable.',404)
      const execution=await new JobRepository().execution(sql,row.workspace_id,executionId)
      const record=(await sql.query<{result:unknown}>(`select result from management_command_receipts where operation='job.inputs.bind' and command_id=$1`,[`job-input:${inputHash(recipient(execution))}`])).rows
      if(record.length!==1)throw new DomainError('JOB_INPUT_NOT_ADMITTED','The original input binding has not been persisted.',403)
      return {execution,admission:JobInputAdmissionSchema.parse(record[0]!.result)}
    })
  }
  async authorizeTransfer(intent:TransferIntent,context:TransferContext) {
    const {execution,admission}=await this.accepted(intent.executionId)
    await this.recheck(execution,admission)
    if(!admission.transfers.some(value=>inputHash(value.intent)===inputHash(intent))||inputHash(outputTransferContext(this.binding(execution)))!==inputHash(context)||Date.parse(intent.expiresAt)<=this.clock().getTime())throw new DomainError('JOB_INPUT_TRANSFER_DENIED','The exact input transfer or current recipient is not authorized.',403)
  }
}
