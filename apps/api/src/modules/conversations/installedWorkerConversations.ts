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
import { createInstalledCodexDependencies } from '../harnesses/installedCodexDependencies.js'
import { DomainError } from '../errors.js'
import { createInstalledConversationCodexReader } from './installedCodexProfile.js'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import type { WorkerConversationChannel } from './workerBridge.js'

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
  const allocate = async (binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, purpose: 'chat' | 'compaction-read'): Promise<WorkerConversationAllocation> => {
    if (binding.harness !== 'codex') unavailable('This installed selection requires the Codex driver.')
    const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: input.approvedRoots })
    const reader = createInstalledConversationCodexReader({ binding, configuration, connection,
      current: input.current, signal: () => input.signal, suiteRevision: input.codexSuiteRevision,
      inspect: signal => inspectInstalledCodex({ binding: input.current(), configuration: input.configuration,
        environment: process.env, cwd: input.stateDirectory, signal }),
      readFacts: signal => callbacks.profile(source(), signal),
    })
    const original = await reader.capture()
    const binary = original.inspection.installation.launcher.resolvedLauncher
    if (!binary) unavailable('The selected Codex launcher is unavailable.')
    let scopeOwner = `conversation:${binding.owner.conversationId}`
    let appMcpAccess = binding.appMcpAccess
    if (purpose === 'compaction-read') {
      scopeOwner = `conversation-read:${binding.owner.conversationId}:${randomUUID()}`
      appMcpAccess = 'none'
    }
    const scope = input.registry.scope(scopeOwner)
    const dependencies = createInstalledCodexDependencies({ reader, codexSuiteRevision: input.codexSuiteRevision })
    const before = async (signal?: AbortSignal) => {
      await directory.assertCurrent(signal)
      await reader.capture()
      signal?.throwIfAborted()
    }
    const manager = new CodexAppServerSessionManager(binary, original.qualification.version, undefined, scope, appMcpAccess,
      undefined, { ...dependencies,
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
    return { manager, inspector: codexMcpInspectorAdapter(manager), nativeOwner, start,
      async close() {
        await manager.dispose()
        if (!await input.registry.closeOwner(scope.owner)) unavailable('Native chat closure is unconfirmed.')
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
      return operations.run(request, () => host.handle(request, connection, signal))
    },
    close: () => host.shutdown(),
  }
}
