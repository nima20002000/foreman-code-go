import {
  CurrentRemoteExecutionRpcRequestSchema, REMOTE_EXECUTION_EXTENSION,
  type RemoteExecutionRpcRequest,
} from '@foreman-code/contracts/remote-execution-rpc'
import { DEVICE_APPLICATION_JSON_BYTES, type DeviceApplicationFailure, type DeviceApplicationResult,
  type DeviceExtensionDescriptor } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'

export interface TestWorkerOperation {
  id: string
  namespace: string
  payload: unknown
  bytes?: Uint8Array
  binding: Readonly<DeviceSessionBinding>
  signal: AbortSignal
}

export interface TestWorkerExtension extends DeviceExtensionDescriptor {
  handle?(operation: TestWorkerOperation): Promise<DeviceApplicationResult>
}

/** Expected native failures travel over the carrier; unexpected fixture errors fail the scenario. */
export class TestWorkerOperationError extends Error {
  readonly failure: DeviceApplicationFailure
  constructor(code: string, options?: ErrorOptions) {
    super(`The isolated worker operation failed: ${code}.`, options)
    this.failure = { code, class: 'permanent', retryable: false }
  }
}

/** Native operation scripts receive only contract-validated requests for this fresh pairing. */
export function remoteExecutionExtension(
  handle: (request: RemoteExecutionRpcRequest, operation: TestWorkerOperation) => Promise<DeviceApplicationResult>,
): TestWorkerExtension {
  return { namespace: REMOTE_EXECUTION_EXTENSION, version: 1, role: 'server',
    maxJsonBytes: DEVICE_APPLICATION_JSON_BYTES, maxBinaryBytes: 0, observationAdmission: true,
    async handle(operation) {
      const request = CurrentRemoteExecutionRpcRequestSchema.parse(operation.payload)
      const { placement, intent } = request
      const { binding } = operation
      if (placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== binding.deviceId
        || placement.mainId !== binding.mainId || intent.mainId !== binding.mainId
        || placement.registration?.workerInstallationId !== binding.workerInstallationId
        || placement.registration.keyRevision !== binding.keyRevision
        || placement.registration.authorizationRevision !== binding.authorizationRevision
        || intent.bindingHash !== placement.bindingHash
        || intent.runId !== placement.runId || intent.nodeId !== placement.nodeId) {
        throw new Error('The remote operation belongs to another approved worker placement.')
      }
      return handle(request, operation)
    } }
}
