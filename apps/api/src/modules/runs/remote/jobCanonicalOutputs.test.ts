import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { ByteTransferPort, TransferIntent } from '@graphql/contracts/byte-transfer'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { createRemoteJobOutputCollector } from './jobCanonicalOutputs.js'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
describe('sealed job output collector with transfer doubles, no live publication claim',()=>{
 it('reads declared actual bytes and verifies transfer and canonical readback identities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'w08-output-'));roots.push(root);await writeFile(join(root,'result.txt'),'fresh output')
  const execution=jobExecution();execution.id=randomUUID();execution.attemptId=randomUUID();execution.operationId=randomUUID();execution.acceptedSpec.target.destination.canonicalProjectRoot=root;execution.acceptedSpec.outputs=[{path:'result.txt',required:true,mediaType:'text/plain'}]
  execution.acceptedSpec.target.hostRef={kind:'device',mainId:execution.acceptedSpec.target.mainId,deviceId:randomUUID()};execution.acceptedSpec.target.registration={workerInstallationId:randomUUID(),keyRevision:1,authorizationRevision:1}
  const ctx={mainId:execution.acceptedSpec.target.mainId,deviceId:execution.acceptedSpec.target.hostRef.deviceId,workerInstallationId:execution.acceptedSpec.target.registration.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:1}
  let intent:TransferIntent,offset=0;const received:Uint8Array[]=[]
  const progress=()=>({version:1 as const,transferId:intent.transferId,state:'transferring' as const,receivedInMemoryBytes:offset,durableOffset:offset,verifiedBytes:0,updatedAt:new Date().toISOString()})
  const receiver:ByteTransferPort={start:async i=>{intent=i;return progress()},status:async()=>progress(),append:async(_id,_ctx,chunk)=>{expect(chunk.offset).toBe(offset);received.push(chunk.bytes);offset+=chunk.bytes.length;return progress()},finish:async()=>({version:1,receiptId:randomUUID(),transferId:intent.transferId,intent,sha256:intent.sha256,byteSize:offset,verifiedAt:new Date().toISOString()}),cancel:async()=>({...progress(),state:'cancelled'})}
  let published=false
  const collect=createRemoteJobOutputCollector(receiver,{current:async()=>ctx,retryable:()=>false},{admit:async input=>({version:1,...ctx,transferId:randomUUID(),operationId:execution.operationId,executionId:execution.id,attemptId:execution.attemptId,placementHash:execution.acceptedSpec.bindingHash,rootId:randomUUID(),rootBindingRevision:1,direction:'to-main',byteClass:'artifact',sha256:input.sha256,byteSize:input.byteSize,manifestDigest:execution.acceptedSpec.outputSpecDigest,expiresAt:new Date(Date.now()+60000).toISOString(),chunkBytes:4}),publish:async input=>{const bytes=Buffer.concat(received);expect(bytes.toString()).toBe('fresh output');expect(createHash('sha256').update(bytes).digest('hex')).toBe(input.sha256);published=true;return{executionId:execution.id,publicationId:input.commandId,path:input.path,fileId:randomUUID(),revisionId:randomUUID(),sha256:input.sha256,byteSize:input.byteSize,mediaType:input.mediaType,state:'available'}}})
  await collect(execution);expect(published).toBe(true)
 })
})
