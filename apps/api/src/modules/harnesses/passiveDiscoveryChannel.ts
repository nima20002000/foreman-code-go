import { HARNESS_DISCOVERY_NAMESPACE, HarnessDiscoveryRequestSchema, HarnessRegistryReadbackSchema, type HarnessRegistryReadback } from '@graphql/contracts/harness-registry'
import type { DeviceConnectionIdentity, CanonicalMachineReference } from '@graphql/contracts/device-identity'
import { discoverLauncher, type TargetEnvironment } from './hostDiscovery.js'

export interface PassiveDriverInstallationDeclaration {
  readonly driverId: string
  readonly driverRevision: string
  readonly protocolRevision: string
  readonly harnessInstallationId: string
  readonly requestedLauncher: string
  readonly payloadPaths?: readonly string[]
}
interface PassiveDiscoveryContext { binding: DeviceConnectionIdentity; signal: AbortSignal }

/** Register only this actual worker handler; no caller-supplied paths or commands are accepted. */
export function createPassiveHarnessDiscoveryExtension(options: {
  hostRef: Extract<CanonicalMachineReference, { kind: 'device' }>
  applicationInstallationId: string
  environment: TargetEnvironment
  platform: { platform: string; architecture: string }
  installations: readonly PassiveDriverInstallationDeclaration[]
}) {
  return {
    namespace: HARNESS_DISCOVERY_NAMESPACE, version: 1, role: 'server' as const, maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload: unknown, { binding, signal }: PassiveDiscoveryContext): Promise<{ payload: HarnessRegistryReadback }> {
      HarnessDiscoveryRequestSchema.parse(payload)
      signal.throwIfAborted()
      if (binding.mainId !== options.hostRef.mainId || binding.deviceId !== options.hostRef.deviceId
        || binding.workerInstallationId !== options.applicationInstallationId) throw new Error('Passive discovery host binding mismatch.')
      const installations = []
      for (const declaration of options.installations) {
        const launcher = await discoverLauncher(declaration.requestedLauncher, options.environment, declaration.payloadPaths ?? [], signal)
        installations.push({ hostRef: options.hostRef, harnessInstallationId: declaration.harnessInstallationId,
          installationFingerprint: launcher.fingerprint, driverId: declaration.driverId, driverRevision: declaration.driverRevision,
          protocolRevision: declaration.protocolRevision, environmentGeneration: options.environment.generation,
          connectionGeneration: String(binding.connectionGeneration), launcher, observedVersion: null,
          installed: launcher.status === 'installed', authenticated: null, compatible: null, qualified: null })
      }
      signal.throwIfAborted()
      return { payload: HarnessRegistryReadbackSchema.parse({ instances: [], installations,
        hostMetadata: { hostRef: options.hostRef, applicationInstallationId: options.applicationInstallationId,
          platform: options.platform, workspaceRoots: null } }) }
    },
  }
}
