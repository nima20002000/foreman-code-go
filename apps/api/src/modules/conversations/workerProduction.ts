import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { NativeSessionReferenceSchema, withAdvancedDefaults } from '@foreman-code/contracts'
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
import type { AcceptedHarnessProfileAdmission } from '../harnesses/instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from '../harnesses/claudeSdk/production.js'
import { PostgresClaudeInteractionAuthority } from '../harnesses/claudeSdk/domainAuthority.js'
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

const reads = new Set(['conversation.status', 'conversation.history', 'conversation.reconcile', 'conversation.pending',
  'conversation.controls-read', 'conversation.compact-reconcile', 'conversation.reconcile-steers',
  'conversation.capabilities', 'conversation.inspect-mcp', 'conversation.inspect-entry', 'conversation.compact-read',
  'conversation.response-reconcile', 'conversation.response-availability'])
interface OwnerRow {
  id: string; kind: 'operator' | 'agent'; workspace_id: string | null; workflow_id: string | null
  workflow_node_id: string | null; agent_id: string | null; owner_principal_id: string | null
  operator_configuration_version_id: string | null; agent_configuration_version_id: string | null
  active_request_id: string | null; native_session_id: string | null; deleted_at: unknown
  record: { status?: string; origin?: { kind: string; runId?: string; executionId?: string; sourceNativeSessionId?: string } }
  payload: { ownerPrincipalId?: string } | null
  worker_conversation_binding: unknown
}
function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}

export function createProductionWorkerConversations(input: {
  pool: pg.Pool
  endpoint(): Pick<DeviceEndpoint, 'captureRequest'>
  profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  claudeProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  operators: PostgresOperatorConversationRepository
  agents: PostgresAgentChatRepository
  registry: ProductionHarnessRegistry
  qualifications: Pick<HarnessQualificationRepository, 'find'>
  suiteRevisions: Partial<Record<'codex' | 'opencode', string>>
  access: Pick<PostgresAccessService, 'authenticate'>
  mcpForward(): SelectedMainMcpForward
}) {
  const bridge = new MainWorkerConversationBridge()
  const inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  const row = async (conversationId: string) => {
    const result = (await input.pool.query<OwnerRow>(`select c.*,t.payload from operator_conversations c
      left join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
      where c.id=$1`, [conversationId])).rows[0]
    if (!result || result.deleted_at || result.record.status === 'archived') unavailable('The addressed chat is no longer open.')
    return result
  }
  const create = (options: { conversationId: string; configuration: WorkerConversationConfiguration;
    workingDirectory: string; appMcpAccess: 'scoped' | 'none'; observationPrincipalId?: string }) => {
    const configuration = structuredClone(options.configuration)
    const selector = configuration.harnessProfileSelection
    if (!selector || selector.target.hostRef.kind !== 'device') unavailable('A selected device profile is required.')
    let caller = options.observationPrincipalId
    const kind = 'operatorId' in configuration ? 'operator' : 'agent'
    const owner: ClaudeProfileOwner = 'operatorId' in configuration
      ? { kind: 'operator', conversationId: options.conversationId, repository: input.operators }
      : { kind: 'agent', conversationId: options.conversationId,
        workspaceId: configuration.workspaceId, repository: input.agents }
    const profiles = configuration.harness.harness === 'claude' ? input.claudeProfiles : input.profiles
    const admitted = createAdmittedNativeManager(configuration.harness.harness, async signal => {
      const original = await row(options.conversationId)
      const principalId = caller ?? original.payload?.ownerPrincipalId ?? original.owner_principal_id
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
      const ownerFields = 'operatorId' in configuration
        ? { kind: 'operator', operatorId: configuration.operatorId }
        : { kind: 'agent', workspaceId: configuration.workspaceId, agentId: configuration.agentId,
          workflowId: original.workflow_id, workflowNodeId: original.workflow_node_id }
      const requestedBinding = WorkerConversationBindingSchema.parse({ owner: { ...ownerFields,
        conversationId: options.conversationId, configurationVersionId: configuration.id,
        configurationHash: commandInputHash(configuration) }, harness: configuration.harness.harness,
        profile: selector, workingDirectory: options.workingDirectory, appMcpAccess: options.appMcpAccess })
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
      const binding = original.worker_conversation_binding
        ? WorkerConversationBindingSchema.parse(original.worker_conversation_binding) : requestedBinding
      const observationBinding = { ...binding, appMcpAccess: requestedBinding.appMcpAccess }
      if (!isDeepStrictEqual(options.observationPrincipalId ? observationBinding : binding, requestedBinding)) {
        unavailable('The original worker conversation binding changed.')
      }
      const requestCallers = new WeakMap<WorkerConversationRpcRequest, string>()
      const current = async (request: WorkerConversationRpcRequest, effectSignal?: AbortSignal) => {
        const live = await row(options.conversationId)
        const configurationId = live.kind === 'operator' ? live.operator_configuration_version_id : live.agent_configuration_version_id
        if (live.kind !== kind || configurationId !== configuration.id
          || 'agentId' in configuration && (live.workspace_id !== configuration.workspaceId || live.agent_id !== configuration.agentId)) {
          unavailable('The original conversation configuration changed.')
        }
        let currentCaller = requestCallers.get(request)
        if (!currentCaller) {
          const messageOperation = request.method === 'conversation.start-turn'
            || request.method === 'conversation.initial-turn' || request.method === 'conversation.open'
          currentCaller = messageOperation ? live.payload?.ownerPrincipalId ?? live.owner_principal_id ?? undefined
            : caller ?? live.payload?.ownerPrincipalId ?? live.owner_principal_id ?? undefined
          if (currentCaller) requestCallers.set(request, currentCaller)
        }
        if (!currentCaller || live.kind === 'operator' && live.owner_principal_id !== currentCaller) {
          unavailable('The original conversation caller changed.')
        }
        const principal = (await currentOperatorAuthority(input.pool, currentCaller)).principal
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
          const stored = (await input.pool.query<{ reference: unknown }>(`select s.reference from execution_native_sessions s
            join harness_executions e on e.id=s.execution_id where s.execution_id=$1 and e.run_id=$2`,
          [source.executionId, source.runId])).rows[0]
          if (!stored || !isDeepStrictEqual(NativeSessionReferenceSchema.parse(stored.reference), request.source)) {
            unavailable('The original Run native source is unavailable.')
          }
        }
        const observation = { ...owner, observationPrincipalId: currentCaller,
          ...(effectSignal ? { admissionSignal: effectSignal } : {}) }
        await profiles.revalidate(observation, accepted)
        const actual = input.endpoint().captureRequest(host.deviceId, 'execution-v1')
        if (!actual || !isDeepStrictEqual(actual.binding, channel.binding)) unavailable('The original paired worker generation changed.')
      }
      const manager = new WorkerConversationManager({ binding, configuration, channel, bridge, current,
        sourceWorkingDirectory: options.workingDirectory,
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
          if (request.phase === 'pending') await authority.publishPending(request.identity, request.pending)
          else if (request.phase === 'response') await authority.validateResponse(request.identity, {
            outcome: request.answer.outcome,
            ...(request.answer.reason !== undefined ? { reason: request.answer.reason } : {}),
          })
          else await authority.validate(request.identity)
          effectSignal.throwIfAborted()
          return { authorized: true }
        } } : {}),
        profile: async () => {
          const installation = input.registry.pinOverride(accepted.override).installation
          let qualification: HarnessQualification | null = null
          const harness = configuration.harness.harness
          const binary = installation.launcher.resolvedLauncher
          const sha256 = installation.launcher.payloadFingerprints?.find(value => value.path === binary)?.fingerprint
          const revision = harness === 'claude' ? undefined : input.suiteRevisions[harness]
          if (harness !== 'claude' && sha256 && installation.observedVersion && revision) {
            qualification = await input.qualifications.find(harness, installation.observedVersion, sha256, revision)
          }
          return WorkerConversationProfileFactsSchema.parse({ installation, override: accepted.override,
            profile: accepted.persistedProof, qualification })
        },
        observeSession: async session => {
          const saved = await input.pool.query(`update operator_conversations set worker_conversation_binding=$2::jsonb
            where id=$1 and deleted_at is null
              and record->>'status' is distinct from 'archived'
              and coalesce(operator_configuration_version_id,agent_configuration_version_id)=$4
              and (native_session_id is null or native_session_id=$3)
              and (worker_conversation_binding is null or worker_conversation_binding=$2::jsonb)`,
          [options.conversationId, JSON.stringify(binding), session.nativeSessionId, configuration.id])
          if (saved.rowCount !== 1) unavailable('The native worker owner could not be retained.')
        } })
      return { manager, inspector: manager.inspector }
    })
    admitted.manager.setSessionControlPrincipal = principalId => { caller = principalId }
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
    return admitted.manager
  }
  const mcp = new MainWorkerConversationMcp({ pool: input.pool, access: input.access, operators: input.operators,
    profiles: input.profiles, claudeProfiles: input.claudeProfiles, bridge,
    current: deviceId => input.endpoint().captureRequest(deviceId, 'execution-v1')?.binding, forward: input.mcpForward })
  return { create, bridge, mcp, inspector: (manager: NativeHarnessSessionManager) => inspectors.get(manager),
    close: () => bridge.close() }
}
