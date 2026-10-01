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
  private auxiliaryClosing = false
  private readonly auxiliaries = new Map<NativeHarnessSessionManager, { recovery: NativeProcessRecovery | undefined; admitted: boolean; admissionError?: unknown; disposal?: Promise<void> }>()
  private readonly closedAuxiliaries = new WeakSet<NativeHarnessSessionManager>()
  private readonly inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  constructor(private readonly config: {
    codexBinary: string
    openCodeBinary: string
    appMcpEndpoint?: string
    responseJournal?: NativeResponseJournal
    auxiliaryRecovery?: (role: 'diagnostics' | 'qualification') => NativeProcessRecovery
    admitRecovery?: (recovery: NativeProcessRecovery) => void
    closeRecovery?: (recovery: NativeProcessRecovery) => Promise<void>
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
    const auxiliary = input.role === 'diagnostics' || input.role === 'qualification'
    if (auxiliary && this.auxiliaryClosing) throw new DomainError(
      'NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
    const recovery = input.processRecovery ?? (auxiliary ? this.config.auxiliaryRecovery?.(input.role as 'diagnostics' | 'qualification') : undefined)
    let result: NativeHarnessAllocationResult
    if (input.harness === 'codex') {
      const manager = new CodexAppServerSessionManager(this.config.codexBinary, undefined, undefined,
        recovery, input.appMcpAccess, input.chatFiles, this.infrastructure.codex)
      result = { harness: 'codex', manager, inspector: codexMcpInspectorAdapter(manager) }
    } else if (input.harness === 'opencode') {
      const options: ManagedOpenCodeServerOptions = {
        binary: this.config.openCodeBinary, workingDirectory: input.workingDirectory,
        ownerAgentId: input.ownerAgentId, appMcpAccess: input.appMcpAccess,
        ...(recovery ? { processRecovery: recovery } : {}),
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
    } else {
      throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The selected harness driver is unavailable.', 503)
    }
    if (auxiliary) {
      this.auxiliaries.set(result.manager, { recovery, admitted: false })
      const inspector = result.inspector
      result.inspector = { inspect: (request) => { this.admitAuxiliary(result.manager); return inspector.inspect(request) } }
    }
    this.inspectors.set(result.manager, result.inspector)
    return result
  }

  async qualifyConfiguration(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    const allocation = this.allocate({ harness: configuration.harness, role: 'qualification',
      workingDirectory, ownerAgentId: 'configuration-qualification', appMcpAccess: 'none',
      ...(configuration.harness === 'opencode' && configuration.advanced
        ? { advancedConfiguration: configuration.advanced } : {}),
    })
    try {
      this.admitAuxiliary(allocation.manager)
      if (allocation.harness === 'codex' && configuration.harness === 'codex') {
        return await allocation.manager.qualifyConfiguration(configuration, workingDirectory, signal)
      }
      if (allocation.harness === 'opencode' && configuration.harness === 'opencode') {
        return await allocation.manager.qualifyConfiguration(configuration, workingDirectory, signal)
      }
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The configuration differs from its allocated driver.', 409)
    } finally { await this.disposeAuxiliary(allocation.manager) }
  }

  stopAuxiliaries(): void {
    this.auxiliaryClosing = true
    // Disposal aborts each real adapter's in-flight diagnostic requests. The
    // drain/dispose phase joins these same retained attempts and reports failures.
    for (const manager of this.auxiliaries.keys()) void this.disposeAuxiliary(manager).catch(() => undefined)
  }

  admitAuxiliary(manager: NativeHarnessSessionManager): void {
    if (this.auxiliaryClosing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
    const owned = this.auxiliaries.get(manager)
    if (!owned) throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'Only diagnostic and qualification owners use this admission boundary.', 403)
    if (owned.admissionError) throw owned.admissionError
    if (!owned.admitted) {
      // Retain ownership even when write-ahead reservation fails partway through.
      owned.admitted = true
      try { if (owned.recovery && this.config.admitRecovery) this.config.admitRecovery(owned.recovery) }
      catch (error) { owned.admissionError = error; throw error }
    }
  }

  disposeAuxiliary(manager: NativeHarnessSessionManager): Promise<void> {
    if (this.closedAuxiliaries.has(manager)) return Promise.resolve()
    const owned = this.auxiliaries.get(manager)
    if (!owned) return Promise.reject(new DomainError(
      'HARNESS_ROLE_AUTHORITY_INVALID', 'Only diagnostic and qualification owners use this cleanup boundary.', 403))
    if (owned.disposal) return owned.disposal
    const attempt = Promise.resolve().then(async () => {
      await manager.dispose!()
      if (owned.admitted && owned.recovery && this.config.closeRecovery) await this.config.closeRecovery(owned.recovery)
      this.auxiliaries.delete(manager)
      this.closedAuxiliaries.add(manager)
    })
    owned.disposal = attempt
    void attempt.catch(() => { if (owned.disposal === attempt) delete owned.disposal })
    return attempt
  }

  async disposeAuxiliaries(): Promise<void> {
    const results = await Promise.allSettled([...this.auxiliaries.keys()].map((manager) => this.disposeAuxiliary(manager)))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Native diagnostic/qualification cleanup was incomplete.')
  }

  inspector(manager: NativeHarnessSessionManager): NativeMcpInspector {
    const inspector = this.inspectors.get(manager)
    if (!inspector) throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The allocated driver has no MCP inspector.', 503)
    return inspector
  }
}
