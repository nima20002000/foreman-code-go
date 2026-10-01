import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { describe, it, expect, vi } from 'vitest'
import { DeviceRegistrationSchema } from '@graphql/contracts/device-identity'
import { JobOutputPublicationInputSchema, type JobOutputAdmission } from '@graphql/contracts/job-output-transfer'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import { PostgresJobOutputAdmission, outputTransferContext } from '../src/modules/files/jobs/outputAdmission.js'
import { ResumableByteTransferService } from '../src/modules/byte-transfer/service.js'
import { ResumableByteTransferSender } from '../src/modules/byte-transfer/sender.js'
import { WorkerJobOutputApplication, WorkerJobOutputReceiver, jobOutputDeviceExtension } from '../src/modules/files/jobs/outputChannel.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
import type { SourceMaterializationRecord } from '@graphql/contracts/source-admission'
const digest=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
/** Modeled SQL/session authority unit boundary. Actual PostgreSQL pairing/ownership is in the root-only fixture. */
async function fixture() {
  const job=jobExecution();job.createdAt=new Date().toISOString();job.id=randomUUID();job.attemptId=randomUUID();job.operationId=randomUUID();job.owner={grantId:randomUUID(),epoch:'1'}
  const binding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1}
  job.acceptedSpec.target={...job.acceptedSpec.target,mainId:binding.mainId,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1}}
  job.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};job.finishedAt=job.createdAt
  job.acceptedSpec.outputs=[{path:'dist/result.json',mediaType:'application/json',required:true}]
  const rootBinding={version:1 as const,mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId:job.workspaceId,rootId:randomUUID(),bindingRevision:1,locationRevision:1,canonicalPath:'/approved/owned-unit-root',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write' as const,snapshotId:job.acceptedSpec.source.snapshotId,manifestDigest:job.acceptedSpec.source.manifestDigest}
  const material:SourceMaterializationRecord={receipt:{version:1,materializationId:randomUUID(),binding:rootBinding,placementHash:digest('source-binding'),executionId:job.id,attemptId:job.attemptId,keyRevision:1,authorizationRevision:1,verifiedManifestDigest:rootBinding.manifestDigest,verifiedEntries:0,verifiedBytes:0,verifiedAt:job.createdAt,localTreeIdentity:{device:'1',inode:'4',mountId:'3'}},rootPolicyId:job.acceptedSpec.target.destination.rootPolicyId,rootPolicyRevision:'1',operationId:job.operationId,reservationId:randomUUID(),sourceBindingHash:digest('source-binding'),finalDispatchBindingHash:job.acceptedSpec.bindingHash,state:'prepared'}
  job.acceptedSpec.source.materializationId=material.receipt.materializationId;job.acceptedSpec.source.materializationDigest=sourceMaterializationDigest(material)
  const root={version:1,source:{approvedSourceId:job.acceptedSpec.source.approvedSourceId,snapshotId:rootBinding.snapshotId,manifestDigest:rootBinding.manifestDigest},selection:{hostRef:job.acceptedSpec.target.hostRef,rootPolicyId:material.rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},binding:rootBinding,ownerPrincipalId:'owner',authorizedByPrincipalId:'owner',registration:job.acceptedSpec.target.registration,attestationId:'attestation',attestationDigest:digest('attestation'),boundAt:job.createdAt}
  const source={version:1,workspaceId:job.workspaceId,ownerPrincipalId:'owner',approvedByPrincipalId:'owner',locationRevision:1,mainId:binding.mainId,originIdentityHash:`sha256:${digest('origin')}`,approvedAt:job.createdAt,availability:'retained',manifest:{version:1,snapshotId:rootBinding.snapshotId,approvedSourceId:job.acceptedSpec.source.approvedSourceId,capturePolicy:'git-tree-v1',executablePolicy:'strip',git:{commit:job.acceptedSpec.source.commit,tree:'2'.repeat(40),objectFormat:'sha1'},entries:[],deletions:[],totalEntries:0,totalBytes:0,manifestDigest:rootBinding.manifestDigest}}
  const intent={schemaVersion:1,protocolVersion:1,mainId:binding.mainId,subject:{kind:'manual-job',workspaceId:job.workspaceId,jobExecutionId:job.id,definitionId:job.acceptedSpec.definitionId},executionId:job.id,attemptId:job.attemptId,operationId:job.operationId,bindingHash:job.acceptedSpec.bindingHash,inputDigest:`sha256:${job.acceptedSpec.specDigest}`,owner:job.owner}
  const receipt={schemaVersion:1,kind:'job',intent,execution:job,connection:{mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,keyRevision:binding.keyRevision,authorizationRevision:binding.authorizationRevision,bootId:binding.bootId,connectionGeneration:binding.connectionGeneration},workerIncarnationId:randomUUID(),sequence:1,observedAt:job.createdAt,phase:'confirmed_terminal',entryAttempted:true,stopFence:false,native:{containerId:'unit-original-container',supervisorIdentity:'unit-original-supervisor',processIdentityDigest:digest('unit-process'),startedAt:job.createdAt},controls:[],terminal:{finishedAt:job.finishedAt,closureEvidenceDigest:digest('unit-closure'),outcome:'succeeded',exitCode:0,signal:null,processStopped:true,resultDigest:digest('result'),logGapPossible:false,logsTruncated:false,outputCollectionError:false,artifactDigests:[]},publication:'process_recorded'}
  const registration=DeviceRegistrationSchema.parse({mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1,publicKeyFingerprint:digest('unit-key'),status:'paired',scopes:['connect','heartbeat']})
  const records=new Map<string,JobOutputAdmission>();let now=new Date(job.createdAt),ready=true,revoked=false,liveOwner=true,rootRevision=1,rootRevoked=false,canonicalState='pending',allocationState='allocated'
  const fileId=randomUUID(),revisionId=randomUUID(),expires=new Date(now.getTime()+7200_000)
  const query=vi.fn(async(text:string,args:unknown[]=[])=>{
    if(text.startsWith('select record,accepted_spec'))return {rows:[{record:job,accepted_spec:job.acceptedSpec}]}
    if(text.startsWith('select accepted_by'))return {rows:[{accepted_by:'owner'}]}
    if(text.includes('management_principals'))return {rows:[{id:'owner',name:'Owner',audience:'operator',grants:[{actions:['jobs:start'],scope:{workspaceIds:[job.workspaceId]}}],expires_at:new Date('2099-01-01'),revoked_at:null,delegated_from:null}]}
    if(text.startsWith('select record from job_definition_versions'))return {rows:[{record:{schemaVersion:1,id:job.acceptedSpec.definitionId,workspaceId:job.workspaceId,name:'Original',revision:1,versionId:job.acceptedSpec.definitionVersionId,spec:{...jobSpec(),target:job.acceptedSpec.target,outputs:job.acceptedSpec.outputs},createdAt:job.createdAt,updatedAt:job.createdAt}}]}
    if(text.startsWith('select id from application_installation'))return {rows:[{id:binding.mainId}]}
    if(text.includes('from device_registrations'))return {rows:[{record:{...registration,status:revoked?'revoked':'paired'},credential_expires_at:new Date('2099-01-01')}]}
    if(text.includes('from job_dispatch_intents'))return {rows:[{intent,last_receipt:receipt,receipt_sequence:'1'}]}
    if(text.includes('from source_execution_materializations'))return {rows:[{record:material,state:'closed'}]}
    if(text.includes('from source_root_bindings'))return {rows:[{record:root,current_binding_revision:String(rootRevision),revoked_at:rootRevoked?now:null}]}
    if(text.includes('from source_snapshots'))return {rows:[{record:source,availability:'retained'}]}
    if(text.includes('from file_allocations'))return {rows:[{state:canonicalState,allocation_state:allocationState,expires_at:expires}]}
    if(text.startsWith('insert into management_command_receipts')){records.set(String(args[2]),JSON.parse(String(args[5])));return {rows:[],rowCount:1}}
    if(text.includes("where principal_id = $1 and operation = $2 and command_id = $3")){const old=records.get(String(args[2]));return {rows:old?[{input_hash:commandInputHash(old.input),target_key:`job:${job.id}:output:${old.input.path}`,result:old}]:[]}}
    if(text.includes('where principal_id=$1 and operation=$2 and command_id=$3')){const old=records.get(String(args[2]));return {rows:old?[{result:old}]:[]}}
    if(text.includes("result #>> '{intent,transferId}'"))return {rows:[...records.values()].filter(r=>r.intent.transferId===args[1]).map(result=>({result}))}
    if(text.includes("result #>> '{input,executionId}'"))return {rows:[...records.values()].filter(r=>r.input.executionId===args[1]&&r.input.attemptId===args[2]&&r.input.path===args[3])}
    return {rows:[],rowCount:0}
  })
  const pool={query,connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool
  vi.spyOn(pg,'Pool').mockImplementation(class { constructor(){return pool} } as unknown as typeof pg.Pool)
  const authority=new JobPublicationAuthority({require:async()=>{if(!liveOwner)throw new DomainError('JOB_OWNERSHIP_LOST','Modeled owner lost.',409)}},{validate:async()=>({valid:true,reasons:[],sideEffects:false})} as never)
  const endpoint={currentBinding:()=>ready?Object.freeze({...binding}):undefined}
  const reserve=vi.fn(async()=>({file:{fileId,currentRevisionId:revisionId,scope:{kind:'job_execution' as const,workspaceId:job.workspaceId,jobExecutionId:job.id},state:'pending' as const,createdAt:job.createdAt,retentionDurationSeconds:7200,expiresAt:expires.toISOString()},revision:{byteClass:'ci-output' as const,fileId,revisionId,filename:'result.json',mediaType:'application/json' as const,byteSize:11,sha256:digest('{"ok":true}'),origin:'job_output' as const,createdAt:job.createdAt}}))
  const admission=new PostgresJobOutputAdmission(pool,authority,endpoint,reserve,()=>now)
  const input=JobOutputPublicationInputSchema.parse({workspaceId:job.workspaceId,executionId:job.id,attemptId:job.attemptId,owner:job.owner,commandId:randomUUID(),path:'dist/result.json',mediaType:'application/json',sha256:digest('{"ok":true}'),byteSize:11})
  return {admission,input,binding,job,records,reserve,query,endpoint,revoked:()=>{revoked=true},loseOwner:()=>{liveOwner=false},rebind:()=>{binding.connectionEpoch=randomUUID()},offline:()=>{ready=false},expire:()=>{now=new Date(expires)},rootChange:()=>{rootRevision++},revokeRoot:()=>{rootRevoked=true},advance:()=>{now=new Date(now.getTime()+3600_001)},finalize:(state='ready',allocation='finalized')=>{canonicalState=state;allocationState=allocation}}
}
describe('main-owned job output admission and actual byte receiver',()=>{
  it('issues original main IDs once, rejects caller IDs/changed payload and resolves current scoped context',async()=>{
    const f=await fixture(),first=await f.admission.onAuthenticatedChannel(f.binding,()=>f.admission.admit(f.input))
    const again=await f.admission.onAuthenticatedChannel(f.binding,()=>f.admission.admit(f.input,'mcp'))
    expect(again).toEqual(first);expect(f.records.size).toBe(1);expect(f.reserve).toHaveBeenCalledTimes(1)
    expect(first.rootBindingRevision).toBe(1);expect(first.transferId).not.toBe(f.input.commandId)
    expect(JobOutputPublicationInputSchema.safeParse({...f.input,transferId:randomUUID(),rootId:randomUUID()}).success).toBe(false)
    await expect(f.admission.admit({...f.input,sha256:digest('changed')})).rejects.toMatchObject({code:'JOB_OUTPUT_ADMISSION_CONFLICT'})
    expect(await f.admission.resolve(f.input,f.job)).toEqual({transferId:first.transferId,context:outputTransferContext(f.binding)})
    const old={...f.binding};f.rebind()
    await expect(f.admission.onAuthenticatedChannel(old,()=>f.admission.admit(f.input))).rejects.toMatchObject({code:'JOB_OUTPUT_CONNECTION_STALE'})
    expect((await f.admission.resolve(f.input,f.job)).transferId).toBe(first.transferId)
    f.expire();await expect(f.admission.resolve(f.input,f.job)).rejects.toMatchObject({code:'FILE_EXPIRED'})
  })
  it('reauthorizes real accepted scope and refuses revoked device/lost owner/changed root before issuing IDs',async()=>{
    for(const failure of ['revoked','loseOwner','revokeRoot','offline'] as const){const f=await fixture();f[failure]();await expect(f.admission.admit(f.input)).rejects.toBeInstanceOf(DomainError);expect(f.records.size).toBe(0)}
  })
  it('keeps the original accepted binding after the source selection head advances',async()=>{
    const f=await fixture(),first=await f.admission.admit(f.input)
    f.rootChange()
    expect(await f.admission.admit(f.input)).toEqual(first)
    expect((await f.admission.requireAdmission(f.input)).intent).toEqual(first)
    await expect(f.admission.authorizeTransfer(first,outputTransferContext(f.binding))).resolves.toBeUndefined()
    f.revokeRoot()
    await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'JOB_OUTPUT_ROOT_REVOKED'})
  })
  it('reconciles an expired admission only for an exact finalized retained canonical output',async()=>{
    const f=await fixture(),first=await f.admission.admit(f.input)
    f.advance()
    await expect(f.admission.admit(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
    f.finalize()
    expect(await f.admission.admit(f.input)).toEqual(first)
    expect((await f.admission.requireAdmission(f.input)).intent).toEqual(first)
    expect(f.reserve).toHaveBeenCalledTimes(1);expect(f.records.size).toBe(1)
    await expect(f.admission.authorizeTransfer(first,outputTransferContext(f.binding))).rejects.toMatchObject({code:'FILE_EXPIRED'})
    await expect(f.admission.admit({...f.input,sha256:digest('changed')})).rejects.toMatchObject({code:'JOB_OUTPUT_ADMISSION_CONFLICT'})
    f.revoked()
    await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'JOB_OUTPUT_DEVICE_REVOKED'})
  })
  it('requires both ready canonical bytes and finalized allocation to reconcile expired admission',async()=>{
    for(const [state,allocation] of [['ready','allocated'],['pending','finalized']]){
      const f=await fixture();await f.admission.admit(f.input);f.finalize(state,allocation);f.advance()
      await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
    }
    const f=await fixture();await f.admission.admit(f.input);f.finalize();f.advance();f.loseOwner()
    await expect(f.admission.requireAdmission(f.input)).rejects.toMatchObject({code:'JOB_OWNERSHIP_LOST'})
  })
  it('does not replay a finalized output past its independent retention',async()=>{
    const f=await fixture();await f.admission.admit(f.input);f.finalize();f.expire()
    await expect(f.admission.admit(f.input)).rejects.toMatchObject({code:'FILE_EXPIRED'})
  })
  it('uses the real resumable sender/receiver through the typed binary channel, never a substitute byte reader',async()=>{
    const f=await fixture(),root=await mkdtemp(join(process.env.GRAPHQL_HEAVY_BASE_TMPDIR ?? tmpdir(),'job-output-transfer-unit-'))
    const receiver=new ResumableByteTransferService(root,{authorize:(intent,context)=>f.admission.authorizeTransfer(intent,context)},()=>new Date(f.job.createdAt).getTime())
    const extension=jobOutputDeviceExtension(f.admission,{} as never,receiver)
    const channel={request:async(_namespace:string,payload:unknown,options?:{bytes?:Uint8Array})=>extension.handle!(payload,{binding:f.binding,signal:AbortSignal.timeout(10_000),...(options?.bytes?{bytes:options.bytes}:{})})}
    try{
      const intent=await new WorkerJobOutputApplication(channel).admit(f.input),data=Buffer.from('{"ok":true}')
      const sender=new ResumableByteTransferSender(new WorkerJobOutputReceiver(channel),{read:async(_intent,offset,length)=>data.subarray(offset,offset+length)},{current:async()=>outputTransferContext(f.binding),retryable:()=>false})
      const receipt=await sender.send(intent,AbortSignal.timeout(10_000));expect(receipt.sha256).toBe(f.input.sha256)
      const stream=await receiver.openVerified(receipt,outputTransferContext(f.binding)),chunks=[]
      for await(const chunk of stream)chunks.push(chunk as Buffer)
      expect(Buffer.concat(chunks)).toEqual(data)
      f.revoked();await expect(receiver.resolveVerifiedReceipt(intent.transferId,outputTransferContext(f.binding))).rejects.toMatchObject({code:'JOB_OUTPUT_DEVICE_REVOKED'})
    }finally{await receiver.close();await rm(root,{recursive:true,force:true})}
  })
})
