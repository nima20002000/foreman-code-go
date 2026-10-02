import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteJobOperationStatus } from '@graphql/contracts/remote-job-execution'
import { TransferIntentSchema } from '@graphql/contracts/byte-transfer'
import { JobOutputRsyncSource, type RetainedJobOutputRsyncStore, type RetainedJobOutputRsyncRecord } from './jobOutputRsyncSource.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
function fixture() {
  const execution=jobExecution(),mainId=randomUUID(),deviceId=randomUUID(),workerInstallationId=randomUUID(),bytes=Buffer.from('{}')
  execution.id=randomUUID();execution.attemptId=randomUUID();execution.operationId=randomUUID();execution.owner={grantId:randomUUID(),epoch:'1'}
  execution.acceptedSpec.target={...execution.acceptedSpec.target,mainId,hostRef:{kind:'device',mainId,deviceId},registration:{workerInstallationId,keyRevision:1,authorizationRevision:1}}
  execution.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};execution.finishedAt=new Date().toISOString()
  execution.acceptedSpec.outputs=[{path:'result.json',mediaType:'application/json',required:true}]
  const input={workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,owner:execution.owner,commandId:randomUUID(),path:'result.json',mediaType:'application/json' as const,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length}
  const intent=TransferIntentSchema.parse({version:1,mainId,deviceId,workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1,transferId:randomUUID(),operationId:randomUUID(),executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:randomUUID(),rootBindingRevision:1,direction:'to-main',byteClass:'artifact',sha256:input.sha256,byteSize:bytes.length,manifestDigest:execution.acceptedSpec.outputSpecDigest,expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:8192})
  const status={status:'known',receipt:{phase:'confirmed_terminal',entryAttempted:true,native:{containerId:'original'},terminal:{processStopped:true,finishedAt:execution.finishedAt,closureEvidenceDigest:'4'.repeat(64)},execution,intent:{executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,bindingHash:execution.acceptedSpec.bindingHash}}} as RemoteJobOperationStatus
  const journal={jobStatus:vi.fn(async()=>status)},retained=new Map<string,{record:RetainedJobOutputRsyncRecord;bytes:Buffer}>()
  const store:RetainedJobOutputRsyncStore={retain:vi.fn(async(record,captured)=>{
    const previous=retained.get(record.intent.transferId)
    if(previous&&JSON.stringify(previous.record)!==JSON.stringify(record))throw new Error('Original retention conflict')
    retained.set(record.intent.transferId,{record:structuredClone(record),bytes:Buffer.from(captured)})
  }),resolve:vi.fn(async id=>{
    const original=retained.get(id);if(!original)throw new Error('No original sealed reader')
    return {record:original.record,source:{read:async(_intent,offset,length)=>Buffer.from(original.bytes.subarray(offset,offset+length))}}
  })}
  return {execution,input,intent,bytes,status,journal,store,retained,source:new JobOutputRsyncSource(journal,store)}
}
describe('closed Job rsync immutable source correlation',()=>{
  it('durably registers original admission before a recoverable sealed reader can serve it',async()=>{
    const f=fixture(),signal=AbortSignal.timeout(10000)
    await expect(f.source.resolveSource(f.intent,signal)).rejects.toThrow('No original sealed reader')
    await f.source.register(f.execution,f.input,f.intent,f.bytes,signal)
    f.bytes.fill(0)
    const recovered=new JobOutputRsyncSource(f.journal,f.store),reader=await recovered.resolveSource(f.intent,signal)
    expect(await reader.read(f.intent,0,2)).toEqual(Buffer.from('{}'))
    expect(f.store.retain).toHaveBeenCalledTimes(1)
    await expect(recovered.resolveSource({...f.intent,sha256:'0'.repeat(64)},signal)).rejects.toMatchObject({code:'JOB_OUTPUT_TRANSFER_CONFLICT'})
    await expect(reader.read(f.intent,1,2)).rejects.toMatchObject({code:'JOB_OUTPUT_TRANSFER_CONFLICT'})
  })
  it('rejects absent/uncertain physical closure, changed owner and mismatched captured bytes',async()=>{
    for(const failure of ['absent','running','owner','bytes'] as const){
      const f=fixture()
      if(failure==='absent')f.journal.jobStatus.mockResolvedValue({status:'unknown',reason:'journal_absence_requires_reconciliation'})
      if(failure==='running'&&f.status.status==='known')f.status.receipt.execution.process.processStopped=false
      if(failure==='owner')f.input.owner={grantId:randomUUID(),epoch:'1'}
      await expect(f.source.register(f.execution,f.input,f.intent,failure==='bytes'?Buffer.from('xx'):f.bytes,AbortSignal.timeout(10000))).rejects.toThrow()
      expect(f.retained.size).toBe(0)
    }
  })
  it('does not serve retained bytes when original closure authority disappears or signal aborts',async()=>{
    const f=fixture(),signal=AbortSignal.timeout(10000)
    await f.source.register(f.execution,f.input,f.intent,f.bytes,signal)
    const reader=await f.source.resolveSource(f.intent,signal)
    f.journal.jobStatus.mockResolvedValue({status:'unknown',reason:'journal_absence_requires_reconciliation'})
    await expect(reader.read(f.intent,0,2)).rejects.toMatchObject({code:'JOB_OUTPUT_CLOSURE_MISSING'})
    const abort=new AbortController();abort.abort()
    await expect(f.source.resolveSource(f.intent,abort.signal)).rejects.toThrow()
  })
})
