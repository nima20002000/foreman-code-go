import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { createSourceOperationWorkerHandler, type SourceOperationWorkerOptions } from './operationWorker.js'

/** HRT-C/worker packager mounts this on the existing W07 channel. Supplying the
 * actual pairing/approved-root loader and Main owner resolver is mandatory. */
export function createWorkerSourceOperationExtension(options: SourceOperationWorkerOptions): DeviceExtensionRegistration {
  const handle = createSourceOperationWorkerHandler(options)
  return { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
    const response = await handle(payload, context)
    context.signal.throwIfAborted(); return { payload: response }
  } }
}
