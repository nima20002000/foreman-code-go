import { createClaudeFileCallResolver } from '../../files/claude/callResolver.js'
import { createClaudeFileMcpServer, type ClaudeFileSdk } from '../../files/claude/server.js'
import type { AgentFileToolService } from '../../files/tools/service.js'
import { productionClaudeFileAdmission } from './fileProduction.js'
import type pg from 'pg'
import type { ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { DomainError } from '../../errors.js'
import type { NativeHarnessFactories } from '../runtimeFactory.js'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import type { NativeSessionStart } from '../port.js'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { AcceptedClaudeProfileAdmission, AcceptedProfileSelector } from '../instanceSettings/acceptedProfile.js'
import type { ClaudeSdkClient } from './port.js'
import { compileClaudeConfiguration } from './configuration.js'
import { createPostgresClaudeInteractionBridge, type ClaudeDomainBinding } from './domainAuthority.js'
import { createClaudeSdkCallbacks } from './sdkCallbacks.js'
import { createClaudeSdkRunner } from './runner.js'
import { loadOfficialClaudeSdk } from './official.js'
import { claudeProductionMcpInspector } from './productionMcpInspector.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'

/** Private lifetime signal is never serialized into accepted configuration or provenance. */
export type ClaudeProfileOwner = (ClaudeDomainBinding | {
  /** Read-only setup has no conversation, accepted input or SDK callbacks. */
  kind: 'operator-inspection'; principalId: string; configurationVersionId: string; configurationHash: string
}) & { admissionSignal?: AbortSignal; purpose?: 'reviewer' }

/** The role's immutable configuration/placement supplies the selector; the
 * existing admission reads its exact profile and current native proof. */
export function productionClaudeManager(input: {
  pool: pg.Pool
  factories: NativeHarnessFactories
  registry: ProductionHarnessRegistry
  profiles?: AcceptedClaudeProfileAdmission<ClaudeProfileOwner>
  selector?: AcceptedProfileSelector
  binding: ClaudeDomainBinding
  role: 'workflow' | 'operator' | 'agent-chat'
  configuration: ClaudeHarnessConfiguration
  /** Privately provisioned for this accepted profile; never inherited from host authentication. */
  apiKey?: string
  workingDirectory: string
  ownerAgentId: string
  recovery: NativeProcessRecovery
  appMcpAccess: 'scoped' | 'none'
  inspectionStart(): Promise<NativeSessionStart>
  mode: 'native' | 'replay'
  files?: { service(): AgentFileToolService; sdk?: () => Promise<ClaudeFileSdk> }
  loadClient?: (input: { profilePath: string; recovery: NativeProcessRecovery; binary: string }) => Promise<ClaudeSdkClient>
}) {
  if (input.role === 'workflow' && input.binding.kind !== 'workflow'
    || input.role === 'operator' && input.binding.kind !== 'operator'
    || input.role === 'agent-chat' && input.binding.kind !== 'agent') throw new DomainError('CLAUDE_OWNER_MISMATCH',
    'The Claude runtime role must match its actual domain owner.', 409)
  input = { ...input, configuration: structuredClone(input.configuration),
    ...(input.selector ? { selector: structuredClone(input.selector) } : {}) }
  let actual: ClaudeNativeSessionManager | undefined
  let inspectedStart: NativeSessionStart | undefined
  const inspectionStart = async () => {
    inspectedStart ??= structuredClone(await input.inspectionStart())
    return structuredClone(inspectedStart)
  }
  let fileServer: ReturnType<typeof createClaudeFileMcpServer> | undefined
  let allocated: ((manager: ClaudeNativeSessionManager) => void) | undefined
  const result = input.factories.allocateAdmittedClaude(async signal => {
    if (!input.profiles || !input.selector) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
      'Claude requires an explicit accepted profile and current native qualification authority.', 409)
    if (input.mode === 'replay' && !input.loadClient) throw new DomainError('HARNESS_REPLAY_INCOMPLETE',
      'Claude replay requires the SDK client port and cannot load a native SDK.', 500)
    const profileOwner: ClaudeProfileOwner = { ...input.binding, admissionSignal: signal }
    const accepted = await input.profiles.admit(profileOwner, input.selector)
    signal.throwIfAborted()
    const compiled = compileClaudeConfiguration(input.configuration, input.workingDirectory, accepted, process.env, input.apiKey)
    const installation = input.registry.pinOverride(accepted.override)
    const binary = installation.installation.launcher.resolvedLauncher
    if (!binary) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The accepted Claude launcher is unavailable.', 409)
    // This application process executes only original-main allocations. Remote
    // placement has its own authenticated host factory and cannot borrow it.
    if (accepted.override.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH',
      'A registered-device profile must execute through its authenticated host.', 409)
    const domain = createPostgresClaudeInteractionBridge({ database: input.pool, binding: input.binding,
      configuration: compiled.configuration, manager: { nativeCallbackContext: (sessionId, toolUseId) => actual?.nativeCallbackContext(sessionId, toolUseId) } })
    let callbackAuthority = await domain.callbackAdmission()
    signal.throwIfAborted()
    const scope = { deviceId: accepted.override.target.hostRef.mainId, profilePath: compiled.configuration.configDirectory,
      configRevision: accepted.currentBinding.pin.configRevision, cwd: input.workingDirectory }
    const runner = createClaudeSdkRunner({ loadClient: async () => {
      await input.profiles!.revalidate(profileOwner, accepted)
      await input.factories.assertInstallationUnchanged(installation, signal)
      signal.throwIfAborted()
      return (input.loadClient ?? ((selected) => loadOfficialClaudeSdk(selected.profilePath, selected.recovery, selected.binary)))({
        profilePath: scope.profilePath, recovery: input.recovery, binary,
      })
    } })
    allocated = manager => {
      actual = manager
      domain.bridge.subscribePending(notification => manager.notifyPendingChanged(notification))
      const initial = manager.startInitialTurn.bind(manager)
      manager.startInitialTurn = async function* (start, message, effectSignal) {
        if (input.appMcpAccess === 'none' && start.environment?.variables.GRAPHQL_MCP_TOKEN) throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID',
          'This Claude owner cannot inherit an application MCP credential.', 403)
        callbackAuthority = await domain.callbackAdmission()
        effectSignal?.throwIfAborted()
        yield* initial(start, { ...message, callbackAuthority }, effectSignal)
      }
      const attach = manager.attachSession.bind(manager)
      manager.attachSession = async (session, start, effectSignal) => {
        if (input.appMcpAccess === 'none' && start.environment?.variables.GRAPHQL_MCP_TOKEN) throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID',
          'This Claude owner cannot inherit an application MCP credential.', 403)
        await domain.callbackAdmission()
        effectSignal?.throwIfAborted()
        return attach(session, start, effectSignal)
      }
      const turn = manager.startTurn.bind(manager)
      manager.startTurn = async function* (session, message, effectSignal) {
        callbackAuthority = await domain.callbackAdmission()
        effectSignal?.throwIfAborted()
        const acceptedMessage = { ...message, callbackAuthority }
        yield* turn(session, acceptedMessage, effectSignal)
      }
    }
    if (input.files) {
      if (input.binding.kind === 'workflow') throw new DomainError('CLAUDE_FILE_SCOPE_UNAVAILABLE', 'Workflow file authority must use its admitted execution file domain.', 409)
      if (input.mode === 'replay' && !input.files.sdk) throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Claude file replay requires its SDK server/tool port.', 500)
      const sdk = await (input.files.sdk ? input.files.sdk() : import('@anthropic-ai/claude-agent-sdk'))
      signal.throwIfAborted()
      const allowMutation = compiled.configuration.sandbox !== 'read-only'
      fileServer = createClaudeFileMcpServer({ sdk, service: input.files.service(), allowMutation,
        calls: createClaudeFileCallResolver({ manager: () => actual, signal }),
        admission: productionClaudeFileAdmission({ pool: input.pool, binding: input.binding, manager: () => actual, allowMutation }) })
    }
    const callbacks = createClaudeSdkCallbacks({ manager: () => actual!, bridge: domain.bridge })
    const options = { cwd: compiled.cwd, model: compiled.model, permissionMode: compiled.permissionMode,
      ...(compiled.effort ? { effort: compiled.effort } : {}),
      tools: compiled.tools, allowedTools: compiled.allowedTools, disallowedTools: compiled.disallowedTools,
      strictMcpConfig: compiled.strictMcpConfig, settingSources: compiled.settingSources, systemPrompt: compiled.systemPrompt,
      mcpServers: { ...(input.appMcpAccess === 'none' ? Object.fromEntries(Object.entries(compiled.mcpServers).filter(([name]) => name !== 'graphql')) : compiled.mcpServers),
        ...(fileServer ? { 'graphql-files': fileServer.server } : {}) }, env: compiled.env, sandbox: compiled.sandbox, includePartialMessages: true, ...callbacks }
    return { harness: 'claude', role: input.role, workingDirectory: input.workingDirectory, ownerAgentId: input.ownerAgentId,
      appMcpAccess: input.appMcpAccess, processRecovery: input.recovery, scope, runner, sdkOptions: options,
      qualification: { sdkVersion: accepted.currentBinding.pin.sdkVersion, cliVersion: accepted.currentBinding.pin.cliVersion,
        basicTurns: compiled.qualification.basicTurns, resume: compiled.qualification.resume, fork: compiled.qualification.fork,
        history: compiled.qualification.history, interactions: compiled.qualification.policy.alwaysAppliedToolHook },
      inspectionStart, expectedMcp: { serverName: 'graphql',
        ...(compiled.mcpServers.graphql?.type === 'http' ? { url: compiled.mcpServers.graphql.url } : {}) },
      interactionPort: domain.interactionPort, liveCallbacks: domain.bridge, cancelPendingRequests: () => domain.bridge.close(),
      pendingInteractions: session => domain.bridge.pendingInteractions(session),
      ownerForStart: () => ({ ownerId: input.binding.kind === 'workflow' ? input.binding.runId : input.binding.conversationId,
        attemptId: callbackAuthority.attemptId, generation: input.recovery.launchId ?? callbackAuthority.attemptId }),
      // Filled by the common factory's construction callback below, before any SDK query.
      inspector: claudeProductionMcpInspector({ manager: () => actual!, start: inspectionStart,
        workingDirectory: input.workingDirectory, cliVersion: accepted.currentBinding.pin.cliVersion }),
    }
  }, result => allocated?.(result.manager))
  // Factory initialization remains lazy; the admitted allocator's exact instance
  // is captured in the construction callback rather than selected by harness ID.
  const refresh = result.manager.refreshInspectionCredentials.bind(result.manager)
  result.manager.refreshInspectionCredentials = async (start, servers, signal) => {
    const snapshot = await refresh(start, servers, signal)
    inspectedStart = structuredClone(start)
    return snapshot
  }
  const dispose = result.manager.dispose!.bind(result.manager)
  result.manager.dispose = async () => {
    try { await dispose() } finally { await fileServer?.close(); inspectedStart = undefined }
  }
  return { ...result, inspectionStart }
}
