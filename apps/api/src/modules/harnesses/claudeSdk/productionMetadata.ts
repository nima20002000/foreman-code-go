import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { ClaudeQualificationPin } from '@foreman-code/contracts/claude-qualification'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { NativeProcessRegistry } from '../recovery/processRegistry.js'
import type { NativeHarnessFactories } from '../runtimeFactory.js'
import type { HarnessInstanceSettingsRepository } from '../instanceSettings/repository.js'
import { DomainError } from '../../errors.js'
import { commandInputHash } from '../../commands/postgres.js'
import { ClaudeCheckedNativeConfigurationPort } from './nativeConfiguration.js'
import { discoverClaudeMetadata } from './metadata.js'
import type { ProviderAccountResolver } from '../../provider-accounts/service.js'
import { ProviderAccountConfigurationService } from '../providerAccountConfiguration.js'
import { requireClaudeProductionCredentialDelivery } from './productionCredentials.js'

export const detectedClaudeProfilePath = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

export function productionClaudeMetadata(input: {
  registry: ProductionHarnessRegistry; processes: Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>; settings: HarnessInstanceSettingsRepository
  factories: NativeHarnessFactories
  defaults(): Promise<{ claude?: Extract<HarnessConfiguration, { harness: 'claude' }> | undefined }>
  current(value: HostHarnessOverride, signal?: AbortSignal): Promise<{ pin: ClaudeQualificationPin }>
  accounts?: ProviderAccountResolver
}) {
  type Metadata = Awaited<ReturnType<typeof discoverClaudeMetadata>>
  const pending = new Map<string, { value: Promise<Metadata>; controller: AbortController; readers: number }>()
  // Options depend only on the selected default profile and its exact installation, which are part of the key.
  // A result is reused for five minutes, then served while one background read refreshes it.
  const results = new Map<string, { at: number; value: Metadata; refreshing: boolean }>()
  const discover = async (workingDirectory: string, signal: AbortSignal, refresh = false): Promise<Metadata> => {
    signal.throwIfAborted()
    const requested = (await input.defaults()).claude ?? { harness: 'claude' as const, model: 'default', authMode: 'subscription' as const,
      configDirectory: detectedClaudeProfilePath(), permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
      tools: [], permissionRules: [], instructions: '', mcpServers: {} }
    const configuration = input.accounts
      ? await new ProviderAccountConfigurationService(input.accounts).resolve(requested) as Extract<HarnessConfiguration, { harness: 'claude' }>
      : requested
    const apiKey = await requireClaudeProductionCredentialDelivery(configuration, input.accounts)
    const binding = input.registry.pinAccepted({ id: `claude-metadata:${commandInputHash(configuration)}`, agentId: 'owned-catalog', harness: configuration })
    const binary = binding.installation.launcher.resolvedLauncher
    if (!binary) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The installed Claude SDK executable is unavailable.', 409)
    signal.throwIfAborted()
    input.registry.installations.assertCurrent(binding)
    const key = commandInputHash({ configuration, workingDirectory, selection: binding.selection,
      inventoryRevision: binding.inventoryRevision, installation: binding.installation })
    const cached = results.get(key)
    if (cached) {
      if (Date.now() - cached.at >= 300_000 && !cached.refreshing) {
        cached.refreshing = true
        void discover(workingDirectory, AbortSignal.timeout(60_000), true).catch(() => { if (results.get(key) === cached) results.delete(key) })
          .finally(() => { cached.refreshing = false })
      }
      if (!refresh) return structuredClone(cached.value)
    }
    let operation = pending.get(key)
    if (operation?.controller.signal.aborted) operation = undefined
    if (!operation) {
      const controller = new AbortController()
      const value = Promise.resolve().then(async () => {
        const version = await input.factories.observeClaudeVersion(binding, workingDirectory, controller.signal)
        controller.signal.throwIfAborted()
        const recovery = input.processes.reserveLaunch(`claude-metadata:${randomUUID()}`)
        const close = async () => {
          await input.processes.abandonReservedLaunch(recovery)
          if (!await input.processes.closeOwner(recovery.owner)) throw new Error('Claude metadata process closure is unconfirmed.')
        }
        try {
          const result = await discoverClaudeMetadata({ binary, model: configuration.model, profilePath: configuration.configDirectory,
            workingDirectory, recovery, signal: controller.signal, authMode: configuration.authMode,
            ...(configuration.accountId ? { accountId: configuration.accountId } : {}), ...(apiKey ? { apiKey } : {}) })
          input.registry.installations.assertCurrent(binding)
          return { ...result, providerVersion: version.version }
        } finally { await close() }
      }).finally(() => { if (pending.get(key) === operation) pending.delete(key) })
      operation = { value, controller, readers: 0 }
      pending.set(key, operation)
    }
    operation.readers++
    let abort!: () => void
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      const result = await Promise.race([operation.value, interrupted])
      signal.throwIfAborted()
      input.registry.installations.assertCurrent(binding)
      if (results.size >= 16 && !results.has(key)) results.delete(results.keys().next().value!)
      results.set(key, { at: Date.now(), value: result, refreshing: false })
      return structuredClone(result)
    } finally {
      signal.removeEventListener('abort', abort)
      operation.readers--
      if (!operation.readers && pending.get(key) === operation) {
        operation.controller.abort(signal.reason)
        await operation.value // The last caller retains owned cleanup/failure fencing.
      }
    }
  }
  return new ClaudeCheckedNativeConfigurationPort({
    discover: (workingDirectory, signal) => discover(workingDirectory, signal),
    async accepted(configuration, _directory, signal) {
      const binding = input.registry.pinAccepted({ id: `claude-configuration:${commandInputHash(configuration)}`, agentId: 'configuration-inspection', harness: configuration })
      const host = binding.selection.hostRef
      if (host.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH', 'Local Claude metadata cannot substitute for a device profile.', 409)
      const profiles = await input.settings.list(host, host.mainId)
      for (const override of profiles.filter(value => value.enabled && isDeepStrictEqual(value.configuration, configuration))) {
        const persistedProof = await input.registry.profileEvidence(override)
        if (!persistedProof) continue
        const current = await input.current(override, signal)
        return { override, persistedProof, currentBinding: { ...persistedProof, instanceId: override.instanceId, pin: current.pin } }
      }
      throw new DomainError('CLAUDE_PROFILE_SELECTION_REQUIRED', 'Check the saved Claude host profile before using this configuration.', 409)
    },
    invalidate() { results.clear() },
  })
}
