import { allocateClaudeNativeHarness, type ClaudeNativeAllocation, type ClaudeNativeAllocationResult } from './claudeSdk/composition.js'
import type { HarnessConfiguration, OpenCodeAdvancedConfiguration } from '@graphql/contracts'
import { DomainError } from '../errors.js'
import { HarnessInstanceRegistry, localHarnessDrivers, type ConfiguredHarnessInstance } from './instanceRegistry.js'
import type { HarnessInstallationRegistry, RegistryHarnessSelection } from './installationRegistry.js'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import { discoverLauncher } from './hostDiscovery.js'
import { CodexAppServerSessionManager, type CodexSessionDependencies, type CodexDiagnosticPin, type CodexDiagnosticOperations } from './codexAppServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { runCommand } from './process.js'
import { inheritedAgentEnvironment } from './secrets.js'
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
  selection?: RegistryHarnessSelection
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
interface CodexDiagnosticLifetime {
  readonly recovery: NativeProcessRecovery
  readonly writerOwner: string | undefined
  readonly controller: AbortController
  readonly operations: Set<Promise<unknown>>
  active: boolean
  admitted: boolean
  task?: Promise<unknown>
  cleanup?: Promise<void>
}
export type NativeFactoryInfrastructure =
  | { mode: 'native'; codex?: CodexSessionDependencies; openCodeServer?: ServerFactory; openCodeClient?: OpenCodeClientFactory }
  | { mode: 'replay'; codex: CodexSessionDependencies & { mode: 'replay' }; openCodeServer: ServerFactory; openCodeClient: OpenCodeClientFactory }

/** Shares construction code only. Every allocation constructs a new real adapter
 * and retains the caller's initially unreserved recovery scope. */
export class NativeHarnessFactories {
  readonly instances: HarnessInstanceRegistry
  private readonly configurations = new Map<string, ConfiguredHarnessInstance>()
  private auxiliaryClosing = false
  private readonly auxiliaries = new Map<NativeHarnessSessionManager, { recovery: NativeProcessRecovery | undefined; admitted: boolean; admissionError?: unknown; disposal?: Promise<void> }>()
  private readonly closedAuxiliaries = new WeakSet<NativeHarnessSessionManager>()
  private readonly codexDiagnostics = new Set<CodexDiagnosticLifetime>()
  private readonly inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  constructor(private readonly config: {
    codexBinary: string
    openCodeBinary: string
    appMcpEndpoint?: string
    responseJournal?: NativeResponseJournal
    instances?: HarnessInstanceRegistry
    installations?: HarnessInstallationRegistry
    installationDiscovery?: typeof discoverLauncher
    selectDefault?: (harness: 'codex' | 'opencode') => RegistryHarnessSelection
    selectConfiguration?: (configuration: HarnessConfiguration) => RegistryHarnessSelection
    auxiliaryRecovery?: (role: 'diagnostics' | 'qualification') => NativeProcessRecovery
    admitRecovery?: (recovery: NativeProcessRecovery) => void
    abandonRecovery?: (recovery: NativeProcessRecovery) => Promise<void>
    closeRecovery?: (recovery: NativeProcessRecovery) => Promise<void>
  }, private readonly infrastructure: NativeFactoryInfrastructure = { mode: 'native' }) {
    this.instances = config.instances ?? new HarnessInstanceRegistry(localHarnessDrivers)
    if (infrastructure.mode === 'native' && infrastructure.codex?.mode === 'replay') {
      throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay dependencies require the complete replay environment.', 500)
    }
    if (infrastructure.mode === 'replay' && (!infrastructure.codex || infrastructure.codex.mode !== 'replay'
      || !infrastructure.openCodeServer || !infrastructure.openCodeClient)) {
      throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay requires every provider infrastructure port.', 500)
    }
  }

  allocate(input: ClaudeNativeAllocation): ClaudeNativeAllocationResult
  allocate(input: NativeHarnessAllocation): NativeHarnessAllocationResult
  allocate(input: NativeHarnessAllocation | ClaudeNativeAllocation): NativeHarnessAllocationResult | ClaudeNativeAllocationResult {
    if (input.harness === 'claude') {
      const auxiliary = input.role === 'diagnostics' || input.role === 'qualification'
      if (auxiliary && this.auxiliaryClosing) throw new DomainError(
        'NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
      const recovery = input.processRecovery ?? (auxiliary
        ? this.config.auxiliaryRecovery?.(input.role as 'diagnostics' | 'qualification') : undefined)
      // The domain owner supplies the exact admitted scope, qualified policy and
      // runner. There is no default profile or implicit native SDK fallback.
      const result = allocateClaudeNativeHarness({ ...input, ...(recovery ? { processRecovery: recovery } : {}) })
      if (auxiliary) {
        this.auxiliaries.set(result.manager, { recovery, admitted: false })
        const inspector = result.inspector
        if (inspector) result.inspector = { inspect: (request) => {
          this.admitAuxiliary(result.manager)
          return inspector.inspect(request)
        } }
      }
      if (result.inspector) this.inspectors.set(result.manager, result.inspector)
      return result
    }
    if (!input.selection && (input.role === 'diagnostics' || input.role === 'qualification') && this.config.selectDefault) {
      input = { ...input, selection: this.config.selectDefault(input.harness) }
    }
    if (input.selection) {
      if (!this.config.installations) throw new DomainError('HARNESS_SELECTION_UNAVAILABLE', 'Canonical installation selection is not composed.', 503)
      this.config.installations.assertCurrent(input.selection)
      const selected = input.selection.instance
      if (selected.driverId !== input.harness || (input.configured
        && (input.configured.instanceId !== selected.instanceId || input.configured.instanceRevision !== selected.instanceRevision
          || commandInputHash(input.configured.configuration) !== commandInputHash(selected.configuration)))) {
        throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The accepted configuration differs from its canonical installation selection.', 409)
      }
      if (!input.selection.installation.launcher.resolvedLauncher || !input.selection.installation.installationFingerprint) {
        throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'Exact launcher and payload evidence is required before allocation.', 409)
      }
    } else if (input.configured) {
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
      const dependencies: CodexSessionDependencies | undefined = this.infrastructure.mode === 'native'
        ? { ...this.infrastructure.codex, mode: 'native',
          qualify: async (binary, version, cwd, environment, authenticated, signal) => {
            if (input.selection) await this.assertInstallationUnchanged(input.selection, signal)
            const qualified = await (this.infrastructure.codex?.qualify
              ?? ((selectedBinary, selectedVersion, selectedCwd, selectedEnvironment, requireAuthentication, selectedSignal) =>
                qualifyCodex(selectedBinary, selectedVersion, selectedCwd, selectedEnvironment, requireAuthentication, selectedSignal, recovery)))(
              binary, version, cwd, environment, authenticated, signal)
            if (input.selection) await this.assertInstallationUnchanged(input.selection, signal)
            return qualified
          },
          assertUnchanged: async (qualified) => {
            await (this.infrastructure.codex?.assertUnchanged ?? assertCodexUnchanged)(qualified)
            if (input.selection) await this.assertInstallationUnchanged(input.selection)
          },
          withDiagnostics: (pin, run) => this.withCodexDiagnostics(pin, async (io) => {
            if (input.selection) await this.assertInstallationUnchanged(input.selection, pin.signal)
            const result = await run(io)
            if (input.selection) await this.assertInstallationUnchanged(input.selection, pin.signal)
            return result
          }, recovery) }
        : this.infrastructure.codex
      const manager = new CodexAppServerSessionManager(input.selection?.installation.launcher.resolvedLauncher ?? this.config.codexBinary, undefined, undefined,
        recovery, input.appMcpAccess, input.chatFiles, dependencies)
      result = { harness: 'codex', manager, inspector: codexMcpInspectorAdapter(manager) }
    } else if (input.harness === 'opencode') {
      const options: ManagedOpenCodeServerOptions = {
        binary: input.selection?.installation.launcher.resolvedLauncher ?? this.config.openCodeBinary, workingDirectory: input.workingDirectory,
        ownerAgentId: input.ownerAgentId, appMcpAccess: input.appMcpAccess,
        ...(recovery ? { processRecovery: recovery } : {}),
        ...(input.credentialEnvironmentVariable ? { credentialEnvironmentVariable: input.credentialEnvironmentVariable } : {}),
        ...(input.advancedConfiguration ? { advancedConfiguration: input.advancedConfiguration } : {}),
        ...(input.selection ? { assertInstallation: (signal?: AbortSignal) => this.assertInstallationUnchanged(input.selection!, signal) } : {}),
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

  async assertInstallationUnchanged(binding: RegistryHarnessSelection, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.config.installations?.assertCurrent(binding)
    const prior = binding.installation.launcher
    const launcher = prior.resolvedLauncher
    if (!launcher || !binding.installation.installationFingerprint) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The selected payload evidence is unavailable.', 409)
    if (this.infrastructure.mode === 'replay' && !this.config.installationDiscovery) throw new DomainError(
      'HARNESS_REPLAY_INCOMPLETE', 'Replay installation inspection requires its explicit filesystem port.', 500)
    const current = await (this.config.installationDiscovery ?? discoverLauncher)(launcher, prior.environment,
      (prior.payloadFingerprints ?? []).filter((item) => item.path !== launcher).map((item) => item.path), signal)
    signal?.throwIfAborted()
    if (current.fingerprint !== binding.installation.installationFingerprint) throw new DomainError(
      'HARNESS_INSTALLATION_CHANGED', 'The selected launcher or native payload changed after admission.', 409)
  }

  async qualifyConfiguration(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    const selection = this.config.selectConfiguration?.(configuration)
    const allocation = this.allocate({ harness: configuration.harness, role: 'qualification',
      ...(selection ? { selection, configured: selection.instance } : {}), workingDirectory, ownerAgentId: 'configuration-qualification', appMcpAccess: 'none',
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
    for (const owned of this.codexDiagnostics) owned.controller.abort(new Error('Native diagnostics are shutting down.'))
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
      if (owned.admitted && owned.recovery && this.config.closeRecovery) {
        await this.config.abandonRecovery?.(owned.recovery)
        await this.config.closeRecovery(owned.recovery)
      }
      this.auxiliaries.delete(manager)
      this.closedAuxiliaries.add(manager)
    })
    owned.disposal = attempt
    void attempt.catch(() => { if (owned.disposal === attempt) delete owned.disposal })
    return attempt
  }

  async disposeAuxiliaries(): Promise<void> {
    await Promise.allSettled([...this.codexDiagnostics].flatMap((owned) => owned.task ? [owned.task] : []))
    const results = await Promise.allSettled([...this.auxiliaries.keys()].map((manager) => this.disposeAuxiliary(manager)))
    results.push(...await Promise.allSettled([...this.codexDiagnostics].map((owned) => this.closeCodexDiagnostics(owned))))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Native diagnostic/qualification cleanup was incomplete.')
  }

  private withCodexDiagnostics<T>(pin: CodexDiagnosticPin, run: (io: CodexDiagnosticOperations) => Promise<T>,
    writerRecovery?: NativeProcessRecovery): Promise<T> {
    if (this.auxiliaryClosing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503))
    if (!this.config.auxiliaryRecovery || !this.config.admitRecovery || !this.config.abandonRecovery || !this.config.closeRecovery) {
      return Promise.reject(new DomainError('CODEX_DIAGNOSTIC_OWNER_REQUIRED', 'Native diagnostics require their own admitted and verified process owner.', 503))
    }
    if (this.codexDiagnostics.size >= 32) return Promise.reject(new DomainError('CODEX_DIAGNOSTIC_LIMIT', 'Too many native diagnostics are already owned.', 503))
    if ([...this.codexDiagnostics].some((owned) => owned.writerOwner === writerRecovery?.owner && !owned.active)) {
      return Promise.reject(new DomainError('CODEX_DIAGNOSTIC_CLEANUP_PENDING', 'Retry retained diagnostic cleanup before another inspection.', 409))
    }
    const recovery = this.config.auxiliaryRecovery('diagnostics')
    if (recovery.owner === writerRecovery?.owner) return Promise.reject(new DomainError(
      'CODEX_DIAGNOSTIC_OWNER_REQUIRED', 'Native diagnostics cannot share the live session process owner.', 503))
    const owned: CodexDiagnosticLifetime = { recovery, writerOwner: writerRecovery?.owner, controller: new AbortController(), operations: new Set(), active: true, admitted: false }
    const signal = pin.signal ? AbortSignal.any([pin.signal, owned.controller.signal]) : owned.controller.signal
    const native = this.infrastructure.codex
    const environment = { ...(native?.environment?.(undefined, pin.scopedCredentialVariables) ?? inheritedAgentEnvironment()) }
    for (const name of Object.keys(environment)) {
      if (/^(?:GRAPHQL_|OPERATOR_|DATABASE_URL$|TEST_DATABASE_URL$|PGPASSWORD$)/.test(name)
        || pin.scopedCredentialVariables.includes(name)) delete environment[name]
    }
    this.codexDiagnostics.add(owned)
    const guard = () => {
      if (this.auxiliaryClosing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503)
      if (!owned.active) throw new DomainError('CODEX_DIAGNOSTIC_CLOSED', 'This diagnostic capability is already closed.', 409)
      signal.throwIfAborted()
    }
    const combined = (request?: AbortSignal) => request ? AbortSignal.any([signal, request]) : signal
    const track = <R>(operation: () => Promise<R>): Promise<R> => {
      guard()
      const task = Promise.resolve().then(() => { guard(); return operation() })
      owned.operations.add(task)
      void task.then(() => owned.operations.delete(task), () => owned.operations.delete(task))
      return task
    }
    const io: CodexDiagnosticOperations = {
      environment: (_input, excluded = []) => { guard(); return Object.fromEntries(Object.entries(environment).filter(([name]) => !excluded.includes(name))) },
      qualify: (_binary, _version, _cwd, _environment, authentication, request) => track(() =>
        (native?.qualify ?? qualifyCodex)(pin.binary, pin.expectedVersion, pin.cwd, { ...environment }, authentication, combined(request), recovery)),
      assertUnchanged: (qualified) => track(() => {
        if (qualified.binary !== pin.binary) throw new DomainError('CODEX_DIAGNOSTIC_PIN_MISMATCH', 'The diagnostic binary differs from its native session pin.', 409)
        return (native?.assertUnchanged ?? assertCodexUnchanged)(qualified)
      }),
      qualifyModel: (configuration, _binary, _cwd, _environment, request) => track(() =>
        (native?.qualifyModel ?? qualifyNativeCodexModel)(configuration, pin.binary, pin.cwd, { ...environment }, combined(request), recovery)),
      runCommand: (_binary, args, _cwd, request, _environment, options) => track(() => {
        const readonlyCommand = (args.length === 4 && args[0] === 'mcp' && args[1] === 'get' && args[3] === '--json')
          || (args.length === 3 && args[0] === 'mcp' && args[1] === 'list' && args[2] === '--json')
          || (args.length === 2 && args[0] === 'debug' && args[1] === 'models')
        if (!readonlyCommand) throw new DomainError('CODEX_DIAGNOSTIC_COMMAND_DENIED', 'Native diagnostics support only bounded configuration and model reads.', 403)
        return (native?.runCommand ?? runCommand)(pin.binary, args, pin.cwd, combined(request), { ...environment }, { ...options, recovery })
      }),
    }
    const schedule = native?.schedule ?? setTimeout
    const cancelTimer = native?.cancelTimer ?? clearTimeout
    let timer: NodeJS.Timeout | undefined
    let failed = false
    let failure: unknown
    const task = Promise.resolve().then(async () => {
      guard()
      owned.admitted = true
      this.config.admitRecovery!(recovery)
      timer = schedule(() => owned.controller.abort(new Error('Native diagnostic deadline exceeded.')), 60_000)
      timer.unref()
      return await run(io)
    }).catch((error: unknown) => { failed = true; failure = error; throw error }).finally(async () => {
      owned.active = false
      owned.controller.abort(new Error('Native diagnostic capability closed.'))
      cancelTimer(timer)
      await Promise.allSettled([...owned.operations])
      try { await this.closeCodexDiagnostics(owned) } catch (error) {
        if (failed) throw new AggregateError([failure, error], 'Native diagnostics and their cleanup both failed.', { cause: error })
        throw error
      }
      // Physical cleanup can outlive successful work. A factory stop or caller
      // cancellation during that await must still prevent the native reload.
      if (!failed) {
        pin.signal?.throwIfAborted()
        if (this.auxiliaryClosing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503)
      }
    })
    owned.task = task
    return task
  }

  private closeCodexDiagnostics(owned: CodexDiagnosticLifetime): Promise<void> {
    if (owned.cleanup) return owned.cleanup
    const attempt = Promise.resolve().then(async () => {
      if (owned.admitted) {
        await this.config.abandonRecovery!(owned.recovery)
        await this.config.closeRecovery!(owned.recovery)
      }
      this.codexDiagnostics.delete(owned)
    })
    owned.cleanup = attempt
    void attempt.catch(() => { if (owned.cleanup === attempt) delete owned.cleanup })
    return attempt
  }

  inspector(manager: NativeHarnessSessionManager): NativeMcpInspector {
    const inspector = this.inspectors.get(manager)
    if (!inspector) throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The allocated driver has no MCP inspector.', 503)
    return inspector
  }
}
