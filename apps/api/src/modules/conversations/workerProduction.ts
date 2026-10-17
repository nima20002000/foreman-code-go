import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { NativeSessionReferenceSchema, withAdvancedDefaults, RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { PromptSettingSnapshot } from '@foreman-code/contracts'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { WorkerConversationBindingSchema, type WorkerConversationConfiguration,
  WorkerConversationProfileFactsSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { requireAuthorization } from '../access/policy.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { createAdmittedNativeManager } from '../harnesses/admittedManager.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { HarnessQualificationRepository } from '../harnesses/qualification/repository.js'
import { readInstalledCodexQualification } from '../harnesses/installedCodexInspection.js'
import type { AcceptedHarnessProfileAdmission, AcceptedProfileSelector } from '../harnesses/instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from '../harnesses/claudeSdk/production.js'
import type { ClaudeDomainBinding } from '../harnesses/claudeSdk/domainAuthority.js'

import { PostgresClaudeInteractionAuthority } from '../harnesses/claudeSdk/domainAuthority.js'
import type { ClaudeCallbackIdentity } from '../harnesses/claudeSdk/interactions.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import type { PostgresAgentChatRepository } from './agentChatRepository.js'
import { nativeCorrelation } from './operatorChatRepository.js'
import { agentChatCorrelation } from './agentChatRepository.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { DomainError } from '../errors.js'
import { MainWorkerConversationMcp } from './mainWorkerMcp.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { SelectedMainMcpForward } from '../placement/workerMcpRelay.js'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { workerOperatorDirectory } from './workerOperatorDirectory.js'
import { AgentChatDirectoryBindingSchema } from '@foreman-code/contracts/agent-chat'
import { revalidateAgentChatDirectory } from './agentChatDirectory.js'
import type { PrepareWorkerFiles } from './mainWorkerFiles.js'
import { createMainWorkerClaudeFiles } from './mainWorkerClaudeFiles.js'
import type { AgentFileToolService } from '../files/tools/service.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { workerExecutionConfiguration } from './workerExecutionConfiguration.js'
import { definedProperties } from '../definedProperties.js'
import { readExecutionPlacement, readNativePlacement } from '../placement/persistence.js'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'
import { legacyProviderAccountBinding, readProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'

type ConversationClaudeOwner = Extract<ClaudeDomainBinding, { kind: 'operator' | 'agent' }>

const reads = new Set(['conversation.status', 'conversation.history', 'conversation.reconcile', 'conversation.pending',
  'conversation.controls-read', 'conversation.compact-reconcile', 'conversation.reconcile-steers',
  'conversation.capabilities', 'conversation.inspect-mcp', 'conversation.inspect-entry', 'conversation.compact-read',
  'conversation.response-reconcile', 'conversation.response-availability'])
reads.add('conversation.release-preparation')
reads.add('conversation.response-continuation')
interface OwnerRow {
  id: string; kind: 'operator' | 'agent'; workspace_id: string | null; workflow_id: string | null
  workflow_node_id: string | null; agent_id: string | null; owner_principal_id: string | null
  operator_configuration_version_id: string | null; agent_configuration_version_id: string | null
  active_request_id: string | null; native_session_id: string | null; deleted_at: unknown
  record: { status?: string; directoryBinding?: unknown; systemPrompt?: PromptSettingSnapshot;
    origin?: { kind: string; runId?: string; executionId?: string; sourceNativeSessionId?: string } }
  payload: { ownerPrincipalId?: string } | null
  worker_conversation_binding: unknown
}
function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}

interface ProductionWorkerConversationsInput {
  pool: pg.Pool
  endpoint(): Pick<DeviceEndpoint, 'captureRequest'>
  profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  claudeProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  operators: PostgresOperatorConversationRepository
  agents: PostgresAgentChatRepository
  registry: ProductionHarnessRegistry
  qualifications: Pick<HarnessQualificationRepository, 'findInstalled'>
  suiteRevisions: Partial<Record<'codex', string>>
  access: Pick<PostgresAccessService, 'authenticate'>
  mcpForward(): SelectedMainMcpForward
  files?(conversationId: string, configuration: WorkerConversationConfiguration, workingDirectory: string): PrepareWorkerFiles
  fileService?(): AgentFileToolService
}

interface WorkerConversationOptions {
  conversationId: string
  configuration: WorkerConversationConfiguration
  workingDirectory: string
  appMcpAccess: 'scoped' | 'none'
  observationPrincipalId?: string
  profileSelection?: AcceptedProfileSelector
  sourceExecution?: WorkerConversationBinding['sourceExecution']
}

async function authorizeWorkerConversationRequest(pool: pg.Pool, live: OwnerRow,
  request: WorkerConversationRpcRequest, context: {
    caller: string | undefined
    requestCallers: WeakMap<WorkerConversationRpcRequest, string>
    changingAccess: boolean | string | null
    originalBinding: WorkerConversationBinding
  }) {
  let currentCaller = context.requestCallers.get(request)
  if (!currentCaller) {
    const messageOperation = request.method === 'conversation.start-turn'
      || request.method === 'conversation.initial-turn' || request.method === 'conversation.open'
    currentCaller = messageOperation ? live.payload?.ownerPrincipalId ?? live.owner_principal_id ?? undefined
      : context.caller ?? live.payload?.ownerPrincipalId ?? live.owner_principal_id ?? undefined
    if (currentCaller) context.requestCallers.set(request, currentCaller)
  }
  if (!currentCaller || live.kind === 'operator' && live.owner_principal_id !== currentCaller) {
    unavailable('The original conversation caller changed.')
  }
  if (context.changingAccess && request.method === 'conversation.open'
    && (!live.active_request_id || request.mode !== 'attach'
      || request.operationId !== nativeCorrelation(live.id, live.active_request_id)
      || !isDeepStrictEqual(request.previousBinding, context.originalBinding))) {
    unavailable('The native access change differs from the admitted Operator message.')
  }
  if (context.changingAccess && request.method === 'conversation.refresh-mcp' && !live.active_request_id) {
    unavailable('A scoped native access change requires its admitted Operator message.')
  }
  const principal = (await currentOperatorAuthority(pool, currentCaller)).principal
  const scope = live.kind === 'agent' ? { workspaceId: live.workspace_id!, workflowId: live.workflow_id!,
    ...(live.record.origin?.runId ? { runId: live.record.origin.runId } : {}) } : {}
  const prefix = live.kind === 'operator' ? 'operator_chat' : 'agent_chat'
  requireAuthorization(principal, `${prefix}:read`, scope)
  if (!reads.has(request.method)) {
    let action: 'operator_chat:cancel' | 'agent_chat:cancel' | 'operator_chat:respond' | 'agent_chat:respond'
      | 'operator_chat:write' | 'agent_chat:write' = `${prefix}:write`
    if (request.method === 'conversation.cancel') action = `${prefix}:cancel`
    if (request.method === 'conversation.respond') action = `${prefix}:respond`
    requireAuthorization(principal, action, scope)
  }
  if (request.method === 'conversation.start-turn' || request.method === 'conversation.initial-turn'
    || request.method === 'conversation.steer') {
    const correlation = live.kind === 'operator' ? nativeCorrelation(live.id, live.active_request_id ?? '')
      : agentChatCorrelation(live.id, live.active_request_id ?? '')
    if (!live.active_request_id || request.correlationId !== correlation) unavailable('The admitted chat message changed.')
  }
  if ('session' in request && live.native_session_id && live.native_session_id !== request.session.nativeSessionId) {
    unavailable('The addressed native session changed.')
  }
  if (request.method === 'conversation.open' && request.mode === 'fork') {
    const source = live.record.origin
    if (source?.kind !== 'run_execution' || !source.executionId || !source.runId || !request.source
      || source.sourceNativeSessionId !== request.source.nativeSessionId) unavailable('The Run source does not belong to this chat.')
    const stored = (await pool.query<{ reference: unknown }>(`select s.reference from execution_native_sessions s
      join harness_executions e on e.id=s.execution_id where s.execution_id=$1 and e.run_id=$2`,
    [source.executionId, source.runId])).rows[0]
    if (!stored || !isDeepStrictEqual(NativeSessionReferenceSchema.parse(stored.reference), request.source)) {
      unavailable('The original Run native source is unavailable.')
    }
  }
  return currentCaller
}

async function assertConversationSource(pool: pg.Pool,
  sourceExecution: WorkerConversationOptions['sourceExecution'], live: OwnerRow) {
  if (!sourceExecution) return
  if (live.kind !== 'agent' || live.record.origin?.kind !== 'run_execution'
    || live.record.origin.executionId !== sourceExecution.executionId
    || live.record.origin.runId !== sourceExecution.placement.runId
    || !isDeepStrictEqual(await readExecutionPlacement(pool, sourceExecution.executionId),
      sourceExecution.placement)
    || !isDeepStrictEqual((await readNativePlacement(pool, sourceExecution.executionId))?.workingTree,
      sourceExecution.workingTree)) unavailable('The original Run chat placement changed.')
}

async function admitWorkerConversation(input: ProductionWorkerConversationsInput,
  options: WorkerConversationOptions, context: {
    configuration: WorkerConversationConfiguration
    selector: AcceptedProfileSelector
    owner: ConversationClaudeOwner
    profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
    kind: 'operator' | 'agent'
    bridge: MainWorkerConversationBridge
    caller(): string | undefined
    row(conversationId: string): Promise<OwnerRow>
  }, signal: AbortSignal) {
  const { configuration, selector, owner, profiles, kind, bridge, row } = context
  const original = await row(options.conversationId)
  const sourceExecution = options.sourceExecution
  const assertSource = (live: OwnerRow) => assertConversationSource(input.pool, sourceExecution, live)
  await assertSource(original)
  const directoryBinding = original.kind === 'agent' && original.record.directoryBinding
    ? AgentChatDirectoryBindingSchema.parse(original.record.directoryBinding) : undefined
  if ('agentId' in configuration && directoryBinding) {
    await revalidateAgentChatDirectory(input.pool, configuration, directoryBinding, options.workingDirectory)
  }
  const principalId = context.caller() ?? original.payload?.ownerPrincipalId ?? original.owner_principal_id
  if (!principalId) unavailable('The chat has no admitted sender or control caller.')
  const profileOwner = { ...owner, ...(options.observationPrincipalId
    ? { observationPrincipalId: principalId } : { controlPrincipalId: principalId }), admissionSignal: signal }
  const accepted = await profiles.admit(profileOwner, selector)
  if (!isDeepStrictEqual(withAdvancedDefaults(accepted.override.configuration), withAdvancedDefaults(configuration.harness))) {
    unavailable('The worker profile differs from this saved chat configuration.')
  }
  const host = selector.target.hostRef
  if (host.kind !== 'device') unavailable('The accepted host is not a device.')
  const channel = input.endpoint().captureRequest(host.deviceId, 'execution-v1')
  if (!channel || channel.binding.mainId !== host.mainId
    || channel.binding.workerInstallationId !== selector.target.applicationInstallationId) {
    unavailable('The selected paired worker channel is unavailable.')
  }
  const currentChannel = () => {
    const actual = input.endpoint().captureRequest(host.deviceId, 'execution-v1')
    if (!actual) unavailable('The selected paired worker channel is unavailable.')
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (actual.binding[field] !== channel.binding[field]) unavailable('The original paired worker authority changed.')
    }
    return actual
  }
  const ownerFields = 'operatorId' in configuration
    ? { kind: 'operator', operatorId: configuration.operatorId }
    : { kind: 'agent', workspaceId: configuration.workspaceId, agentId: configuration.agentId,
      workflowId: original.workflow_id, workflowNodeId: original.workflow_node_id }
  const savedBinding = original.worker_conversation_binding
    ? WorkerConversationBindingSchema.parse(original.worker_conversation_binding) : undefined
  let executionConfiguration = configuration
  if (savedBinding && savedBinding.owner.configurationVersionId !== configuration.id
    && savedBinding.owner.kind === 'operator' && 'operatorId' in configuration) {
    const previous = await input.operators.configuration(savedBinding.owner.configurationVersionId)
    executionConfiguration = workerExecutionConfiguration(savedBinding, configuration, previous)
  }
  const requestedBinding = WorkerConversationBindingSchema.parse({ owner: { ...ownerFields,
    conversationId: options.conversationId, configurationVersionId: executionConfiguration.id,
    configurationHash: commandInputHash(executionConfiguration) }, harness: configuration.harness.harness,
    profile: selector, workingDirectory: options.workingDirectory, appMcpAccess: options.appMcpAccess,
    accountBinding: await readProviderAccountBinding(input.pool,
      original.kind === 'agent' ? 'agent-conversation' : 'operator-command',
      original.kind === 'agent' ? original.id : `${original.id}:session`)
      ?? legacyProviderAccountBinding(executionConfiguration.harness, executionConfiguration.harnessProfileSelection),
    ...(original.kind === 'agent' && original.record.systemPrompt ? { systemPrompt: original.record.systemPrompt } : {}),
    ...(sourceExecution ? { sourceExecution } : {}),
    ...(directoryBinding ? { directoryBinding } : {}) })
  if (requestedBinding.owner.kind === 'operator') {
    const rootChannel = input.endpoint().captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)
    if (!rootChannel || !isDeepStrictEqual(rootChannel.binding, channel.binding)) {
      unavailable('The selected worker’s approved runtime root is unavailable.')
    }
    const reply = await rootChannel.request({ version: 1, operation: 'workspace-roots.configuration' }, { signal })
    const roots = ApprovedRootAllowlistSchema.parse(reply.payload)
    if (reply.bytes !== undefined || !isDeepStrictEqual(roots.hostRef, host)
      || roots.applicationInstallationId !== selector.target.applicationInstallationId
      || !isDeepStrictEqual(input.endpoint().captureRequest(host.deviceId, 'execution-v1')?.binding, channel.binding)) {
      unavailable('The selected worker root or connection changed.')
    }
    requestedBinding.workingDirectory = workerOperatorDirectory(roots.managedRuntimeRoot, requestedBinding.owner)
    await profiles.revalidate(profileOwner, accepted)
  }
  const originalBinding = original.worker_conversation_binding
    ? WorkerConversationBindingSchema.parse(original.worker_conversation_binding) : requestedBinding
  const observationBinding = { ...originalBinding, appMcpAccess: requestedBinding.appMcpAccess }
  const changingAccess = !options.observationPrincipalId && original.native_session_id
    && originalBinding.appMcpAccess !== requestedBinding.appMcpAccess
    && sameConversationForAppAccess(originalBinding, requestedBinding)
  if (!changingAccess && !isDeepStrictEqual(options.observationPrincipalId ? observationBinding : originalBinding, requestedBinding)) {
    unavailable('The original worker conversation binding changed.')
  }
  const binding = changingAccess ? requestedBinding : originalBinding
  const requestCallers = new WeakMap<WorkerConversationRpcRequest, string>()
  const current = async (request: WorkerConversationRpcRequest, effectSignal?: AbortSignal) => {
    const live = await row(options.conversationId)
    await assertSource(live)
    const configurationId = live.kind === 'operator' ? live.operator_configuration_version_id : live.agent_configuration_version_id
    if (live.kind !== kind || configurationId !== configuration.id
      || 'agentId' in configuration && (live.workspace_id !== configuration.workspaceId || live.agent_id !== configuration.agentId)) {
      unavailable('The original conversation configuration changed.')
    }
    if (live.worker_conversation_binding) {
      const savedBinding = WorkerConversationBindingSchema.parse(live.worker_conversation_binding)
      if (!isDeepStrictEqual(savedBinding, originalBinding) && !isDeepStrictEqual(savedBinding, binding)) {
        unavailable('The persisted worker conversation owner changed.')
      }
    }
    if (live.kind === 'agent' && !isDeepStrictEqual(live.record.systemPrompt, binding.systemPrompt)) {
      unavailable('The saved chat system prompt changed.')
    }
    if ('agentId' in configuration && directoryBinding) {
      if (!isDeepStrictEqual(live.record.directoryBinding, directoryBinding)) unavailable('The saved node directory changed.')
      await revalidateAgentChatDirectory(input.pool, configuration, directoryBinding, binding.workingDirectory)
    }
    const currentCaller = await authorizeWorkerConversationRequest(input.pool, live, request, {
      caller: context.caller(), requestCallers, changingAccess, originalBinding,
    })
    const observation = { ...owner, observationPrincipalId: currentCaller,
      ...(effectSignal ? { admissionSignal: effectSignal } : {}) }
    await profiles.revalidate(observation, accepted)
    currentChannel()
  }
  const claudeFiles = configuration.harness.harness === 'claude' && input.fileService
    ? createMainWorkerClaudeFiles({ pool: input.pool, binding: owner, service: input.fileService,
      allowMutation: configuration.harness.sandbox !== 'read-only' }) : undefined
  const manager = new WorkerConversationManager({ binding, configuration: executionConfiguration,
    channel, currentChannel, bridge, current,
    ...(executionConfiguration !== configuration && 'operatorId' in configuration
      ? { acceptedConfiguration: configuration } : {}),
    ...(changingAccess ? { previousBinding: originalBinding } : {}),
    sourceWorkingDirectory: options.workingDirectory,
    ...(configuration.harness.harness === 'codex' && binding.appMcpAccess === 'none' && input.files
      ? { files: input.files(options.conversationId, configuration, binding.workingDirectory) } : {}),
    ...(configuration.harness.harness === 'claude' ? { claudeAuthority: async (
      request: import('@foreman-code/contracts/remote-execution-rpc').WorkerClaudeAuthorityRequest,
      effectSignal: AbortSignal) => {
      effectSignal.throwIfAborted()
      const context = request.phase === 'admission' ? undefined : request.identity
      const authority = new PostgresClaudeInteractionAuthority(input.pool, owner, {
        nativeCallbackContext: (sessionId, toolUseId) => context
          && context.nativeSessionId === sessionId && context.toolUseId === toolUseId ? context : undefined,
      })
      if (request.phase === 'admission') return authority.callbackAdmission()
      const { nativeTurnId, nativeRequestId, nativeRequestType, ...required } = request.identity
      const identity: ClaudeCallbackIdentity = { ...definedProperties(required),
        ...(nativeTurnId !== undefined ? { nativeTurnId } : {}),
        ...(nativeRequestId !== undefined ? { nativeRequestId } : {}),
        ...(nativeRequestType !== undefined ? { nativeRequestType } : {}),
      }
      if (request.phase === 'pending') await authority.publishPending(identity, request.pending)
      else if (request.phase === 'response') await authority.validateResponse(identity, {
        outcome: request.answer.outcome,
        ...(request.answer.reason !== undefined ? { reason: request.answer.reason } : {}),
      })
      else await authority.validate(identity)
      effectSignal.throwIfAborted()
      if (request.phase === 'file') {
        if (!claudeFiles || identity.nativeTurnId !== undefined) unavailable('This native file callback is unavailable.')
        return claudeFiles.call(request, identity, effectSignal)
      }
      return { authorized: true }
    } } : {}),
    profile: async () => {
      const installation = input.registry.pinOverride(accepted.override).installation
      let qualification: HarnessQualification | null = null
      const harness = configuration.harness.harness
      const binary = installation.launcher.resolvedLauncher
      const sha256 = installation.launcher.payloadFingerprints?.find(value => value.path === binary)?.fingerprint
      const revision = harness === 'codex' ? input.suiteRevisions.codex : undefined
      if (harness !== 'claude' && sha256 && revision) {
        qualification = await readInstalledCodexQualification(input.qualifications,
          { target: accepted.override.target, binarySha256: sha256, installation }, revision)
      }
      return WorkerConversationProfileFactsSchema.parse({
        installation: qualification ? { ...installation, observedVersion: qualification.version } : installation,
        override: accepted.override,
        profile: accepted.persistedProof, qualification })
    },
    observeSession: async session => {
      const saved = await input.pool.query(`update operator_conversations set worker_conversation_binding=$2::jsonb
        where id=$1 and deleted_at is null
          and record->>'status' is distinct from 'archived'
          and coalesce(operator_configuration_version_id,agent_configuration_version_id)=$4
          and (native_session_id is null or native_session_id=$3)
          and (worker_conversation_binding is null or worker_conversation_binding=$2::jsonb
            or worker_conversation_binding=$5::jsonb)`,
      [options.conversationId, JSON.stringify(binding), session.nativeSessionId, configuration.id,
        changingAccess ? JSON.stringify(originalBinding) : JSON.stringify(binding)])
      if (saved.rowCount !== 1) unavailable('The native worker owner could not be retained.')
    } })
  if (claudeFiles) {
    const dispose = manager.dispose.bind(manager)
    manager.dispose = async () => { try { await dispose() } finally { await claudeFiles.close() } }
  }
  return { manager, inspector: manager.inspector }
}

export function createProductionWorkerConversations(input: ProductionWorkerConversationsInput) {
  const bridge = new MainWorkerConversationBridge()
  const inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  const credentials = new WeakMap<NativeHarnessSessionManager, (
    token: string, signal: AbortSignal) => Promise<unknown>>()
  const row = async (conversationId: string) => {
    const result = (await input.pool.query<OwnerRow>(`select c.*,t.payload from operator_conversations c
      left join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
      where c.id=$1`, [conversationId])).rows[0]
    if (!result || result.deleted_at || result.record.status === 'archived') unavailable('The addressed chat is no longer open.')
    return result
  }
  const create = (options: WorkerConversationOptions) => {
    const configuration = structuredClone(options.configuration)
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const selector = options.profileSelection ?? configuration.harnessProfileSelection
    if (!selector || selector.target.hostRef.kind !== 'device') unavailable('A selected device profile is required.')
    let caller = options.observationPrincipalId
    const kind = 'operatorId' in configuration ? 'operator' : 'agent'
    const owner: ConversationClaudeOwner = 'operatorId' in configuration
      ? { kind: 'operator', conversationId: options.conversationId, repository: input.operators }
      : { kind: 'agent', conversationId: options.conversationId,
        workspaceId: configuration.workspaceId, repository: input.agents }
    const profiles = configuration.harness.harness === 'claude' ? input.claudeProfiles : input.profiles
    const admitted = createAdmittedNativeManager<WorkerConversationManager>(configuration.harness.harness,
      signal => admitWorkerConversation(input, options, {
        configuration, selector, owner, profiles, kind, bridge, row, caller: () => caller,
      }, signal))
    admitted.manager.setSessionControlPrincipal = principalId => { caller = principalId }
    if (configuration.harness.harness === 'codex') {
      admitted.manager.reconcileSessionCreation = async (start, signal, forkSource) => {
        const manager = await admitted.actual(signal)
        return manager.reconcileSessionCreation(start, signal, forkSource)
      }
    }
    admitted.manager.mcpInspectionContext = async signal => {
      const manager = await admitted.actual(signal)
      return manager.mcpInspectionContext!(signal)
    }
    if (configuration.harness.harness === 'claude') {
      admitted.manager.startInitialTurn = async function* (start, turn, signal) {
        const manager = await admitted.actual(signal)
        if (!manager.startInitialTurn) unavailable('The worker Claude adapter does not support atomic initial message admission.')
        yield* manager.startInitialTurn(start, turn, signal)
      }
    }
    inspectors.set(admitted.manager, admitted.inspector)
    if (configuration.harness.harness === 'claude' && kind === 'operator' && options.appMcpAccess === 'scoped') {
      credentials.set(admitted.manager, async (token, signal) => {
        const manager = await admitted.actual(signal)
        return manager.deliverClaudeCredential(token, signal)
      })
    }
    return admitted.manager
  }
  const mcp = new MainWorkerConversationMcp({ pool: input.pool, access: input.access, operators: input.operators,
    profiles: input.profiles, claudeProfiles: input.claudeProfiles, bridge,
    current: deviceId => input.endpoint().captureRequest(deviceId, 'execution-v1')?.binding, forward: input.mcpForward })
  return { create, bridge, mcp, inspector: (manager: NativeHarnessSessionManager) => inspectors.get(manager),
    deliverClaudeCredential: (manager: NativeHarnessSessionManager) => credentials.get(manager),
    close: () => bridge.close() }
}
