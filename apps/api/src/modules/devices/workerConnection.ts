import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { deviceConnector, type ClientDeviceSocket } from './deviceCarrier.js'
/** Only the selected-main device credential enters this closure. */
export function createWorkerConnection(options: {
  pairing: { mainId: string; deviceId: string; workerInstallationId: string; keyRevision: number; authorizationRevision: number; endpoint: string; credential: string }
  bootId: string
  appVersion: string
}) {
  return new DeviceConnectionSupervisor({
    identity: { mainId: options.pairing.mainId, deviceId: options.pairing.deviceId, workerInstallationId: options.pairing.workerInstallationId, keyRevision: options.pairing.keyRevision, authorizationRevision: options.pairing.authorizationRevision, bootId: options.bootId },
    appVersion: options.appVersion,
    connect: async (signal) => {
      // Root integrates pinned ws 8.22.0 into the worker artifact/lockfile.
      const dependency = 'ws'
      const { default: WebSocket } = await import(dependency) as { default: new (url: string, options: Parameters<Parameters<typeof deviceConnector>[0]['create']>[1]) => ClientDeviceSocket }
      return deviceConnector({ url: options.pairing.endpoint, credential: options.pairing.credential, create: (url, configuration) => new WebSocket(url, configuration) })(signal)
    },
    // Dispatch/transfer are disabled: there are no commands to replay at W07.
    reconcile: async () => {},
  })
}
