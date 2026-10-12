import { CI_HOST_NAMESPACE, CiHostStatusSchema, type CiHostStatus } from '@foreman-code/contracts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DomainError } from '../errors.js'
import { canonical } from '../jobs/digest.js'

export async function readHostCiStatus(endpoint: DeviceEndpoint,
  target: DeviceProvisioningTarget): Promise<CiHostStatus | null> {
  if (target.hostRef.kind !== 'device') return null
  const deviceId = target.hostRef.deviceId
  const channel = endpoint.captureRequest(deviceId, CI_HOST_NAMESPACE)
  if (!channel) return null
  const matches = () => channel.binding.workerInstallationId === target.applicationInstallationId
    && channel.binding.keyRevision === target.keyRevision
    && channel.binding.authorizationRevision === target.authorizationRevision
    && canonical(channel.binding) === canonical(endpoint.currentBinding(deviceId))
  if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
  const result = await channel.request({ operation: 'status' }, { timeoutMs: 30_000 })
  if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
  return CiHostStatusSchema.parse(result.payload)
}
