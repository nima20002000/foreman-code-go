/** Application namespaces share the authenticated W07 socket, never workflow authority. */
export const DEVICE_APPLICATION_JSON_BYTES = 1_048_576
export const DEVICE_APPLICATION_BINARY_BYTES = 1_048_576
export const DEVICE_APPLICATION_CHUNK_BYTES = 8_192
export const DEVICE_APPLICATION_CHUNK_WINDOW = 4
export const DEVICE_APPLICATION_IN_FLIGHT = 8
export const DEVICE_APPLICATION_STOP_IN_FLIGHT = 1
export const DEVICE_APPLICATION_STOP_BYTES = 16_384
export const DEVICE_APPLICATION_BUFFER_BYTES = 4_194_304
export type DeviceExtensionRole = 'client' | 'server' | 'duplex'
export interface DeviceExtensionDescriptor {
  namespace: string
  version: number
  role: DeviceExtensionRole
  maxJsonBytes: number
  maxBinaryBytes: number
}
export interface DeviceNegotiatedExtension {
  namespace: string
  version: number
  mainCanRequest: boolean
  workerCanRequest: boolean
  maxJsonBytes: number
  maxBinaryBytes: number
}
export type DeviceApplicationFrame =
  | { type: 'application-open'; id: string; namespace: string; version: number; kind: 'request' | 'response' | 'error'; jsonBytes: number; binaryBytes: number; admission?: 'stop' }
  | { type: 'application-chunk'; id: string; offset: number; data: string }
  | { type: 'application-ack'; id: string; offset: number }
  | { type: 'application-cancel'; id: string }
  | { type: 'application-reject'; id: string; code: 'backpressure' }
export interface DeviceApplicationResult { payload: unknown; bytes?: Uint8Array }
export interface DeviceApplicationFailure {
  code: string
  /** Availability hint; operation retries still require their owner and idempotency checks. */
  retryable: boolean
}

export function parseExtensionDescriptors(value: unknown): DeviceExtensionDescriptor[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid device extensions')
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid device extension')
    const descriptor = item as DeviceExtensionDescriptor
    if (!/^[a-z][a-z0-9:-]{0,63}$/.test(descriptor.namespace) || seen.has(descriptor.namespace)
      || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1
      || !['client', 'server', 'duplex'].includes(descriptor.role)
      || !Number.isSafeInteger(descriptor.maxJsonBytes) || descriptor.maxJsonBytes < 256 || descriptor.maxJsonBytes > DEVICE_APPLICATION_JSON_BYTES
      || !Number.isSafeInteger(descriptor.maxBinaryBytes) || descriptor.maxBinaryBytes < 0 || descriptor.maxBinaryBytes > DEVICE_APPLICATION_BINARY_BYTES) throw new Error('Invalid device extension')
    seen.add(descriptor.namespace)
    return { namespace: descriptor.namespace, version: descriptor.version, role: descriptor.role, maxJsonBytes: descriptor.maxJsonBytes, maxBinaryBytes: descriptor.maxBinaryBytes }
  }).sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0)
}
export function negotiateDeviceExtensions(main: DeviceExtensionDescriptor[], worker: DeviceExtensionDescriptor[]): DeviceNegotiatedExtension[] {
  return main.flatMap((local) => {
    const peer = worker.find((item) => item.namespace === local.namespace && item.version === local.version)
    if (!peer) return []
    const mainCanRequest = local.role !== 'server' && peer.role !== 'client'
    const workerCanRequest = peer.role !== 'server' && local.role !== 'client'
    if (!mainCanRequest && !workerCanRequest) return []
    return [{ namespace: local.namespace, version: local.version, mainCanRequest, workerCanRequest, maxJsonBytes: Math.min(local.maxJsonBytes, peer.maxJsonBytes), maxBinaryBytes: Math.min(local.maxBinaryBytes, peer.maxBinaryBytes) }]
  }).sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0)
}
