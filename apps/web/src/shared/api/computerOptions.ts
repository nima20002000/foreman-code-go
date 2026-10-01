import type { CanonicalMachineReference, DeviceRegistration } from '@graphql/contracts/device-identity'

/** Presentation only. Registration is not a dispatch capability or a saved placement pin. */
export type RegisteredComputerOption = {
  hostRef: Extract<CanonicalMachineReference, { kind: 'device' }>
  applicationInstallationId: string
  label: string
  registrationStatus: DeviceRegistration['status']
  executionEligibility: 'unknown'
}
export function registeredComputerOptions(mainId: string, devices: readonly DeviceRegistration[]): RegisteredComputerOption[] {
  return devices.filter(value => value.mainId === mainId).map(value => ({
    hostRef: { kind: 'device', mainId, deviceId: value.deviceId },
    applicationInstallationId: value.workerInstallationId,
    label: value.deviceId, registrationStatus: value.status,
    executionEligibility: 'unknown',
  }))
}
