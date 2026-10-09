import type { PayloadFingerprintCache } from './payloadFingerprintCache.js'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { HarnessRegistryReadbackSchema, type HostHarnessInstallationDto,
  type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../errors.js'
import { readInstalledWorkflowConfiguration,
  type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { discoverInstalledClaudeSdk, installedClaudeSdkEntrypoint } from './claudeSdk/currentPin.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import type { TargetEnvironment, LauncherEvidence } from './hostDiscovery.js'

export interface InstalledClaudeTarget {
  binding: DeviceSessionBinding
  target: HostHarnessOverride['target']
  installation: HostHarnessInstallationDto & { launcher: LauncherEvidence }
  sdk: ReturnType<typeof installedClaudeSdkEntrypoint>
}

/** File inspection publishes SDK identity; it does not execute the CLI or qualify a profile. */
export async function inspectInstalledClaude(input: {
  binding: Readonly<DeviceSessionBinding>
  configuration: InstalledWorkflowConfigurationLocation | null
  environment: NodeJS.ProcessEnv
  cwd: string
  signal: AbortSignal
  fingerprintCache?: PayloadFingerprintCache
}) {
  input.signal.throwIfAborted()
  if (!isAbsolute(input.cwd)) throw new DomainError('HARNESS_INVENTORY_STALE', 'Worker directory is invalid.', 409)
  const binding = DeviceSessionBindingSchema.parse(input.binding)
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const inventory = HarnessRegistryReadbackSchema.parse({ instances: [], installations: [], hostMetadata: {
    hostRef, applicationInstallationId: binding.workerInstallationId, connection: null,
    platform: { platform: process.platform, architecture: process.arch }, workspaceRoots: null,
  } })
  const configuration = await readInstalledWorkflowConfiguration(input.configuration)
  if (!configuration?.claude) return { inventory, currentTarget: null }
  const generation = () => commandInputHash({ path: input.environment.PATH ?? '', cwd: input.cwd, node: process.execPath,
    platform: process.platform, architecture: process.arch, nodeOptions: input.environment.NODE_OPTIONS ?? '' })
  const environment: TargetEnvironment = { path: input.environment.PATH ?? '', cwd: input.cwd,
    provenance: 'worker', generation: generation() }
  const sdk = installedClaudeSdkEntrypoint(configuration.claude.installedLockPath, configuration.claude.binary,
    configuration.claude.sdkEntrypoint)
  const harnessInstallationId = commandInputHash({ hostRef, driverId: 'claude', launcher: configuration.claude.binary })
  const context = { harnessInstallationId, environment }
  const before = await discoverInstalledClaudeSdk(sdk, context, input.signal, input.fingerprintCache)
  const after = await discoverInstalledClaudeSdk(sdk, context, input.signal, input.fingerprintCache)
  const current = await readInstalledWorkflowConfiguration(input.configuration)
  input.signal.throwIfAborted()
  if (before.launcher.fingerprint !== after.launcher.fingerprint || before.sdkVersion !== after.sdkVersion
    || before.sdkIntegrity !== after.sdkIntegrity || !isDeepStrictEqual(configuration, current)
    || !isDeepStrictEqual(binding, input.binding) || environment.generation !== generation()) {
    throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed Claude SDK changed during inspection.', 409)
  }
  const installation: InstalledClaudeTarget['installation'] = {
    hostRef, harnessInstallationId, installationFingerprint: after.launcher.fingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: after.declaration.protocolRevision,
    environmentGeneration: environment.generation, connectionGeneration: harnessConnectionGeneration(binding),
    launcher: after.launcher, claudeSdk: { version: after.sdkVersion, integrity: after.sdkIntegrity },
    observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: false,
  }
  inventory.installations.push(installation)
  const currentTarget: InstalledClaudeTarget = { binding, installation, sdk, target: {
    hostRef, applicationInstallationId: binding.workerInstallationId,
    harnessInstallationId, installationFingerprint: installation.installationFingerprint!,
  } }
  return { inventory: HarnessRegistryReadbackSchema.parse(inventory), currentTarget }
}
