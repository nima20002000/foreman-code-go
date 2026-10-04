import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceExtensionDescriptor } from '@foreman-code/contracts/device-application'
import type { TelemetrySelector, TelemetryOwner, TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
export interface TelemetryClock { monotonicMs(): number; unixMs(): number }
/** Implemented by existing W07/session and HRT local runtime owners. */
export interface TelemetrySessionAuthority {
  active(context: TrustedTelemetryContext, signal: AbortSignal): Promise<boolean>
  presence(context: TrustedTelemetryContext, signal: AbortSignal): Promise<'online' | 'offline'>
}
export interface TelemetryOwnershipView {
  selector: Extract<TelemetrySelector, { scope: 'owned' }>
  state: 'active' | 'ended' | 'closure-unconfirmed' | 'closed'
  /** Internal authorization inputs only; never returned on the wire. */
  sharedOwners: readonly TelemetryOwner[]
  /** False when a remote source cannot enumerate every component of a reported shared value. */
  sharedOwnersComplete?: boolean
}
/** Passive projection of existing accepted placement/attempt/lease/observed host. */
export interface TelemetryOwnershipAuthority {
  resolve(selector: Extract<TelemetrySelector, { scope: 'owned' }>, signal: AbortSignal): Promise<TelemetryOwnershipView | null>
}
export interface TelemetryReadAuthority {
  allow(principal: ManagementPrincipal, selector: TelemetrySelector, signal: AbortSignal): Promise<boolean>
  allowSharedOwner(principal: ManagementPrincipal, owner: TelemetryOwner, signal: AbortSignal): Promise<boolean>
}
/** W07 chunks this extension on its existing authenticated prioritized carrier. */
export const resourceTelemetryExtension: DeviceExtensionDescriptor = {
  namespace: 'resource-telemetry', version: 1, role: 'duplex', maxJsonBytes: 65_536, maxBinaryBytes: 0,
}
