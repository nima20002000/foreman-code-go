import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { JobOutputRsyncLifecycle } from './rsyncLifecycle.js'
import type { JobOutputAdmission } from '@foreman-code/contracts/job-output-transfer'
import type { JobPublicationLedger } from './port.js'
function fixture() {
  const fileId=randomUUID(),revisionId=randomUUID(),sha256='1'.repeat(64),owner={grantId:randomUUID(),epoch:'1'},commandId=randomUUID()
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const requestId=`ci:publish:${createHash('sha256').update(JSON.stringify(commandId)).digest('hex')}`
  const input={workspaceId:'workspace',executionId:randomUUID(),attemptId:randomUUID(),owner,commandId,path:'result.json',mediaType:'application/json' as const,sha256,byteSize:2}
  const intent={transferId:randomUUID(),executionId:input.executionId,attemptId:input.attemptId,sha256,byteSize:2,manifestDigest:'2'.repeat(64)} as JobOutputAdmission['intent']
  const record={input,intent,principalId:'owner',fileId,revisionId,specDigest:'3'.repeat(64)} as JobOutputAdmission
  const rows:Awaited<ReturnType<JobPublicationLedger['list']>>=[{link:{kind:'job_execution',ownerPrincipalId:'owner',requestId,binding:digest(['job_execution',input.executionId,input.attemptId,owner.grantId,owner.epoch]),inputHash:digest([input.workspaceId,input.executionId,input.attemptId,owner.grantId,owner.epoch,record.specDigest,intent.manifestDigest,input.path,input.mediaType,input.byteSize,input.sha256]),workspaceId:input.workspaceId,executionId:input.executionId,attemptId:input.attemptId,owner,path:input.path,specDigest:record.specDigest,outputSpecDigest:intent.manifestDigest,ref:{fileId,revisionId},createdAt:new Date().toISOString()},value:{file:{fileId,currentRevisionId:revisionId,state:'ready',scope:{kind:'job_execution',workspaceId:input.workspaceId,jobExecutionId:input.executionId},createdAt:new Date().toISOString(),retentionDurationSeconds:3600,expiresAt:new Date(Date.now()+3600000).toISOString()},revision:{fileId,revisionId,byteClass:'ci-output',filename:'result.json',mediaType:'application/json',sha256,byteSize:2,origin:'job_output',createdAt:new Date().toISOString()}}}]
  const query=vi.fn(async()=>({rows:[{}]})),admission={admissionForTransfer:vi.fn(async()=>record)},ledger={list:vi.fn(async()=>rows)}
  return {record,rows,query,admission,lifecycle:new JobOutputRsyncLifecycle({query} as unknown as pg.Pool,admission,ledger)}
}
describe('original Job output canonical rsync ACK',()=>{
  it('reads exact adopted publication only after original finalized allocation readback',async()=>{
    const f=fixture();expect(await f.lifecycle.acknowledged(f.record.intent)).toMatchObject({fileId:f.record.fileId,revisionId:f.record.revisionId,state:'available'})
    expect(f.admission.admissionForTransfer).toHaveBeenCalledTimes(2)
    expect(f.query.mock.calls.length).toBe(1)
  })
  it('denies pending allocation, missing adoption, altered transfer and changed canonical revision',async()=>{
    const pending=fixture();pending.query.mockResolvedValue({rows:[]});await expect(pending.lifecycle.acknowledged(pending.record.intent)).rejects.toMatchObject({code:'JOB_PUBLICATION_PENDING'})
    const absent=fixture();absent.rows.splice(0);await expect(absent.lifecycle.acknowledged(absent.record.intent)).rejects.toMatchObject({code:'JOB_PUBLICATION_PENDING'})
    const altered=fixture();await expect(altered.lifecycle.acknowledged({...altered.record.intent,sha256:'0'.repeat(64)})).rejects.toMatchObject({code:'JOB_OUTPUT_TRANSFER_CONFLICT'})
    const changed=fixture();changed.rows[0]!.value={...changed.rows[0]!.value,revision:{...changed.rows[0]!.value.revision,sha256:'0'.repeat(64)}};await expect(changed.lifecycle.acknowledged(changed.record.intent)).rejects.toMatchObject({code:'JOB_PUBLICATION_PENDING'})
  })
  it('propagates revoked closure/owner authority on readback',async()=>{
    const f=fixture();f.admission.admissionForTransfer.mockRejectedValueOnce(new Error('revoked owner'))
    await expect(f.lifecycle.acknowledged(f.record.intent)).rejects.toThrow('revoked owner')
  })
})
