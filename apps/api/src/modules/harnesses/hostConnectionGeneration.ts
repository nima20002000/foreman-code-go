import { createHash } from 'node:crypto'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'

/** Derived fencing evidence from W07's actual authenticated binding, not another host identity. */
export function harnessConnectionGeneration(binding: Readonly<DeviceConnectionIdentity & { connectionEpoch: string }>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    binding.mainId, binding.deviceId, binding.workerInstallationId, binding.keyRevision, binding.authorizationRevision,
    binding.bootId, binding.connectionEpoch, binding.connectionGeneration,
  ])).digest('hex')}`
}
