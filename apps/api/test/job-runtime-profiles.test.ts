import { describe,expect,it,vi } from 'vitest'
import type pg from 'pg'
import Fastify from 'fastify'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { JobRuntimeProfileSchema,JobRuntimeFingerprintSchema,JobRuntimeApprovalSchema } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresJobRuntimeHumanAuthority } from '../src/modules/jobs/runtimeHumanAuthority.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import { jobSpec } from './helpers/jobFixture.js'
const uuid='11111111-1111-4111-8111-111111111111',digest='1'.repeat(64)
const principal:ManagementPrincipal={id:'runtime-reader',name:'Runtime reader',audience:'operator',grants:[{actions:['job_definitions:read','job_definitions:write'],scope:{workspaceIds:['workspace-fixture']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
const root=SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:uuid,snapshotId:uuid,manifestDigest:digest},selection:{hostRef:{kind:'main',mainId:uuid},rootPolicyId:'root-policy',rootPolicyRevision:'1',locationRevision:'1'},binding:{version:1,mainId:uuid,deviceId:null,workerInstallationId:null,workspaceId:'workspace-fixture',rootId:uuid,bindingRevision:1,locationRevision:1,canonicalPath:'/approved',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write',snapshotId:uuid,manifestDigest:digest},ownerPrincipalId:principal.id,authorizedByPrincipalId:principal.id,registration:null,attestationId:'actual-test-attestation',attestationDigest:digest,boundAt:'2026-10-01T00:00:00.000Z'})
const profile=JobRuntimeProfileSchema.parse({schemaVersion:1,id:'runtime-profile',workspaceId:'workspace-fixture',revision:1,name:'Runtime metadata',root,policy:{...jobSpec().policy,isolationPolicyId:'runtime-profile'},limits:{cpuLimit:1,memoryBytes:1024,pidsLimit:32,diskBytes:8192},specDigest:digest,status:'unqualified',measurement:null,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'})
const fingerprint=JobRuntimeFingerprintSchema.parse({schemaVersion:1,profileId:profile.id,profileRevision:1,specDigest:digest,hostRef:root.selection.hostRef,registration:null,mainInstallationId:'main-installation',bootId:uuid,root,runtimeExecutable:'/usr/bin/podman',runtimeBinarySha256:digest,ociExecutable:'/usr/bin/crun',ociBinarySha256:digest,configurationDigest:digest,imageDigest:profile.policy.imageDigest,toolchainDigest:digest,limits:profile.limits})
const approval=JobRuntimeApprovalSchema.parse({schemaVersion:1,id:uuid,qualificationId:uuid,workspaceId:profile.workspaceId,profileId:profile.id,profileRevision:1,fingerprint,fingerprintDigest:digest,requestedByPrincipalId:principal.id,status:'awaiting-approval',approvedByPrincipalId:null,approvedAt:null,expiresAt:'2099-01-01T00:00:00.000Z'})
function fixture(options:{revoked?:boolean;approvalStatus?:typeof approval.status;runCommand?:string;runResult?:unknown;approvalReceipt?:unknown}={}) {
  const state={profile:{...profile},approval:{...approval,status:options.approvalStatus??approval.status},runResult:options.runResult??null}
  if(state.approval.status==='approved'||state.approval.status==='qualifying'){state.approval.approvedAt='2026-10-01T00:00:00.000Z';state.approval.approvedByPrincipalId=principal.id}
  const query=vi.fn(async(text:string,values?:unknown[])=>{
    let rows:unknown[]=[]
    if(text.includes('select id,name,audience,grants'))rows=[{id:principal.id,name:principal.name,audience:'operator',grants:principal.grants,expires_at:new Date(principal.expiresAt),revoked_at:options.revoked?new Date():null,delegated_from:null}]
    else if(text.includes('select result from management_command_receipts'))rows=options.approvalReceipt?[{result:options.approvalReceipt}]:[]
    else if(text.includes('select archived_at'))rows=[{archived_at:null}]
    else if(text.startsWith('select record from job_runtime_profiles'))rows=[{record:state.profile}]
    else if(text.startsWith('select record from job_runtime_qualification_approvals'))rows=[{record:state.approval}]
    else if(text.startsWith('select measurement,run_result'))rows=[{measurement:null,run_result:state.runResult}]
    else if(text.startsWith('select run_command_id'))rows=[{run_command_id:options.runCommand??null,run_principal_id:options.runCommand?principal.id:null,measurement:null,run_result:state.runResult}]
    else if(text.startsWith('update job_runtime_profiles'))state.profile=JSON.parse(values![2] as string)
    else if(text.startsWith('update job_runtime_qualification_approvals set record'))state.approval=JSON.parse(values![1] as string)
    else if(text.startsWith('update job_runtime_qualification_approvals set measurement'))state.runResult=JSON.parse(values![4] as string)
    else if(text.includes('order by id limit 100'))rows=[{record:state.profile}]
    return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]}
  })
  const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool
  const producer={capture:vi.fn(async()=>fingerprint),run:vi.fn(async()=>({outcome:'denied' as const,closure:'unconfirmed' as const,reasons:['DESCENDANT_CLOSURE_UNCONFIRMED']})),revalidate:vi.fn(async()=>({ready:false,reasons:['UNQUALIFIED']}))}
  const human={require:vi.fn(async()=>undefined)}
  const commands={execute:async(input:{authorize:(sql:unknown)=>Promise<void>;prepare?:()=>Promise<void>;perform:(sql:unknown)=>Promise<unknown>})=>{await input.authorize({query});await input.prepare?.();return {value:await input.perform({query}),replayed:false}}} as unknown as PostgresCommandCoordinator
  const changed = vi.fn(() => state.profile.status)
  return {state,producer,human,changed,query,sql:{query:vi.fn().mockImplementation(query)},service:new JobRuntimeProfiles(pool,commands,{} as PostgresSourceService,producer,human,changed)}
}
describe('CI runtime metadata authority and original qualification ownership',()=>{
  it('lists scoped pending approval fingerprints without probing or approving',async()=>{
    const f=fixture(),read=await f.service.list(principal,profile.workspaceId)
    expect(read).toHaveProperty('approvals',[f.state.approval])
    expect(f.producer.capture).not.toHaveBeenCalled();expect(f.producer.run).not.toHaveBeenCalled()
  })
  it('reads original approval without any candidate capture or native probe',async()=>{
    const f=fixture(),read=await f.service.getQualification(principal,profile.workspaceId,approval.id)
    expect(read.readiness).toEqual({ready:false,reasons:['RUNTIME_UNQUALIFIED'],sideEffects:false})
    expect(read.measurement).toBeNull();expect(f.producer.run).not.toHaveBeenCalled();expect(f.producer.capture).not.toHaveBeenCalled();expect(f.producer.revalidate).not.toHaveBeenCalled()
    expect(f.changed).not.toHaveBeenCalled()
  })
  it('denies revoked principal before exposing stored profile or evidence',async()=>{
    const f=fixture({revoked:true})
    await expect(f.service.getQualification(principal,profile.workspaceId,approval.id)).rejects.toMatchObject({code:'AUTH_REVOKED'})
    expect(f.query.mock.calls.some(([text])=>text.includes('from job_runtime_profiles'))).toBe(false)
  })
  it('never uses MCP transport as human approval',async()=>{
    const f=fixture()
    await expect(f.service.approve(principal,'mcp',profile.workspaceId,'approval-command',approval.id)).rejects.toMatchObject({code:'JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED'})
    expect(f.human.require).not.toHaveBeenCalled();expect(f.producer.run).not.toHaveBeenCalled()
  })
  it('requires the complete original browser approval receipt, with only lifecycle status advancing',async()=>{
    const original=JobRuntimeApprovalSchema.parse({...approval,status:'approved',approvedByPrincipalId:principal.id,approvedAt:'2026-10-01T00:00:00.000Z'})
    const f=fixture({approvalReceipt:original}),human=new PostgresJobRuntimeHumanAuthority()
    await human.require(f.sql,principal,{...original,status:'qualifying'})
    await expect(human.require(f.sql,principal,{...original,qualificationId:'22222222-2222-4222-8222-222222222222'})).rejects.toMatchObject({code:'JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED'})
    await expect(human.require(f.sql,principal,{...original,fingerprint:{...original.fingerprint,runtimeExecutable:'/other/runtime'}})).rejects.toMatchObject({code:'JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED'})
    await expect(human.require(f.sql,principal,{...original,expiresAt:'2098-01-01T00:00:00.000Z'})).rejects.toMatchObject({code:'JOB_RUNTIME_HUMAN_APPROVAL_REQUIRED'})
    expect(f.producer.run).not.toHaveBeenCalled()
  })
  it('persists unresolved closure as recovery-required without claiming qualification',async()=>{
    const f=fixture({approvalStatus:'approved'})
    const result=await f.service.qualify(principal,'mcp',profile.workspaceId,'original-command',approval.id)
    expect(result.status).toBe('recovery-required');expect(result.measurement).toBeNull()
    expect(f.state.approval.status).toBe('recovery-required');expect(f.producer.run).toHaveBeenCalledOnce()
    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.changed.mock.results[0]?.value).toBe('recovery-required')
    const read=await f.service.getQualification(principal,profile.workspaceId,approval.id)
    expect(read.readiness.reasons).toEqual(['DESCENDANT_CLOSURE_UNCONFIRMED'])
  })
  it('does not launch again after an original physical command lost its result',async()=>{
    const f=fixture({approvalStatus:'qualifying',runCommand:'original-command'})
    await expect(f.service.qualify(principal,'mcp',profile.workspaceId,'original-command',approval.id)).rejects.toMatchObject({code:'JOB_RUNTIME_RECOVERY_REQUIRED'})
    expect(f.producer.run).not.toHaveBeenCalled()
  })
  it('rejects bearer approval at the verified browser boundary',async()=>{
    const app=Fastify(),f=fixture(),approve=vi.spyOn(f.service,'approve')
    app.addHook('preHandler',async request=>{request.operatorPrincipal=principal;request.operatorAuthentication='bearer'})
    registerJobRuntimeProfileRoutes(app,f.service)
    const response=await app.inject({method:'POST',url:`/api/management/workspaces/${profile.workspaceId}/jobs/runtime-qualifications/${approval.id}/approve`,payload:{commandId:'approve-command'}})
    expect(response.statusCode).toBe(403);expect(approve).not.toHaveBeenCalled();await app.close()
  })

})
