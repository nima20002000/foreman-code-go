import type { DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import WebSocket from 'ws'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { deviceConnector } from './deviceCarrier.js'
/** Only the selected-main device credential enters this closure. */
export function createWorkerConnection(options: {
  pairing: { mainId: string; deviceId: string; workerInstallationId: string; keyRevision: number; authorizationRevision: number; endpoint: string; credential: string; mainPublicKeyFingerprint: string }
  bootId: string
  appVersion: string
  extensions?: DeviceExtensionRegistration[]
}) {
  return new DeviceConnectionSupervisor({
    identity: { mainId: options.pairing.mainId, deviceId: options.pairing.deviceId, workerInstallationId: options.pairing.workerInstallationId, keyRevision: options.pairing.keyRevision, authorizationRevision: options.pairing.authorizationRevision, bootId: options.bootId },
    appVersion: options.appVersion,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    mainPublicKeyFingerprint: options.pairing.mainPublicKeyFingerprint,
    connect: async (signal) => {
      return deviceConnector({ url: options.pairing.endpoint, credential: options.pairing.credential, create: (url, configuration) => new WebSocket(url, configuration) })(signal)
    },
    // Dispatch/transfer are disabled: there are no commands to replay at W07.
    reconcile: async () => {},
  })
}
