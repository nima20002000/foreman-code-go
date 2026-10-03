import type pg from 'pg'
import type { PostgresJobDispatch } from '../../jobs/dispatch.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { FileByteStorage } from '../storage.js'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { JobInputAuthority } from './authority.js'
import { CanonicalJobInputs } from './service.js'
import { ReadonlyJobInputDelivery } from './delivery.js'
import { jobInputDeviceExtension } from './channel.js'
/** Actual existing canonical store/ownership/preparation/W07 services; no worker DB handle or caller bytes. */
export function createCanonicalJobInputPorts(input:{pool:pg.Pool;storageRoot:string;runtime:PostgresJobDispatch;endpoint:Pick<DeviceEndpoint,'currentBinding'>;receiptRoot:string;clock?:()=>Date}){
  const authority=new JobInputAuthority(input.pool,input.runtime,input.clock)
  const main=new CanonicalJobInputs(input.pool,authority,new FileByteStorage(input.storageRoot,MAX_FILE_BYTES),input.endpoint,input.clock)
  const local=new ReadonlyJobInputDelivery({admit:(execution,signal)=>{signal.throwIfAborted();return main.bind(execution)},recheck:(execution,admission,signal)=>{signal.throwIfAborted();return main.recheck(execution,admission)},read:(execution,admission,path,offset,length,signal)=>{signal.throwIfAborted();return main.read(execution,admission,path,offset,length)}},input.receiptRoot)
  return {main,local,extension:jobInputDeviceExtension(main),validateDeclaredJobInputs:authority.validateDeclaredJobInputs.bind(authority)}
}
export { createWorkerJobInputPort } from './workerFactory.js'
