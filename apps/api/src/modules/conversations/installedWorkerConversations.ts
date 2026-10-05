import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
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
import { CodexAppServerSessionManager } from '../harnesses/codexAppServer.js'
import { codexMcpInspectorAdapter } from '../harnesses/codexMcpInspectorAdapter.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import { inspectInstalledOpenCode } from '../harnesses/installedOpenCodeInspection.js'
import { ManagedOpenCodeServer, OpenCodeNativeSessionManager } from '../harnesses/opencodeServer.js'
import { openCodeMcpInspectorAdapter } from '../harnesses/opencodeMcpInspectorAdapter.js'
import { HarnessQualificationRegistry } from '../harnesses/qualification/registry.js'
import { runWithReadOnlyQualification } from '../harnesses/qualification/gate.js'
import { opencodeQualificationSuite } from '../harnesses/qualification/suites/opencode.js'
import { qualificationRevisionWithIdentity } from '../harnesses/qualification/identity.js'
import { APP_MCP_TOKEN } from '../harnesses/appMcpLauncher.js'
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
    connection: Readonly<DeviceSessionBinding>, purpose: 'chat' | 'compaction-read'): Promise<WorkerConversationAllocation> => {
    const harness = binding.harness
    if (harness === 'claude') return allocateInstalledWorkerClaude({ binding, configuration, connection, purpose,
      stateDirectory: input.stateDirectory, selection: input.configuration, launcher: selected.appMcpLauncher,
      current: input.current, source, callbacks, approvedRoots: input.approvedRoots, registry: input.registry,
      request: input.request, signal: input.signal })
    if (harness !== 'codex' && harness !== 'opencode') unavailable('The installed native selection does not support this driver.')
    if (harness === 'opencode' && !selected.opencode) unavailable('The installed OpenCode selection is missing.')
    const inspect = harness === 'codex' ? inspectInstalledCodex : inspectInstalledOpenCode
    const suiteRevision = harness === 'codex' ? input.codexSuiteRevision : qualificationRevisionWithIdentity(opencodeQualificationSuite.revision)
    const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: input.approvedRoots })
    const reader = createInstalledConversationNativeReader({ binding, configuration, connection,
      current: input.current, signal: () => input.signal, suiteRevision,
      inspect: signal => inspect({ binding: input.current(), configuration: input.configuration,
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
    const scope = input.registry.scope(scopeOwner)
    const before = async (signal?: AbortSignal) => {
      await directory.assertCurrent(signal)
      await reader.capture()
      signal?.throwIfAborted()
    }
    let manager: NativeHarnessSessionManager
    let inspector: NativeMcpInspector
    if (harness === 'codex') {
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
      const dependencies = createInstalledCodexDependencies({ reader, codexSuiteRevision: suiteRevision })
      const native = new CodexAppServerSessionManager(binary, original.qualification.version, undefined, scope, appMcpAccess,
      chatFiles, { ...dependencies,
        qualify: async (executable, version, cwd, environment, authenticated, signal) => {
          await before(signal)
          return dependencies.qualify(executable, version, cwd, environment, authenticated, signal, scope)
        },
        assertUnchanged: async qualified => { await before(); await dependencies.assertUnchanged(qualified) },
        runCommand: async (executable, args, cwd, signal, environment, options) => {
          await before(signal)
          return dependencies.runCommand(executable, args, cwd, signal, environment, { ...options, recovery: scope })
        },
        qualifyModel: async (configuration, executable, cwd, environment, signal) => {
          await before(signal)
          return dependencies.qualifyModel(configuration, executable, cwd, environment, signal, scope)
        },
      })
      manager = native
      inspector = codexMcpInspectorAdapter(native)
    } else {
      if (configuration.harness.harness !== 'opencode') unavailable('The selected OpenCode configuration changed.')
      const ownerId = binding.owner.kind === 'operator' ? binding.owner.operatorId : binding.owner.agentId
      const registry = new HarnessQualificationRegistry(reader.repository, { opencode: suiteRevision })
      const server = new ManagedOpenCodeServer({ binary, workingDirectory: binding.workingDirectory,
        ownerAgentId: ownerId, processRecovery: scope, appMcpAccess,
        ...(appMcpAccess === 'scoped' ? { credentialEnvironmentVariable: APP_MCP_TOKEN } : {}),
        ...(configuration.harness.advanced ? { advancedConfiguration: configuration.harness.advanced } : {}),
        assertInstallation: before })
      const ensure = server.ensure.bind(server)
      server.ensure = signal => runWithReadOnlyQualification(registry, () => ensure(signal))
      const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: ownerId, appMcpAccess })
      manager = native
      inspector = openCodeMcpInspectorAdapter(native)
    }
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
      return { sessionId: session.nativeSessionId, processIdentityDigest: commandInputHash({ owner: scope.owner,
        binding, launchId: launch.launchId, bootId: launch.bootId, guardian: launch.guardian,
        provider: launch.provider, boundary: launch.boundary }).slice('sha256:'.length) }
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
        workingDirectory: binding.workingDirectory, instructionsDelivered: options.instructionsDelivered }
    }
    return { manager, inspector, nativeOwner, start,
      ...(harness === 'codex' && appMcpAccess === 'none' ? {
        recoverFiles: (request, nativeTurnId, signal) => files.recover(request, nativeTurnId, signal),
      } satisfies Pick<WorkerConversationAllocation, 'recoverFiles'> : {}),
      async close() {
        await manager.dispose?.()
        if (!await input.registry.closeOwner(scope.owner)) unavailable('Native chat closure is unconfirmed.')
        await files.closeConversation(binding.owner.conversationId)
        await mcp?.close()
      } }
  }
  const host = new WorkerConversationHost({ ...callbacks, currentBinding: input.current,
    journal: (await input.journal()).conversations,
    allocate: (binding, configuration, connection) => allocate(binding, configuration, connection, 'chat'),
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
    close: async () => { await host.shutdown(); await files.close() },
  }
}
