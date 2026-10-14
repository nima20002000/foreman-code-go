import { createHash } from 'node:crypto'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'

/** Derived fencing evidence from W07's actual authenticated binding, not another host identity. Harness facts
 * belong to the paired Worker boot: a transport reconnect keeps them; a restart, re-pair or revocation does not. */
export function harnessConnectionGeneration(binding: Readonly<DeviceConnectionIdentity & { connectionEpoch: string }>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    binding.mainId, binding.deviceId, binding.workerInstallationId, binding.keyRevision, binding.authorizationRevision,
    binding.bootId,
  ])).digest('hex')}`
}
