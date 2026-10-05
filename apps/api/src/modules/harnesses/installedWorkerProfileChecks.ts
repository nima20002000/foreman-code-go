import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { DomainError } from '../errors.js'
import { installedHarnessSelection, readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { CodexAppServerSessionManager } from './codexAppServer.js'
import { OpenCodeNativeSessionManager, ManagedOpenCodeServer } from './opencodeServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { runCommand } from './process.js'
import { createHostHarnessProfileCheckExtension } from './instanceSettings/profileChannel.js'
import { inspectInstalledHarness } from './installedCodexInspection.js'
import { createInstalledHarnessNativeQualifier } from './installedCodexNativeQualification.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'

export async function createInstalledWorkerProfileChecks(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  pairing: WorkerPairingConfiguration
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
}) {
  const configuration = await readInstalledWorkflowConfiguration(input.configuration)
  if (!configuration) return null
  const qualifiers = new Set<ReturnType<typeof createInstalledHarnessNativeQualifier>>()
  let closing = false
  const extension = createHostHarnessProfileCheckExtension({
    hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
    applicationInstallationId: input.pairing.workerInstallationId,
    qualifierForBinding: binding => ({ async qualify(value, request) {
      if (closing || !isDeepStrictEqual(input.current(), binding)) {
        throw new DomainError('HARNESS_INVENTORY_STALE', 'The profile check connection changed.', 409)
      }
      const harness = value.configuration.harness
      if (harness !== 'codex' && harness !== 'opencode') throw new DomainError(
        'HARNESS_DRIVER_UNAVAILABLE', 'This Worker does not have that installed harness.', 409)
      const selection = installedHarnessSelection(configuration, harness)
      if (!selection) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The selected Worker harness is not installed.', 409)
      const qualifier = createInstalledHarnessNativeQualifier({
        harness, binding, trustedCurrentBinding: input.current,
        inspect: (current, signal) => inspectInstalledHarness({ harness, binding: current,
          configuration: input.configuration, environment: process.env, cwd: input.stateDirectory, signal }),
        registry: input.registry, workingRoot: input.stateDirectory, environment: process.env,
        checkConfiguration: async (profile, directory, signal, recovery, assertInstallation) => {
          if (profile.configuration.harness === 'opencode') {
            const server = new ManagedOpenCodeServer({ binary: selection.binary, workingDirectory: directory,
              ownerAgentId: 'qualification', processRecovery: recovery, appMcpAccess: 'none',
              assertInstallation, ...(profile.configuration.advanced ? { advancedConfiguration: profile.configuration.advanced } : {}) })
            const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'qualification', appMcpAccess: 'none' })
            try {
              await assertInstallation(signal)
              const result = await manager.qualifyConfiguration(profile.configuration, directory, signal)
              await assertInstallation(signal)
              return result
            } finally {
              await manager.dispose()
            }
          }
          if (profile.configuration.harness !== 'codex') throw new DomainError(
            'HARNESS_DRIVER_UNAVAILABLE', 'This Worker profile has no installed native harness.', 409)
          const guarded = async <T>(work: () => Promise<T>, effectSignal = signal): Promise<T> => {
            await assertInstallation(effectSignal)
            const result = await work()
            await assertInstallation(effectSignal)
            return result
          }
          const manager = new CodexAppServerSessionManager(selection.binary, selection.expectedVersion,
            undefined, recovery, 'none', undefined, {
              mode: 'native',
              qualify: (binary, version, cwd, environment, authenticated, effectSignal) => guarded(
                () => qualifyCodex(binary, version, cwd, environment, authenticated, effectSignal, recovery), effectSignal),
              assertUnchanged: qualified => guarded(() => assertCodexUnchanged(qualified)),
              runCommand: (binary, args, cwd, effectSignal, environment, options) => guarded(
                () => runCommand(binary, args, cwd, effectSignal, environment, { ...options, recovery }), effectSignal),
              qualifyModel: (settings, binary, cwd, environment, effectSignal) => guarded(
                () => qualifyNativeCodexModel(settings, binary, cwd, environment, effectSignal, recovery), effectSignal),
            })
          try {
            return await manager.qualifyConfiguration(profile.configuration, directory, signal)
          } finally {
            await manager.dispose()
          }
        },
      })
      qualifiers.add(qualifier)
      try {
        return await qualifier.qualify(value, request)
      } finally {
        await qualifier.close()
        qualifiers.delete(qualifier)
      }
    } }),
  })
  return { extension, async close() {
    closing = true
    const results = await Promise.allSettled([...qualifiers].map(qualifier => qualifier.close()))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Worker profile checks did not close.')
  } }
}
