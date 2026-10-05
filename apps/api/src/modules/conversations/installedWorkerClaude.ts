import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkerConversationBinding, WorkerConversationConfiguration,
  WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { inspectInstalledClaude } from '../harnesses/installedClaudeInspection.js'
import { compileClaudeConfiguration } from '../harnesses/claudeSdk/configuration.js'
import { createClaudeSdkCallbacks } from '../harnesses/claudeSdk/sdkCallbacks.js'
import { createClaudeSdkRunner } from '../harnesses/claudeSdk/runner.js'
import { loadOfficialClaudeSdk } from '../harnesses/claudeSdk/official.js'
import { allocateClaudeNativeHarness } from '../harnesses/claudeSdk/composition.js'
import { claudeProductionMcpInspector } from '../harnesses/claudeSdk/productionMcpInspector.js'
import type { ClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import { appMcpServerName, isSupportedAppMcpServerName } from '../harnesses/appMcpLauncher.js'
import type { NativeProcessRegistry, NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { createWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'
import { installedConversationDirectory } from './installedConversationDirectory.js'
import { createInstalledClaudeConversationProfile } from './installedClaudeConversationProfile.js'
import { createWorkerClaudeAuthority } from './workerClaudeAuthority.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'
import type { workerConversationCallbacks } from './workerCallbacks.js'
import type { WorkerConversationAllocation } from './workerHost.js'

export async function allocateInstalledWorkerClaude(input: {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  connection: Readonly<DeviceSessionBinding>
  purpose: 'chat' | 'compaction-read'
  stateDirectory: string
  selection: InstalledWorkflowConfigurationLocation | null
  launcher: string
  current(): Readonly<DeviceSessionBinding>
  source(): WorkerConversationRpcRequest
  callbacks: ReturnType<typeof workerConversationCallbacks>
  approvedRoots(): Promise<ApprovedRootAllowlist>
  registry: NativeProcessRegistry
  request(namespace: string, payload: unknown, options: { signal: AbortSignal }): Promise<DeviceApplicationResult>
  signal: AbortSignal
}): Promise<WorkerConversationAllocation> {
  const binding = structuredClone(input.binding)
  const configuration = structuredClone(input.configuration)
  if (configuration.harness.harness !== 'claude' || binding.harness !== 'claude') throw new DomainError(
    'HARNESS_CONFIGURATION_MISMATCH', 'Claude allocation requires the saved Claude profile.', 409)
  const directory = await installedConversationDirectory({ binding, configuration, approvedRoots: input.approvedRoots })
  const profiles = createInstalledClaudeConversationProfile({ binding, configuration, connection: input.connection,
    current: input.current, signal: input.signal, readFacts: signal => input.callbacks.profile(input.source(), signal),
    inspect: signal => inspectInstalledClaude({ binding: input.current(), configuration: input.selection,
      environment: process.env, cwd: input.stateDirectory, signal }) })
  const original = await profiles.capture()
  const binary = original.installation.launcher.resolvedLauncher
  if (!binary) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The installed Claude executable is unavailable.', 409)
  const compiled = compileClaudeConfiguration(configuration.harness, binding.workingDirectory, original.accepted)
  const reader = input.purpose === 'compaction-read'
  const owner = reader ? `conversation-read:${binding.owner.conversationId}:${randomUUID()}`
    : `conversation:${binding.owner.conversationId}`
  const recovery = input.registry.scope(owner)
  let reserved = false
  const before = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    await directory.assertCurrent(signal)
    const current = await profiles.capture()
    if (!isDeepStrictEqual(current.accepted, original.accepted)) throw new DomainError(
      'HARNESS_PROFILE_UNAVAILABLE', 'The accepted Claude native policy changed.', 409)
  }
  const reserve = () => {
    if (reserved) return
    Object.assign(recovery, input.registry.reserveLaunch(owner))
    reserved = true
  }
  const appAccess = reader ? 'none' : binding.appMcpAccess
  const authority = createWorkerClaudeAuthority({ configuration: compiled.configuration,
    version: original.accepted.currentBinding.pin.cliVersion, signal: input.signal, source: input.source,
    request: input.callbacks.claudeAuthority })
  let manager: ClaudeNativeSessionManager
  let mcp: Awaited<ReturnType<typeof createWorkerMcpEndpoint>> | undefined
  let token: string | undefined
  let environment: Awaited<ReturnType<typeof prepareWorkerConversationMcp>>['environment'] | undefined
  const start: WorkerConversationAllocation['start'] = async options => {
    await before(input.signal)
    reserve()
    if (options.applicationAccess && options.applicationAccess.token !== token) {
      throw new DomainError('CLAUDE_MCP_CREDENTIAL_DELIVERY_REQUIRED', 'The scoped credential must be acknowledged before message input.', 409)
    }
    const owner = binding.owner
    if (owner.kind === 'operator' && 'operatorId' in configuration) return { kind: 'operator', configuration,
      correlationId: options.correlationId, workingDirectory: binding.workingDirectory,
      ...(environment ? { environment } : {}) }
    if (owner.kind !== 'agent' || !('agentId' in configuration) || environment) throw new DomainError(
      'HARNESS_ROLE_AUTHORITY_INVALID', 'Agent chat cannot receive an Operator MCP credential.', 403)
    return { kind: 'agent-chat', configuration, conversationId: owner.conversationId, workflowId: owner.workflowId,
      workflowNodeId: owner.workflowNodeId, correlationId: options.correlationId,
      workingDirectory: binding.workingDirectory, instructionsDelivered: options.instructionsDelivered }
  }
  const inspectionStart = () => start({ correlationId: `inspection:${binding.owner.conversationId}`, instructionsDelivered: true })
  const serverName = appMcpServerName(compiled.mcpServers)
  const configured = compiled.mcpServers[serverName]
  const runner = createClaudeSdkRunner({ loadClient: async () => {
    await before(input.signal)
    reserve()
    return loadOfficialClaudeSdk(compiled.configuration.configDirectory, recovery, binary)
  } })
  const callbacks = createClaudeSdkCallbacks({ manager: () => manager, bridge: authority.bridge })
  const sdkOptions: Record<string, unknown> = { ...compiled,
    mcpServers: appAccess === 'none' ? Object.fromEntries(Object.entries(compiled.mcpServers)
      .filter(([name]) => !isSupportedAppMcpServerName(name))) : compiled.mcpServers,
    includePartialMessages: true, ...callbacks }
  delete sdkOptions.configuration
  delete sdkOptions.qualification
  const allocation = allocateClaudeNativeHarness({ harness: 'claude', role: binding.owner.kind === 'operator' ? 'operator' : 'agent-chat',
    workingDirectory: binding.workingDirectory,
    ownerAgentId: binding.owner.kind === 'operator' ? binding.owner.operatorId : binding.owner.agentId,
    processRecovery: recovery, appMcpAccess: appAccess,
    scope: { deviceId: input.connection.deviceId, profilePath: compiled.configuration.configDirectory,
      configRevision: original.accepted.currentBinding.pin.configRevision, cwd: binding.workingDirectory },
    runner, sdkOptions,
    qualification: { sdkVersion: original.accepted.currentBinding.pin.sdkVersion,
      cliVersion: original.accepted.currentBinding.pin.cliVersion, basicTurns: compiled.qualification.basicTurns,
      resume: compiled.qualification.resume, fork: compiled.qualification.fork, history: compiled.qualification.history,
      interactions: compiled.qualification.policy.alwaysAppliedToolHook },
    inspectionStart, expectedMcp: { serverName }, interactionPort: authority.interactionPort,
    liveCallbacks: authority.bridge, cancelPendingRequests: () => authority.bridge.close(),
    pendingInteractions: session => authority.bridge.pendingInteractions(session),
    ownerForStart: source => ({ ownerId: binding.owner.conversationId, attemptId: source.correlationId ?? owner,
      generation: recovery.launchId ?? owner }),
  })
  manager = allocation.manager
  authority.bind(manager)
  const inspect = claudeProductionMcpInspector({ manager: () => manager, start: inspectionStart,
    workingDirectory: binding.workingDirectory, cliVersion: original.accepted.currentBinding.pin.cliVersion })
  let launch: NativeLaunchObservation | undefined
  return { manager, start,
    inspector: { async inspect(request) {
      await before(request.signal)
      const result = await inspect.inspect(request)
      if (mcp && configured?.type === 'http' && result.entry?.endpoint === mcp.endpoint) {
        result.entry.pairedEndpoint = { mainId: input.connection.mainId, deviceId: input.connection.deviceId,
          configuredEndpoint: configured.url, nativeEndpoint: mcp.endpoint }
      }
      return result
    } },
    async deliverClaudeCredential(nextToken, signal) {
      if (appAccess !== 'scoped' || binding.owner.kind !== 'operator' || configured?.type !== 'http') {
        throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'This native owner has no scoped Operator HTTP MCP connection.', 403)
      }
      await before(signal)
      if (token !== nextToken) {
        await mcp?.close()
        const relay = await prepareWorkerConversationMcp({ source: input.source(), token: nextToken,
          request: input.request, signal: input.signal })
        mcp = await createWorkerMcpEndpoint({ relay, launcher: input.launcher, signal: input.signal })
        environment = relay.environment
        token = nextToken
      }
      if (!mcp) throw new DomainError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The private paired MCP route is unavailable.', 409)
      const snapshot = await manager.refreshInspectionCredentials(await inspectionStart(), { ...compiled.mcpServers,
        [serverName]: { ...configured, url: mcp.endpoint, headers: { Authorization: `Bearer ${nextToken}` } },
      }, signal)
      if (snapshot.httpCredentialAcknowledgement?.endpoint !== mcp.endpoint) throw new DomainError(
        'CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK has not acknowledged the scoped worker credential.', 409)
    },
    async nativeOwner(session: NativeSessionReference) {
      const rows = input.registry.snapshot().launches.filter(value => value.owner === owner && value.lifecycle === 'active')
      let current = rows.length === 1 ? rows[0] : undefined
      if (launch) current = rows.find(value => value.launchId === launch!.launchId)
      if (!current?.guardian || !current.provider || !current.boundary || launch && !isDeepStrictEqual(current, launch)) {
        throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The original Claude process is unavailable or changed.', 409)
      }
      launch ??= current
      return { sessionId: session.nativeSessionId, processIdentityDigest: commandInputHash({ owner, binding,
        launchId: current.launchId, bootId: current.bootId, guardian: current.guardian,
        provider: current.provider, boundary: current.boundary }).slice('sha256:'.length) }
    },
    async close() {
      await manager.dispose?.()
      await input.registry.abandonReservedLaunch(recovery)
      if (!await input.registry.closeOwner(owner)) throw new DomainError('CLAUDE_PROCESS_CLOSURE_PENDING',
        'The native Claude chat has not stopped.', 409)
      await mcp?.close()
    },
  }
}
