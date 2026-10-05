import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { DomainError } from '../errors.js'
import { readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { CodexAppServerSessionManager } from './codexAppServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { runCommand } from './process.js'
import { createHostHarnessProfileCheckExtension } from './instanceSettings/profileChannel.js'
import { inspectInstalledCodex } from './installedCodexInspection.js'
import { createInstalledCodexNativeQualifier } from './installedCodexNativeQualification.js'
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
  const qualifiers = new Set<ReturnType<typeof createInstalledCodexNativeQualifier>>()
  let closing = false
  const extension = createHostHarnessProfileCheckExtension({
    hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
    applicationInstallationId: input.pairing.workerInstallationId,
    qualifierForBinding: binding => ({ async qualify(value, request) {
      if (closing || !isDeepStrictEqual(input.current(), binding)) {
        throw new DomainError('HARNESS_INVENTORY_STALE', 'The profile check connection changed.', 409)
      }
      const qualifier = createInstalledCodexNativeQualifier({
        binding, trustedCurrentBinding: input.current,
        inspect: (current, signal) => inspectInstalledCodex({ binding: current,
          configuration: input.configuration, environment: process.env, cwd: input.stateDirectory, signal }),
        registry: input.registry, workingRoot: input.stateDirectory, environment: process.env,
        checkConfiguration: async (profile, directory, signal, recovery, assertInstallation) => {
          if (profile.configuration.harness !== 'codex') throw new DomainError(
            'HARNESS_DRIVER_UNAVAILABLE', 'This Worker profile uses the installed Codex harness.', 409)
          const guarded = async <T>(work: () => Promise<T>, effectSignal = signal): Promise<T> => {
            await assertInstallation(effectSignal)
            const result = await work()
            await assertInstallation(effectSignal)
            return result
          }
          const manager = new CodexAppServerSessionManager(configuration.codexBinary, configuration.expectedVersion,
            undefined, recovery, 'none', undefined, {
              mode: 'native',
              qualify: (binary, version, cwd, environment, authenticated, effectSignal) => guarded(
                () => qualifyCodex(binary, version, cwd, environment, authenticated, effectSignal, recovery), effectSignal),
              assertUnchanged: qualified => guarded(() => assertCodexUnchanged(qualified)),
              runCommand: (binary, args, cwd, effectSignal, environment, options) => guarded(
                () => runCommand(binary, args, cwd, effectSignal, environment, { ...options, recovery }), effectSignal),
              qualifyModel: (settings, binary, cwd, environment, effectSignal, _recovery, inspection) => guarded(
                () => qualifyNativeCodexModel(settings, binary, cwd, environment, effectSignal, recovery, inspection), effectSignal),
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
