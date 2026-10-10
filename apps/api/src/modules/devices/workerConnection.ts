import { deviceTlsOptions } from '@foreman-code/contracts/device-tls-node'
import type { DeviceTlsTrust } from '@foreman-code/contracts/device-identity'
import type { DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import WebSocket from 'ws'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { deviceConnector } from './deviceCarrier.js'
/** Only the selected-main device credential enters this closure. */
export function createWorkerConnection(options: {
  pairing: { mainId: string; deviceId: string; workerInstallationId: string; keyRevision: number; authorizationRevision: number; endpoint: string; credential: string; mainPublicKeyFingerprint: string;tlsTrust?:DeviceTlsTrust }
  bootId: string
  appVersion: string
  extensions?: DeviceExtensionRegistration[]
  /** Synchronous admission revocation; caller tracks/join its physical drain. */
  onBindingLost?(binding: Readonly<import('@foreman-code/contracts/device-connection').DeviceSessionBinding>): void
  onReady?(): void
}) {
  let original: Readonly<import('@foreman-code/contracts/device-connection').DeviceSessionBinding> | undefined
  const connection = new DeviceConnectionSupervisor({
    identity: { mainId: options.pairing.mainId, deviceId: options.pairing.deviceId, workerInstallationId: options.pairing.workerInstallationId, keyRevision: options.pairing.keyRevision, authorizationRevision: options.pairing.authorizationRevision, bootId: options.bootId },
    appVersion: options.appVersion,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    mainPublicKeyFingerprint: options.pairing.mainPublicKeyFingerprint,
    connect: async (signal) => {
      return deviceConnector({ url: options.pairing.endpoint, credential: options.pairing.credential, create: (url, configuration) => new WebSocket(url, {...configuration,...deviceTlsOptions(options.pairing.tlsTrust)}) })(signal)
    },
    // Dispatch/transfer are disabled: there are no commands to replay at W07.
    reconcile: async () => {},
    onState: view => {
      if (view.phase === 'ready') {
        original = connection.currentBinding()
        options.onReady?.()
      }
      else if (original) {
        const lost = original; original = undefined
        options.onBindingLost?.(lost)
      }
    },
  })
  return connection
}
