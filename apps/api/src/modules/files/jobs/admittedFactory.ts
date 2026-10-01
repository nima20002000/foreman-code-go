import type pg from 'pg'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { createCanonicalJobArtifactPort } from './factory.js'
import { PostgresJobOutputAdmission } from './outputAdmission.js'
import { VerifiedJobOutputReader } from './transferReader.js'
import { jobOutputDeviceExtension } from './outputChannel.js'

/** Complete main admission/receiver/resolver/canonical publication composition. No permissive hooks. */
export function createAdmittedJobOutputs(input: {pool:pg.Pool;storageRoot:string;stagingRoot:string;
  endpoint:Pick<DeviceEndpoint,'currentBinding'>;authority:JobPublicationAuthority;excludedRoots?:readonly string[];clock?:()=>Date}) {
  const admission=new PostgresJobOutputAdmission(input.pool,input.authority,input.endpoint,(request,source)=>artifacts.reserveAccepted(request,source),input.clock)
  const receiver=new ResumableByteTransferService(input.stagingRoot,{authorize:(intent,context)=>admission.authorizeTransfer(intent,context)},()=>input.clock?.().getTime()??Date.now())
  const artifacts=createCanonicalJobArtifactPort({pool:input.pool,storageRoot:input.storageRoot,
    ...(input.excludedRoots?{excludedRoots:input.excludedRoots}:{}),...(input.clock?{clock:input.clock}:{}),
    authority:{authorizePublication:async(sql,request)=>{const actual=await input.authority.authorizePublication(sql,request);await admission.assertContext(sql,request,actual.execution);return actual}},
    reader:new VerifiedJobOutputReader(receiver,admission)})
  return {admission,receiver,artifacts,extension:jobOutputDeviceExtension(admission,artifacts,receiver)}
}
