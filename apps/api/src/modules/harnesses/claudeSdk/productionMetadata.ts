import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { HarnessConfiguration } from '@graphql/contracts'
import type { HostHarnessOverride } from '@graphql/contracts/harness-registry'
import type { ClaudeQualificationPin } from '@graphql/contracts/claude-qualification'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { NativeProcessRegistry } from '../recovery/processRegistry.js'
import type { NativeHarnessFactories } from '../runtimeFactory.js'
import type { HarnessInstanceSettingsRepository } from '../instanceSettings/repository.js'
import { DomainError } from '../../errors.js'
import { commandInputHash } from '../../commands/postgres.js'
import { ClaudeCheckedNativeConfigurationPort } from './nativeConfiguration.js'
import { discoverClaudeMetadata } from './metadata.js'

export const detectedClaudeProfilePath = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')

export function productionClaudeMetadata(input: {
  registry: ProductionHarnessRegistry; processes: Pick<NativeProcessRegistry, 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>; settings: HarnessInstanceSettingsRepository
  factories: NativeHarnessFactories
  defaults(): Promise<{ claude?: Extract<HarnessConfiguration, { harness: 'claude' }> | undefined }>
  current(value: HostHarnessOverride, signal?: AbortSignal): Promise<{ pin: ClaudeQualificationPin }>
}) {
  return new ClaudeCheckedNativeConfigurationPort({
    async discover(workingDirectory, signal) {
      const configuration = (await input.defaults()).claude ?? { harness: 'claude' as const, model: 'default', authMode: 'subscription' as const,
        configDirectory: detectedClaudeProfilePath(), permissionMode: 'default' as const, sandbox: 'read-only' as const,
        tools: [], permissionRules: [], instructions: '', mcpServers: {} }
      if (configuration.authMode !== 'subscription') throw new DomainError('CLAUDE_API_KEY_DISCOVERY_UNAVAILABLE',
        'API-key metadata requires its explicitly provisioned host credential; a subscription login cannot authenticate this choice.', 409)
      const binding = input.registry.pinAccepted({ id: `claude-metadata:${commandInputHash(configuration)}`, agentId: 'owned-catalog', harness: configuration })
      const binary = binding.installation.launcher.resolvedLauncher
      if (!binary) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The installed Claude SDK executable is unavailable.', 409)
      const version = await input.factories.observeClaudeVersion(binding, workingDirectory, signal)
      const recovery = input.processes.reserveLaunch(`claude-metadata:${randomUUID()}`)
      const close = async () => {
        await input.processes.abandonReservedLaunch(recovery)
        if (!await input.processes.closeOwner(recovery.owner)) throw new Error('Claude metadata process closure is unconfirmed.')
      }
      try {
        const result = await discoverClaudeMetadata({ binary, profilePath: configuration.configDirectory, workingDirectory, recovery, signal })
        input.registry.installations.assertCurrent(binding)
        return { ...result, providerVersion: version.version }
      } finally { await close() }
    },
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
  })
}
