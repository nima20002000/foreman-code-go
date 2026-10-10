import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { WorkerConversationRpcRequestSchema, type WorkerConversationBinding,
  type WorkerConversationConfiguration, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { createWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../harnesses/codexAppServer.js'
import { CodexDiagnostics } from '../harnesses/codexDiagnostics.js'
import { codexMcpInspectorAdapter } from '../harnesses/codexMcpInspectorAdapter.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { createInstalledCodexDependencies } from '../harnesses/installedCodexDependencies.js'
import { DomainError } from '../errors.js'
import { createInstalledConversationNativeReader } from './installedNativeProfile.js'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationChannel } from './workerBridge.js'
import { allocateInstalledWorkerClaude } from './installedWorkerClaude.js'
import { WorkerConversationFiles } from './workerFiles.js'
import { localCodexChatHost } from '../harnesses/codexFiles/localHost.js'
import { assertCodexChatHost } from '../harnesses/codexFiles/localHost.js'
import { workerConversationProcessDigest } from './workerNativeOwner.js'
import { recoverWorkerConversation } from './recoverWorkerConversation.js'
import { join } from 'node:path'

function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}

/** Shipped conversation owner on the existing installed worker, journal and paired channel. */
export async function createInstalledWorkerConversations(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  registry: NativeProcessRegistry
  journal(): Promise<RemoteOperationJournal>
  current(): Readonly<DeviceSessionBinding>
  capture(): WorkerConversationChannel | undefined
  request(namespace: string, payload: unknown, options: { signal: AbortSignal }): Promise<DeviceApplicationResult>
  approvedRoots(): Promise<ApprovedRootAllowlist>
  codexSuiteRevision: string
  signal: AbortSignal
}) {
  const selected = await readInstalledWorkflowConfiguration(input.configuration)
  if (!selected) return null
  const conversationJournal = (await input.journal()).conversations
  const operations = new AsyncLocalStorage<WorkerConversationRpcRequest>()
  const source = () => {
    input.signal.throwIfAborted()
    const request = operations.getStore()
    if (!request) unavailable('The native operation has no admitted conversation request.')
    return request
  }
  const callbacks = workerConversationCallbacks({ currentBinding: input.current, capture: input.capture })
  const files = new WorkerConversationFiles(callbacks)
  const allocate = async (binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, purpose: 'chat' | 'compaction-read' | 'preparation'): Promise<WorkerConversationAllocation> => {
    const harness = binding.harness
    if (harness === 'claude') return allocateInstalledWorkerClaude({ binding, configuration, connection, purpose,
      stateDirectory: input.stateDirectory, selection: input.configuration, launcher: selected.appMcpLauncher,
      journal: conversationJournal,
      current: input.current, source, callbacks, approvedRoots: input.approvedRoots, registry: input.registry,
      request: input.request, signal: input.signal })
    if (harness !== 'codex') unavailable('The installed native selection does not support this driver.')
    const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: input.approvedRoots })
    const reader = createInstalledConversationNativeReader({ binding, configuration, connection,
      current: input.current, signal: () => input.signal, suiteRevision: input.codexSuiteRevision,
      inspect: signal => inspectInstalledCodex({ binding: input.current(), configuration: input.configuration,
        environment: process.env, cwd: input.stateDirectory, signal }),
      readFacts: signal => callbacks.profile(source(), signal),
    })
    const original = await reader.capture()
    const binary = original.inspection.installation.launcher.resolvedLauncher
    if (!binary) unavailable('The selected native launcher is unavailable.')
    let scopeOwner = `conversation:${binding.owner.conversationId}`
    let appMcpAccess = binding.appMcpAccess
    if (purpose === 'compaction-read') {
      scopeOwner = `conversation-read:${binding.owner.conversationId}:${randomUUID()}`
      appMcpAccess = 'none'
    }
    if (purpose === 'preparation') scopeOwner = `conversation-prepare:${binding.owner.conversationId}:${randomUUID()}`
    const scope = input.registry.scope(scopeOwner)
    const before = async (signal?: AbortSignal) => {
      await directory.assertCurrent(signal)
      await reader.capture()
      signal?.throwIfAborted()
    }
    if (configuration.harness.harness !== 'codex') unavailable('The selected Codex configuration changed.')
    const fileStorageRoot = join(input.stateDirectory, 'conversation-file-storage')
    const assertFileHost = async (signal: AbortSignal) => {
      await before(signal)
      if (configuration.harness.harness !== 'codex' || configuration.harness.sandbox === 'danger-full-access') {
        unavailable('This Codex configuration cannot safely receive attachment paths.')
      }
      await assertCodexChatHost(fileStorageRoot, binding.workingDirectory,
        configuration.harness.advanced?.additionalWritableDirectories ?? [],
        configuration.harness.sandbox === 'workspace-write')
    }
    const chatFiles = purpose === 'chat' && appMcpAccess === 'none'
      ? files.adapter({ source, signal: input.signal, assertCurrent: assertFileHost,
        host: () => localCodexChatHost(fileStorageRoot) }) : undefined
    const dependencies = createInstalledCodexDependencies({ reader, codexSuiteRevision: input.codexSuiteRevision })
    const operations: Extract<CodexSessionDependencies, { mode: 'native' }> = { ...dependencies,
      qualify: async (executable, cwd, environment, authenticated, signal, recovery = scope) => {
        await before(signal)
        return dependencies.qualify(executable, cwd, environment, authenticated, signal, recovery)
      },
      assertUnchanged: async qualified => { await before(); await dependencies.assertUnchanged(qualified) },
      runCommand: async (executable, args, cwd, signal, environment, options) => {
        await before(signal)
        return dependencies.runCommand(executable, args, cwd, signal, environment,
          { ...options, recovery: options?.recovery ?? scope })
      },
      qualifyModel: async (configuration, executable, cwd, environment, signal, recovery = scope, inspection) => {
        await before(signal)
        return dependencies.qualifyModel(configuration, executable, cwd, environment, signal, recovery, inspection)
      },
    }
    const diagnostics = new CodexDiagnostics({ native: operations,
      createRecovery: () => input.registry.scope(`conversation-diagnostics:${binding.owner.conversationId}:${randomUUID()}`),
      admitRecovery: recovery => { Object.assign(recovery, input.registry.reserveLaunch(recovery.owner)) },
      abandonRecovery: async recovery => { await input.registry.abandonReservedLaunch(recovery) },
      closeRecovery: async recovery => {
        if (!await input.registry.closeOwner(recovery.owner)) unavailable('Native diagnostic closure is unconfirmed.')
      },
    })
    const native = new CodexAppServerSessionManager(binary, original.qualification.version, undefined, scope, appMcpAccess,
      chatFiles, { ...operations, withDiagnostics: (pin, run) => diagnostics.run(pin, run, scope) })
    const manager: NativeHarnessSessionManager = native
    const inspector: NativeMcpInspector = codexMcpInspectorAdapter(native)
    let mcp: Awaited<ReturnType<typeof createWorkerMcpEndpoint>> | undefined
    let launch: NativeLaunchObservation | undefined
    const nativeOwner = async (session: NativeSessionReference) => {
      const rows = input.registry.snapshot().launches.filter(value => value.owner === scope.owner && value.lifecycle === 'active')
      let current = rows.length === 1 ? rows[0] : undefined
      if (launch) current = rows.find(value => value.launchId === launch!.launchId)
      if (!current?.guardian || !current.provider || !current.boundary || launch && !isDeepStrictEqual(launch, current)) {
        unavailable('The original native chat process is unavailable or changed.')
      }
      launch ??= current
      return { sessionId: session.nativeSessionId, processIdentityDigest: workerConversationProcessDigest(binding, launch) }
    }
    const start: WorkerConversationAllocation['start'] = async options => {
      await before(input.signal)
      if (purpose === 'chat') Object.assign(scope, input.registry.reserveLaunch(scope.owner))
      let environment: Awaited<ReturnType<typeof prepareWorkerConversationMcp>>['environment'] | undefined
      if (options.applicationAccess) {
        if (mcp) unavailable('The native chat already has a scoped MCP route.')
        const relay = await prepareWorkerConversationMcp({ source: source(), token: options.applicationAccess.token,
          request: input.request, signal: input.signal })
        mcp = await createWorkerMcpEndpoint({ relay, launcher: selected.appMcpLauncher, signal: input.signal })
        environment = relay.environment
      }
      const owner = binding.owner
      if (owner.kind === 'operator' && 'operatorId' in configuration) {
        return { kind: 'operator', configuration, correlationId: options.correlationId,
          workingDirectory: binding.workingDirectory, ...(environment ? { environment } : {}) }
      }
      if (owner.kind !== 'agent' || !('agentId' in configuration) || environment) unavailable('The native chat role changed.')
      return { kind: 'agent-chat', configuration, conversationId: owner.conversationId, workflowId: owner.workflowId,
        workflowNodeId: owner.workflowNodeId, correlationId: options.correlationId,
        ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}),
        workingDirectory: binding.workingDirectory, instructionsDelivered: options.instructionsDelivered }
    }
    return { manager, inspector, nativeOwner, start,
      ...(harness === 'codex' && appMcpAccess === 'none' ? {
        recoverFiles: (request, nativeTurnId, signal) => files.recover(request, nativeTurnId, signal),
      } satisfies Pick<WorkerConversationAllocation, 'recoverFiles'> : {}),
      async close() {
        const errors: unknown[] = []
        diagnostics.stop()
        try { await manager.dispose?.() } catch (error) { errors.push(error) }
        try { await diagnostics.dispose() } catch (error) { errors.push(error) }
        if (scope.launchId) await input.registry.abandonReservedLaunch(scope)
        if (!await input.registry.closeOwner(scope.owner)) unavailable('Native chat closure is unconfirmed.')
        if (purpose === 'chat') {
          try {
            await files.closeConversation(binding.owner.conversationId)
          } catch (error) { errors.push(error) }
        }
        try { await mcp?.close() } catch (error) { errors.push(error) }
        if (errors.length) throw new AggregateError(errors, 'Native chat resources need cleanup retry.')
      } }
  }
  const host = new WorkerConversationHost({ ...callbacks, currentBinding: input.current,
    journal: conversationJournal,
    allocate: (binding, configuration, connection) => allocate(binding, configuration, connection, 'chat'),
    prepare: (binding, configuration, connection) => allocate(binding, configuration, connection, 'preparation'),
    recover: (record, configuration, connection, signal, request) => recoverWorkerConversation({
      record, configuration, connection, signal, request, registry: input.registry, journal: conversationJournal,
      allocate: () => allocate(request.method === 'conversation.open' && request.previousBinding
        ? request.binding : record.binding, configuration, connection, 'chat'),
      assertCurrent: () => callbacks.authorize(request, connection, signal),
    }),
    readCompaction: async (request, _record, connection, signal) => {
      const observer = await allocate(request.binding, request.configuration, connection, 'compaction-read')
      try {
        const start = await observer.start({ correlationId: request.correlationId, instructionsDelivered: true })
        return await observer.manager.readCompaction!(request.session, start, request.state, signal)
      } finally { await observer.close() }
    },
  })
  return {
    handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
      const request = WorkerConversationRpcRequestSchema.parse(raw)
      if (request.method === 'conversation.file-copy') {
        if (!isDeepStrictEqual(input.current(), connection)) unavailable('The attachment copy channel changed.')
        return operations.run(request, () => files.copy(request, signal))
      }
      return operations.run(request, () => host.handle(request, connection, signal))
    },
    drainForUpdate: () => host.drainForUpdate(),
    close: async () => { await host.shutdown(); await files.close() },
  }
}
