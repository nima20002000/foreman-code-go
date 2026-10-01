import type { DeviceApplicationFrame, DeviceExtensionDescriptor, DeviceNegotiatedExtension } from './deviceApplication.js'
import type { MainSignedIdentityProof } from './deviceIdentity.js'
/** Wire compatibility is independent of application and native-provider versions. */
export const DEVICE_PROTOCOL_VERSION = 1
export const DEVICE_FRAME_BYTES = 16_384
export const DEVICE_QUEUE_DEPTH = 32
export const DEVICE_BUFFER_BYTES = 65_536
export type DeviceConnectionPhase = 'disconnected' | 'offline' | 'connecting' | 'authenticating' | 'negotiating' | 'synchronizing' | 'ready' | 'backoff' | 'blocked'
export type DeviceFailureCode = 'authentication' | 'permission' | 'wrong-main' | 'incompatible-protocol' | 'malformed-frame' | 'backpressure' | 'timeout' | 'transport'
export interface DeviceSessionBinding {
  mainId: string
  deviceId: string
  workerInstallationId: string
  keyRevision: number
  authorizationRevision: number
  bootId: string
  connectionEpoch: string
  connectionGeneration: number
}
export interface DeviceHello extends DeviceSessionBinding {
  type: 'hello'
  protocolVersion: number
  appVersion: string
  nonce: string
  extensions?: DeviceExtensionDescriptor[]
}
export interface DeviceWelcome extends DeviceSessionBinding {
  type: 'welcome'
  protocolVersion: number
  appVersion: string
  mainIdentityProof: MainSignedIdentityProof
  capabilities: { heartbeat: true; dispatch: boolean; transfer: boolean; extensions?: DeviceNegotiatedExtension[] }
}
export type DeviceFrame = DeviceApplicationFrame | DeviceHello | DeviceWelcome | { type: 'ping' | 'pong' | 'ready'; connectionEpoch: string } | { type: 'blocked'; code: DeviceFailureCode }
export interface DeviceConnectionView {
  desired: boolean
  phase: DeviceConnectionPhase
  generation: number
  failure: DeviceFailureCode | null
}
