import type { HarnessConfiguration, OpenCodeAdvancedConfiguration } from '@graphql/contracts'
import { DomainError } from '../errors.js'
import { HarnessInstanceRegistry, localHarnessDrivers, type ConfiguredHarnessInstance } from './instanceRegistry.js'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from './codexAppServer.js'
import type { CodexChatFiles } from './codexFiles/runtime.js'
import { codexMcpInspectorAdapter } from './codexMcpInspectorAdapter.js'
import type { NativeMcpInspector } from './mcpDetection.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from './opencodeServer.js'
import type { ManagedOpenCodeServerOptions, OpenCodeServerController } from './opencodeTransport.js'
import type { OpenCodeChatFiles } from './opencodeFiles/chat.js'
import { openCodeMcpInspectorAdapter } from './opencodeMcpInspectorAdapter.js'
import type { NativeHarnessSessionManager } from './port.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { NativeResponseJournal } from './recovery/responseJournal.js'

export type HarnessRuntimeRole = 'workflow' | 'operator' | 'agent-chat' | 'diagnostics' | 'qualification'
interface AllocationContext {
  role: HarnessRuntimeRole
  configured?: ConfiguredHarnessInstance
  workingDirectory: string
  ownerAgentId: string
  processRecovery?: NativeProcessRecovery
  appMcpAccess: 'scoped' | 'none'
  credentialEnvironmentVariable?: string
}
export type NativeHarnessAllocation = AllocationContext & (
  | { harness: 'codex'; chatFiles?: CodexChatFiles }
  | { harness: 'opencode'; advancedConfiguration?: OpenCodeAdvancedConfiguration
    chatFiles?: (server: OpenCodeServerController) => OpenCodeChatFiles }
)
export type NativeHarnessAllocationResult =
  | { harness: 'codex'; manager: CodexAppServerSessionManager; inspector: NativeMcpInspector }
  | { harness: 'opencode'; manager: OpenCodeNativeSessionManager; inspector: NativeMcpInspector }

type OpenCodeClientFactory = NonNullable<ConstructorParameters<typeof OpenCodeNativeSessionManager>[0]['clientFactory']>
type ServerFactory = (options: ManagedOpenCodeServerOptions) => OpenCodeServerController
export type NativeFactoryInfrastructure =
  | { mode: 'native'; codex?: CodexSessionDependencies; openCodeServer?: ServerFactory; openCodeClient?: OpenCodeClientFactory }
  | { mode: 'replay'; codex: CodexSessionDependencies & { mode: 'replay' }; openCodeServer: ServerFactory; openCodeClient: OpenCodeClientFactory }

/** Shares construction code only. Every allocation constructs a new real adapter
 * and retains the caller's initially unreserved recovery scope. */
export class NativeHarnessFactories {
  readonly instances = new HarnessInstanceRegistry(localHarnessDrivers)
  private readonly configurations = new Map<string, ConfiguredHarnessInstance>()
  private readonly inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  constructor(private readonly config: {
    codexBinary: string
    openCodeBinary: string
    appMcpEndpoint?: string
    responseJournal?: NativeResponseJournal
  }, private readonly infrastructure: NativeFactoryInfrastructure = { mode: 'native' }) {
    if (infrastructure.mode === 'native' && infrastructure.codex?.mode === 'replay') {
      throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay dependencies require the complete replay environment.', 500)
    }
    if (infrastructure.mode === 'replay' && (!infrastructure.codex || infrastructure.codex.mode !== 'replay'
      || !infrastructure.openCodeServer || !infrastructure.openCodeClient)) {
      throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay requires every provider infrastructure port.', 500)
    }
  }

  allocate(input: NativeHarnessAllocation): NativeHarnessAllocationResult {
    if (input.configured) {
      if (input.configured.driverId !== input.harness) throw new DomainError(
        'HARNESS_CONFIGURATION_MISMATCH', 'The configured driver differs from the selected harness.', 409)
      const prior = this.configurations.get(input.configured.instanceId)
      if (!prior || prior.instanceRevision !== input.configured.instanceRevision) {
        const next = new Map(this.configurations)
        next.set(input.configured.instanceId, input.configured)
        this.instances.reload([...next.values()])
        this.configurations.set(input.configured.instanceId, structuredClone(input.configured))
      } else if (JSON.stringify(prior) !== JSON.stringify(input.configured)) {
        throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The accepted configured revision is immutable.', 409)
      }
      this.instances.select(input.configured.instanceId)
    }
    if ((input.role === 'agent-chat' || input.role === 'diagnostics' || input.role === 'qualification')
      && (input.appMcpAccess !== 'none' || input.credentialEnvironmentVariable)) {
      throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'This runtime role has no application MCP credentials.', 403)
    }
    let result: NativeHarnessAllocationResult
    if (input.harness === 'codex') {
      const manager = new CodexAppServerSessionManager(this.config.codexBinary, undefined, undefined,
        input.processRecovery, input.appMcpAccess, input.chatFiles, this.infrastructure.codex)
      result = { harness: 'codex', manager, inspector: codexMcpInspectorAdapter(manager) }
    } else {
      const options: ManagedOpenCodeServerOptions = {
        binary: this.config.openCodeBinary, workingDirectory: input.workingDirectory,
        ownerAgentId: input.ownerAgentId, appMcpAccess: input.appMcpAccess,
        ...(input.processRecovery ? { processRecovery: input.processRecovery } : {}),
        ...(input.credentialEnvironmentVariable ? { credentialEnvironmentVariable: input.credentialEnvironmentVariable } : {}),
        ...(input.advancedConfiguration ? { advancedConfiguration: input.advancedConfiguration } : {}),
      }
      const server = this.infrastructure.openCodeServer
        ? this.infrastructure.openCodeServer(options) : new ManagedOpenCodeServer(options)
      const manager = new OpenCodeNativeSessionManager({ server, ownerAgentId: input.ownerAgentId,
        appMcpAccess: input.appMcpAccess,
        ...(this.config.appMcpEndpoint ? { expectedAppMcpEndpoint: this.config.appMcpEndpoint } : {}),
        ...(this.config.responseJournal ? { responseJournal: this.config.responseJournal } : {}),
        ...(input.credentialEnvironmentVariable ? { credentialEnvironmentVariable: input.credentialEnvironmentVariable } : {}),
        ...(input.chatFiles ? { chatFiles: input.chatFiles(server) } : {}),
        ...(this.infrastructure.openCodeClient ? { clientFactory: this.infrastructure.openCodeClient } : {}),
      })
      result = { harness: 'opencode', manager, inspector: openCodeMcpInspectorAdapter(manager) }
    }
    this.inspectors.set(result.manager, result.inspector)
    return result
  }

  async qualifyConfiguration(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    const { manager } = this.allocate({ harness: configuration.harness, role: 'qualification',
      workingDirectory, ownerAgentId: 'configuration-qualification', appMcpAccess: 'none',
      ...(configuration.harness === 'opencode' && configuration.advanced
        ? { advancedConfiguration: configuration.advanced } : {}),
    })
    try { return await manager.qualifyConfiguration(configuration, workingDirectory, signal) }
    finally { await manager.dispose() }
  }

  inspector(manager: NativeHarnessSessionManager): NativeMcpInspector {
    const inspector = this.inspectors.get(manager)
    if (!inspector) throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The allocated driver has no MCP inspector.', 503)
    return inspector
  }
}
