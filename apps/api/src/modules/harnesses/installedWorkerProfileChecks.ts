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
import { createInstalledNativeQualifier } from './installedNativeQualification.js'
import { inspectInstalledOpenCode } from './installedOpenCodeInspection.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './opencodeServer.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { createInstalledClaudeQualifier } from './installedClaudeQualification.js'

export async function createInstalledWorkerProfileChecks(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  pairing: WorkerPairingConfiguration
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
}) {
  const configuration = await readInstalledWorkflowConfiguration(input.configuration)
  if (!configuration) return null
  const qualifiers = new Set<ReturnType<typeof createInstalledNativeQualifier>>()
  const claude = createInstalledClaudeQualifier(input)
  let closing = false
  const extension = createHostHarnessProfileCheckExtension({
    hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
    applicationInstallationId: input.pairing.workerInstallationId,
    qualifierForBinding: binding => ({ async qualify(value, request) {
      if (closing || !isDeepStrictEqual(input.current(), binding)) {
        throw new DomainError('HARNESS_INVENTORY_STALE', 'The profile check connection changed.', 409)
      }
      const harness = value.configuration.harness
      if (harness === 'claude') return claude.qualify(value, request)
      if (harness !== 'codex' && harness !== 'opencode') throw new DomainError(
        'HARNESS_DRIVER_UNAVAILABLE', 'The installed native profile checker does not support this driver.', 409)
      if (harness === 'opencode' && !configuration.opencode) throw new DomainError(
        'HARNESS_DRIVER_UNAVAILABLE', 'Select the installed OpenCode binary before checking its profile.', 409)
      const inspect = harness === 'codex' ? inspectInstalledCodex : inspectInstalledOpenCode
      const qualifier = createInstalledNativeQualifier({ harness,
        binding, trustedCurrentBinding: input.current,
        inspect: (current, signal) => inspect({ binding: current,
          configuration: input.configuration, environment: process.env, cwd: input.stateDirectory, signal }),
        registry: input.registry, workingRoot: input.stateDirectory, environment: process.env,
        checkConfiguration: async (profile, directory, signal, recovery, assertInstallation) => {
          const guarded = async <T>(work: () => Promise<T>, effectSignal = signal): Promise<T> => {
            await assertInstallation(effectSignal)
            const result = await work()
            await assertInstallation(effectSignal)
            return result
          }
          const settings = profile.configuration
          if (settings.harness === 'opencode') {
            const selected = configuration.opencode
            if (!selected) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The installed OpenCode selection is missing.', 409)
            const server = new ManagedOpenCodeServer({ binary: selected.binary, workingDirectory: directory,
              ownerAgentId: `profile-check:${request.checkId}`, appMcpAccess: 'none', processRecovery: recovery,
              ...(settings.advanced ? { advancedConfiguration: settings.advanced } : {}),
              assertInstallation: effectSignal => assertInstallation(effectSignal) })
            const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: `profile-check:${request.checkId}`,
              appMcpAccess: 'none' })
            try { return await guarded(() => manager.qualifyConfiguration(settings, directory, signal)) }
            finally { await manager.dispose() }
          }
          if (profile.configuration.harness !== 'codex') throw new DomainError('HARNESS_DRIVER_UNAVAILABLE',
            'The selected driver has no installed profile checker.', 409)
          const manager = new CodexAppServerSessionManager(configuration.codexBinary, configuration.expectedVersion,
            undefined, recovery, 'none', undefined, {
              mode: 'native',
              qualify: (binary, cwd, environment, authenticated, effectSignal) => guarded(
                () => qualifyCodex(binary, cwd, environment, authenticated, effectSignal, recovery), effectSignal),
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
    await claude.close()
    const results = await Promise.allSettled([...qualifiers].map(qualifier => qualifier.close()))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Worker profile checks did not close.')
  } }
}
