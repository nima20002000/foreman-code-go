import { HarnessConfigurationSchema } from '@graphql/contracts'
import { HarnessRegistryReadbackSchema, type ConfiguredHarnessInstanceDto, type HarnessRegistryReadback, type HarnessHostInventoryMetadata } from '@graphql/contracts/harness-registry'
import type { HarnessInstanceProjection } from './instanceRegistry.js'
import type { HarnessInstallationRecord } from './installationRegistry.js'

/** Public readback contains recognized typed config only, never opaque driver input. */
export function projectHarnessInstance(instance: HarnessInstanceProjection): ConfiguredHarnessInstanceDto {
  const configuration = HarnessConfigurationSchema.safeParse(instance.configuration)
  return { instanceId: instance.instanceId, instanceRevision: instance.instanceRevision, driverId: instance.driverId,
    enabled: instance.enabled, availability: instance.availability,
    configuration: configuration.success ? configuration.data : null,
    ...(instance.driverRevision ? { driverRevision: instance.driverRevision } : {}) }
}
export function projectHarnessRegistry(instances: readonly HarnessInstanceProjection[], installations: readonly HarnessInstallationRecord[], hostMetadata?: HarnessHostInventoryMetadata): HarnessRegistryReadback {
  return HarnessRegistryReadbackSchema.parse({ instances: instances.map(projectHarnessInstance), installations: structuredClone(installations),
    ...(hostMetadata ? { hostMetadata: structuredClone(hostMetadata) } : {}) })
}
