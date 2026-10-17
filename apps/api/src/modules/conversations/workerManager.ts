import { sessionStartConfiguration, sessionStartDirectory } from '../harnesses/sessionStart.js'
import { definedProperties } from '../definedProperties.js'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'
import {
  CompactionStateSchema, ContextSnapshotSchema, McpDetectionSchema, NativeHarnessCapabilitiesSchema,
  PendingNativeInteractionSchema, SessionControlCapabilitiesSchema, SessionPreferencesSchema,
  type CompactionState, type ContextSnapshot, type NativeSessionReference, type SessionPreferences,
} from '@foreman-code/contracts'
import {
  WorkerConversationHistorySchema, WorkerConversationReceiptSchema, WorkerMcpInspectionSchema, WorkerResponseAvailabilitySchema,
  type WorkerConversationBinding, type WorkerConversationConfiguration, type WorkerConversationRpcRequest,
  type WorkerConversationProfileFacts,
  type WorkerClaudeAuthorityRequest,
  WorkerConversationResponsePageSchema, WORKER_CONVERSATION_RESPONSE_BYTES,
} from '@foreman-code/contracts/remote-execution-rpc'
import { readJsonContinuation } from '../runs/remote/jsonContinuation.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput,
  NativeInitialTurnInput, NativeCompactInput, NativeSteerInput, NativeResponseIdentity } from '../harnesses/port.js'
import { normalizeResponseAvailability, type NativeResponseAvailabilityQuery } from '../harnesses/responseAvailability.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { MainWorkerConversationBridge, type WorkerConversationCallbacks, type WorkerConversationChannel } from './workerBridge.js'
import { workerExecutionConfiguration } from './workerExecutionConfiguration.js'
import type { OperatorConfigurationVersion } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { PrepareWorkerFiles } from './mainWorkerFiles.js'

function conflict(message: string): never { throw new DomainError('WORKER_CONVERSATION_CONFLICT', message, 409) }
interface ManagerOptions {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  acceptedConfiguration?: OperatorConfigurationVersion
  channel: WorkerConversationChannel
  currentChannel?(): WorkerConversationChannel
  bridge: MainWorkerConversationBridge
  current(request: WorkerConversationRpcRequest, signal?: AbortSignal): Promise<void>
  observeSession?(session: NativeSessionReference): Promise<void>
  profile?(): Promise<WorkerConversationProfileFacts>
  claudeAuthority?(request: WorkerClaudeAuthorityRequest, signal: AbortSignal): Promise<unknown>
  sourceWorkingDirectory?: string
  files?: PrepareWorkerFiles
  previousConfiguration?: WorkerConversationConfiguration
  previousBinding?: WorkerConversationBinding
}

/** Main's existing native port targets one conversation on its selected paired worker. */
export class WorkerConversationManager implements NativeHarnessSessionManager {
  readonly harness
  private session: NativeSessionReference | undefined
  private receipt: z.infer<typeof WorkerConversationReceiptSchema> | undefined
  private preferences: SessionPreferences | undefined
  private context: ContextSnapshot | null = null
  private applied: SessionPreferences | null = null
  private readonly leases = new Set<ReturnType<MainWorkerConversationBridge['capture']>>()
  private credentialLease: ReturnType<MainWorkerConversationBridge['capture']> | undefined
  private readonly recoveredCallbacks = new Map<string, ReturnType<MainWorkerConversationBridge['capture']>>()
  private preparationActive = false
  private reconnecting: Promise<void> | undefined
  private readonly lifetime = new AbortController()

  constructor(private readonly options: ManagerOptions) {
    this.harness = options.binding.harness
    if (options.acceptedConfiguration) {
      if (!('operatorId' in options.configuration)) conflict('Presentation changes require an Operator configuration.')
      workerExecutionConfiguration(options.binding, options.acceptedConfiguration, options.configuration)
    }
  }

  private frame(input: Record<string, unknown>): WorkerConversationRpcRequest {
    return { ...input, binding: this.options.binding } as WorkerConversationRpcRequest
  }
  private async reconnect(signal?: AbortSignal) {
    this.lifetime.signal.throwIfAborted()
    if (this.reconnecting) return this.reconnecting
    const channel = this.options.currentChannel?.() ?? this.options.channel
    if (isDeepStrictEqual(channel.binding, this.options.channel.binding)) return
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) {
      if (channel.binding[field] !== this.options.channel.binding[field]) conflict('The original paired worker authority changed.')
    }
    const previousChannel = this.options.channel
    const task = (async () => {
      for (const lease of [...this.leases]) await this.release(lease)
      this.recoveredCallbacks.clear()
      this.credentialLease = undefined
      this.options.channel = channel
      if (!this.session) return
      const session = this.session
      const lease = this.captureConnected(this.frame({ method: 'conversation.open', mode: 'attach', source: session,
        operationId: this.receipt?.creation?.operationId ?? 'session-reconnect', configuration: this.options.configuration }))
      try {
        const receipt = this.adopt(await lease.request(signal), session)
        if (!receipt?.session || !isDeepStrictEqual(receipt.session, session)) conflict('The worker attached a different session.')
      } catch (error) {
        this.options.channel = previousChannel
        throw error
      } finally { await this.release(lease) }
    })()
    this.reconnecting = task
    try { await task } finally { this.reconnecting = undefined }
  }
  private async capture(frame: WorkerConversationRpcRequest, options: {
    callbacks?: WorkerConversationCallbacks; recoveredSubmission?: NativeMessageSubmission; recoveredTurnId?: string
  } = {}, signal?: AbortSignal) {
    await this.reconnect(signal)
    return this.captureConnected(frame, options)
  }
  private captureConnected(frame: WorkerConversationRpcRequest, options: {
    callbacks?: WorkerConversationCallbacks; recoveredSubmission?: NativeMessageSubmission; recoveredTurnId?: string
  } = {}): ReturnType<MainWorkerConversationBridge['capture']> {
    const channel = this.options.channel
    const captured = this.options.bridge.capture({ request: frame, channel,
      callbacks: { ...(this.options.profile ? { profile: this.options.profile } : {}),
        ...(this.options.files ? { files: this.options.files } : {}),
        ...(this.options.claudeAuthority ? { claudeAuthority: this.options.claudeAuthority } : {}), ...options.callbacks },
      ...(options.recoveredSubmission ? { recoveredSubmission: options.recoveredSubmission } : {}),
      ...(options.recoveredTurnId ? { recoveredTurnId: options.recoveredTurnId } : {}),
      current: async signal => {
        this.lifetime.signal.throwIfAborted()
        await this.options.current(frame, signal)
        if (!isDeepStrictEqual((this.options.currentChannel?.() ?? channel).binding, channel.binding)) {
          conflict('The admitted worker connection changed.')
        }
      } })
    const lease = { ...captured, request: async (signal?: AbortSignal) => {
      const raw = await captured.request(signal)
      if (frame.method === 'conversation.response-continuation') return raw
      const parsed = WorkerConversationResponsePageSchema.safeParse(raw)
      if (!parsed.success) return raw
      const first = parsed.data
      return readJsonContinuation(first.metadata, async metadata => {
        const continuation = this.captureConnected(this.frame({
          method: 'conversation.response-continuation', transferId: first.transferId, metadata,
        }))
        try {
          const next = WorkerConversationResponsePageSchema.parse(await continuation.request(signal))
          if (next.transferId !== first.transferId) conflict('The conversation response snapshot changed.')
          return next.metadata
        } finally { await this.release(continuation) }
      }, signal, { maxBytes: WORKER_CONVERSATION_RESPONSE_BYTES })
    } }
    this.leases.add(lease)
    return lease
  }
  private async release(lease: ReturnType<MainWorkerConversationBridge['capture']>) {
    await lease.close()
    this.leases.delete(lease)
  }
  private async releaseCredential() {
    if (this.credentialLease) await this.release(this.credentialLease)
    this.credentialLease = undefined
  }
  private async request(input: Record<string, unknown>, signal?: AbortSignal) {
    const lease = await this.capture(this.frame(input), {}, signal)
    try { return await lease.request(signal) } finally { await this.release(lease) }
  }
  private adopt(raw: unknown, attachment?: NativeSessionReference) {
    const value = z.object({ receipt: WorkerConversationReceiptSchema.optional() }).passthrough().parse(raw)
    const receipt = value.receipt
    if (!receipt) return undefined
    if (!isDeepStrictEqual(receipt.binding, this.options.binding)) conflict('The worker returned another conversation owner.')
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const) {
      if (receipt.connection[field] !== this.options.channel.binding[field]) conflict('The original worker installation changed.')
    }
    const older = this.receipt && receipt.revision < this.receipt.revision
    const transitions = older ? this.receipt : receipt
    let transitioned = older ? receipt.nativeOwner : this.receipt?.nativeOwner
    for (const change of transitions?.ownerTransitions ?? []) {
      if (change.previous.sessionId !== receipt.session?.nativeSessionId
        || change.next.sessionId !== receipt.session?.nativeSessionId) {
        conflict('The worker process transition belongs to another native session.')
      }
      if (isDeepStrictEqual(change.previous, transitioned)) transitioned = change.next
    }
    const recovered = this.receipt?.nativeOwner && receipt.revision !== this.receipt.revision
      && isDeepStrictEqual(older ? this.receipt.nativeOwner : receipt.nativeOwner, transitioned)
    if (this.receipt && (this.receipt.session && !isDeepStrictEqual(receipt.session, this.receipt.session)
      || this.receipt.nativeOwner && !isDeepStrictEqual(receipt.nativeOwner, this.receipt.nativeOwner)
        && !recovered && (!attachment || !isDeepStrictEqual(this.receipt.session, attachment)
          || !isDeepStrictEqual(receipt.session, attachment)))) {
      conflict('The original worker native owner changed.')
    }
    if (this.receipt && receipt.revision < this.receipt.revision) return this.receipt
    this.receipt = receipt
    this.applied = receipt.appliedPreferences
    if (receipt.session) this.session = structuredClone(receipt.session)
    return receipt
  }
  private assertSession(session: NativeSessionReference) {
    if (!this.session || !isDeepStrictEqual(this.session, session)) conflict('This manager does not own the addressed native session.')
  }
  private startFields(start: NativeSessionStart) {
    const configuration = sessionStartConfiguration(start)
    const workingDirectory = sessionStartDirectory(start)
    const roleMatches = this.options.binding.owner.kind === 'operator' ? start.kind === 'operator' : start.kind === 'agent-chat'
    if (!roleMatches || commandInputHash(configuration) !== commandInputHash(this.options.acceptedConfiguration ?? this.options.configuration)
      || commandInputHash(this.options.configuration) !== this.options.binding.owner.configurationHash
      || workingDirectory !== (this.options.sourceWorkingDirectory ?? this.options.binding.workingDirectory) || !start.correlationId) {
      conflict('The native startup differs from its saved conversation admission.')
    }
    const owner = this.options.binding.owner
    if (owner.kind === 'agent' && (start.kind !== 'agent-chat'
      || start.conversationId !== owner.conversationId || start.workflowId !== owner.workflowId
      || start.workflowNodeId !== owner.workflowNodeId
      || !isDeepStrictEqual(start.systemPrompt, this.options.binding.systemPrompt))) {
      conflict('The native startup belongs to another node conversation.')
    }
    const environment = start.environment
    const ownerId = this.options.binding.owner.kind === 'operator'
      ? this.options.binding.owner.operatorId : this.options.binding.owner.agentId
    if (environment && (environment.agentId !== ownerId
      || Object.keys(environment.variables).some(name => !(APP_MCP_TOKEN_NAMES as readonly string[]).includes(name)))) {
      conflict('Only this conversation’s scoped application credential may cross the worker channel.')
    }
    const token = environment && readProductEnvironment(environment.variables, 'MCP_TOKEN')
    if (token && (this.options.binding.owner.kind !== 'operator' || this.options.binding.appMcpAccess !== 'scoped')) {
      conflict('File-only or Agent chat cannot receive management MCP authority.')
    }
    return { operationId: start.correlationId, configuration: this.options.configuration,
      ...(this.preferences ? { preferences: this.preferences } : {}),
      ...(token ? { applicationAccess: { kind: 'operator-chat-mcp' as const, token } } : {}) }
  }
  private async open(start: NativeSessionStart, mode: 'create' | 'attach' | 'fork',
    source: NativeSessionReference | undefined, signal?: AbortSignal) {
    const fields = this.startFields(start)
    if (mode === 'attach' && start.kind === 'operator' && start.observationOnly) delete fields.applicationAccess
    const frame = this.frame({ method: 'conversation.open', ...fields, mode,
      ...(mode === 'attach' && this.options.previousBinding ? { previousBinding: this.options.previousBinding } : {}),
      ...(mode === 'attach' && this.options.previousConfiguration
        ? { previousConfiguration: this.options.previousConfiguration } : {}),
      ...(source ? { source } : {}) })
    const lease = await this.capture(frame, { callbacks: { sessionObserved: async session => {
      if (session.harness !== this.harness || mode === 'fork' && session.nativeSessionId === source?.nativeSessionId) {
        conflict('The worker returned a foreign or non-independent session.')
      }
      this.session = structuredClone(session)
      await this.options.observeSession?.(session)
      await this.releaseCredential()
    } } })
    try {
      const receipt = this.adopt(await lease.request(signal), mode === 'attach' ? source : undefined)
      if (!receipt?.session) conflict('Native creation is unresolved; a replacement session will not be created.')
      if (mode === 'attach' && !isDeepStrictEqual(receipt.session, source)) conflict('The worker attached a different session.')
      if (this.options.previousBinding) {
        await this.options.observeSession?.(receipt.session)
        delete this.options.previousBinding
        delete this.options.previousConfiguration
      }
      return receipt.session
    } finally { await this.release(lease) }
  }
  async createSession(start: NativeSessionStart, signal?: AbortSignal) { return this.open(start, 'create', undefined, signal) }
  async attachSession(session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    return this.open(start, 'attach', session, signal)
  }
  async forkSession(source: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    return this.open(start, 'fork', source, signal)
  }
  async reconcileSessionCreation(start: NativeSessionStart, signal?: AbortSignal, forkSource?: NativeSessionReference) {
    const fields = this.startFields(start)
    const raw = await this.request({ method: 'conversation.status' }, signal)
    const record = z.object({ receipt: WorkerConversationReceiptSchema.optional() }).parse(raw).receipt
    const inputHash = commandInputHash({ mode: forkSource ? 'fork' : 'create', source: forkSource ?? null,
      preferences: fields.preferences ?? null })
    if (!record?.session || record.creation?.operationId !== fields.operationId
      || record.creation.inputHash !== inputHash) conflict('The original worker session creation is not established.')
    this.adopt(raw)
    await this.options.observeSession?.(record.session)
    return record.session
  }
  async configureSessionPreferences(preferences: SessionPreferences) { this.preferences = SessionPreferencesSchema.parse(preferences) }
  async capabilities(signal?: AbortSignal) {
    this.preparationActive = true
    return NativeHarnessCapabilitiesSchema.parse(await this.request({ method: 'conversation.capabilities',
      configuration: this.options.configuration }, signal))
  }
  async inspectMcp(signal?: AbortSignal) {
    this.preparationActive = true
    return McpDetectionSchema.parse(await this.request({ method: 'conversation.inspect-mcp', configuration: this.options.configuration }, signal))
  }
  async mcpInspectionContext(signal?: AbortSignal) {
    signal?.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    return { runnerId: `device:${this.options.channel.binding.deviceId}`, workingDirectory: this.options.binding.workingDirectory }
  }
  readonly inspector: NativeMcpInspector = { inspect: async input => {
    this.preparationActive = true
    const value = WorkerMcpInspectionSchema.parse(await this.request({
    method: 'conversation.inspect-entry', configuration: this.options.configuration,
    inspection: { harness: input.harness, runnerId: input.runnerId, workingDirectory: input.workingDirectory,
      serverName: input.serverName, ...(input.phase ? { phase: input.phase } : {}) },
    }, input.signal))
    const entry = value.entry
    if (entry?.pairedEndpoint) {
      const host = this.options.binding.profile.target.hostRef
      const harness = this.options.configuration.harness
      const configured = harness.harness === 'claude' ? harness.mcpServers[entry.name] : undefined
      if (host.kind !== 'device' || entry.pairedEndpoint.mainId !== host.mainId
        || entry.pairedEndpoint.deviceId !== host.deviceId || configured?.type !== 'http'
        || configured.url !== entry.pairedEndpoint.configuredEndpoint
        || entry.endpoint !== entry.pairedEndpoint.nativeEndpoint) conflict('The paired MCP route differs from this saved profile.')
    }
    return { harness: value.harness, providerVersion: value.providerVersion, runnerId: value.runnerId,
      workingDirectory: value.workingDirectory, inspectedAt: value.inspectedAt,
      ...(value.generation !== undefined ? { generation: value.generation } : {}),
      ...(value.authorizationScope !== undefined ? { authorizationScope: value.authorizationScope } : {}),
      ...(entry ? { entry: { name: entry.name, transport: entry.transport,
        ...(entry.automaticEndpoint !== undefined ? { automaticEndpoint: entry.automaticEndpoint } : {}),
        ...(entry.endpoint !== undefined ? { endpoint: entry.endpoint } : {}),
        ...(entry.pairedEndpoint ? { pairedEndpoint: entry.pairedEndpoint } : {}),
        ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
        ...(entry.credentialEnvironmentVariable !== undefined ? { credentialEnvironmentVariable: entry.credentialEnvironmentVariable } : {}),
        ...(entry.credentialArrangement ? { credentialArrangement: entry.credentialArrangement } : {}),
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.enabledTools ? { enabledTools: entry.enabledTools } : {}),
        ...(entry.disabledTools ? { disabledTools: entry.disabledTools } : {}),
        ...(entry.nativeFilterDiagnostics ? { nativeFilterDiagnostics: entry.nativeFilterDiagnostics } : {}),
      } } : {}),
    }
  } }

  async deliverClaudeCredential(token: string, signal: AbortSignal) {
    if (this.harness !== 'claude' || this.options.binding.owner.kind !== 'operator'
      || this.options.binding.appMcpAccess !== 'scoped') conflict('This manager has no scoped Claude Operator credential.')
    this.preparationActive = true
    const lease = await this.capture(this.frame({
      method: 'conversation.refresh-mcp', configuration: this.options.configuration,
      applicationAccess: { kind: 'operator-chat-mcp', token },
    }))
    try {
      const result = z.object({ acknowledged: z.literal(true) }).strict().parse(await lease.request(signal))
      await this.releaseCredential()
      // Before native SID persistence, the normal credential relay needs its live startup admission.
      if (this.session) await this.release(lease)
      else this.credentialLease = lease
      return result
    } catch (error) { await this.release(lease); throw error }
  }

  private checkRejection(correlationId: string) {
    const turn = this.receipt?.turns.find(turn => turn.correlationId === correlationId)
    if (turn?.status !== 'rejected' || !turn.result) return
    throw Object.assign(new Error(turn.result.error?.message ?? 'Native input was not delivered.'), {
      result: turn.result, certainty: 'definite', deliveryState: 'not-delivered',
    })
  }

  private async *stream(frame: WorkerConversationRpcRequest, input: NativeTurnInput,
    initial: NativeInitialTurnInput | undefined, signal?: AbortSignal) {
    const lease = await this.capture(frame, { callbacks: {
      sessionObserved: async session => {
        if (!initial || session.harness !== this.harness) conflict('Unexpected initial native session observation.')
        await initial.onSessionObserved(session)
        this.session = structuredClone(session)
        await this.options.observeSession?.(session)
        await this.releaseCredential()
      },
      submitted: async (_correlationId, identity) => {
        if (identity.nativeTurnId) await input.onSubmitted?.(identity.nativeTurnId)
        if (identity.nativeSubmission) await input.onMessageSubmitted?.(identity.nativeSubmission)
      },
      settingsApplied: async () => { await input.onSettingsApplied?.() },
      terminalObserved: async observation => { await input.onTerminal?.(observation) },
    } })
    const pollSignal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    let sequence: number | undefined
    let pollDelayMs = 100
    try {
      if (this.session && !initial) {
        const history = await this.history(this.session, pollSignal)
        sequence = (history.nextSequence ?? Math.max(-1, ...history.events.map(event => event.sequence)) + 1) - 1
      }
      this.adopt(await lease.request(pollSignal))
      this.checkRejection(input.clientCorrelationId)
      while (true) {
        pollSignal.throwIfAborted()
        if (!this.session) {
          this.adopt(await this.request({ method: 'conversation.status' }, pollSignal))
          this.checkRejection(input.clientCorrelationId)
          if (!this.session) { await delay(100, undefined, { signal: pollSignal }); continue }
        }
        const value = z.object({ history: WorkerConversationHistorySchema, context: ContextSnapshotSchema.nullable(),
          receipt: WorkerConversationReceiptSchema }).parse(await this.request({ method: 'conversation.history',
          session: this.session, correlationId: input.clientCorrelationId,
          afterSequence: sequence ?? -1 }, pollSignal))
        this.adopt(value)
        this.checkRejection(input.clientCorrelationId)
        this.context = value.context
        if (sequence !== undefined && value.history.firstRetainedSequence !== undefined
          && sequence < value.history.firstRetainedSequence - 1) conflict('The worker event window has advanced; recover persisted history.')
        const previousSequence = sequence
        for (const event of value.history.events) {
          if (sequence !== undefined && event.sequence <= sequence) continue
          sequence = event.sequence
          yield event
        }
        const turn = value.receipt.turns.find(turn => turn.correlationId === input.clientCorrelationId)
        if (turn?.status === 'completed'
          && (value.history.nextSequence === undefined || (sequence ?? -1) >= value.history.nextSequence - 1)) return
        if (turn?.status === 'uncertain') conflict('The original worker turn needs native recovery; input was not replayed.')
        pollDelayMs = sequence === previousSequence ? Math.min(2000, pollDelayMs * 2) : 100
        await delay(pollDelayMs, undefined, { signal: pollSignal })
      }
    } finally { await this.release(lease) }
  }
  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.assertSession(session)
    return this.stream(this.frame({ method: 'conversation.start-turn', session, prompt: input.prompt,
      correlationId: input.clientCorrelationId, ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.sessionPreferences ? { preferences: input.sessionPreferences } : {}) }), input, undefined, signal)
  }
  startInitialTurn(start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal) {
    return this.stream(this.frame({ method: 'conversation.initial-turn', ...this.startFields(start),
      prompt: input.prompt, correlationId: input.clientCorrelationId,
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.sessionPreferences ? { preferences: input.sessionPreferences } : {}) }), input, input, signal)
  }
  async history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory> {
    return this.readHistory(session, signal)
  }
  async retireTurn(session: NativeSessionReference, correlationId: string) {
    this.assertSession(session)
    if (this.receipt?.creation?.operationId === correlationId
      && !this.receipt.turns.some(turn => turn.correlationId === correlationId)) return
    this.adopt(await this.request({ method: 'conversation.retire-turn', session, correlationId }))
  }
  private async readHistory(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory> {
    this.assertSession(session)
    return this.historyResponse(await this.request({ method: 'conversation.history', session }, signal))
  }
  private historyResponse(raw: unknown): NativeHistory {
    const value = z.object({ history: WorkerConversationHistorySchema, context: ContextSnapshotSchema.nullable(),
      receipt: WorkerConversationReceiptSchema }).parse(raw)
    this.adopt(value)
    this.context = value.context
    const history = value.history
    return { events: history.events, pendingInteractions: history.pendingInteractions,
      ...(history.nonSubmission ? { nonSubmission: history.nonSubmission } : {}),
      ...(history.correlationId !== undefined ? { correlationId: history.correlationId } : {}),
      ...(history.nativeTurnId !== undefined ? { nativeTurnId: history.nativeTurnId } : {}),
      ...(history.nativeMessageId !== undefined ? { nativeMessageId: history.nativeMessageId } : {}),
      ...(history.nativeSubmission !== undefined ? { nativeSubmission: history.nativeSubmission } : {}),
      ...(history.nextCursor !== undefined ? { nextCursor: history.nextCursor } : {}),
      ...(history.firstRetainedSequence !== undefined ? { firstRetainedSequence: history.firstRetainedSequence } : {}),
      ...(history.nextSequence !== undefined ? { nextSequence: history.nextSequence } : {}),
      ...(history.pendingInteraction !== undefined ? { pendingInteraction: history.pendingInteraction } : {}),
      ...(history.terminalResult !== undefined ? { terminalResult: history.terminalResult } : {}),
      ...(history.terminalTurn !== undefined ? { terminalTurn: history.terminalTurn } : {}),
      ...(history.interactionDeliveries ? { interactionDeliveries: history.interactionDeliveries.map(delivery => ({
        nativeRequestId: delivery.nativeRequestId, state: delivery.state,
        ...(delivery.selectedOptionId !== undefined ? { selectedOptionId: delivery.selectedOptionId } : {}),
      })) } : {}),
      ...(history.responseDeliveries ? { responseDeliveries: history.responseDeliveries.map(definedProperties) } : {}),
      ...(history.canceledRequestIds ? { canceledRequestIds: history.canceledRequestIds } : {}),
    }
  }
  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal) {
    this.assertSession(session)
    await this.reconnect(signal)
    const live = this.recoveredCallbacks.get(correlationId)
    if (live) {
      const history = this.historyResponse(await live.request(signal))
      if (this.receipt?.turns.find(turn => turn.correlationId === correlationId)?.status === 'completed') {
        await this.release(live)
        this.recoveredCallbacks.delete(correlationId)
      }
      return history
    }
    const accepted = this.receipt?.turns.find(turn => turn.correlationId === correlationId)
    const submission = this.harness === 'claude' ? accepted?.nativeSubmission : undefined
    const files = this.harness === 'codex' && this.options.files
    const recoveredTurnId = files
      && accepted?.status !== 'completed' ? accepted?.nativeTurnId : undefined
    const frame = this.frame({ method: 'conversation.reconcile', session, correlationId,
      ...(accepted?.sessionMode ? { sessionMode: accepted.sessionMode } : {}) })
    const lease = await this.capture(frame, { ...(submission ? { recoveredSubmission: submission } : {}),
      ...(recoveredTurnId ? { recoveredTurnId } : {}) })
    try {
      const history = this.historyResponse(await lease.request(signal))
      const previous = this.recoveredCallbacks.get(correlationId)
      if (previous) await this.release(previous)
      this.recoveredCallbacks.delete(correlationId)
      const turn = this.receipt?.turns.find(turn => turn.correlationId === correlationId)
      if ((submission || recoveredTurnId) && turn?.status !== 'completed') this.recoveredCallbacks.set(correlationId, lease)
      else await this.release(lease)
      return history
    } catch (error) {
      await this.release(lease)
      throw error
    }
  }
  private async recoverPendingCallbacks(session: NativeSessionReference, signal?: AbortSignal) {
    if (this.harness !== 'claude') return
    const turns = this.receipt?.turns.filter(turn => turn.status !== 'completed' && turn.nativeSubmission) ?? []
    if (turns.length > 1) conflict('The active native message is ambiguous.')
    const turn = turns[0]
    if (turn && !this.recoveredCallbacks.has(turn.correlationId)) {
      await this.reconcile(session, turn.correlationId, signal)
    }
  }
  async pending(session: NativeSessionReference, signal?: AbortSignal) {
    this.assertSession(session)
    await this.recoverPendingCallbacks(session, signal)
    const raw = await this.request({ method: 'conversation.pending', session }, signal)
    return raw == null ? undefined : PendingNativeInteractionSchema.parse(raw)
  }
  async respond(session: NativeSessionReference, nativeRequestId: string,
    option: Parameters<NativeHarnessSessionManager['respond']>[2], signal?: AbortSignal) {
    this.assertSession(session)
    await this.recoverPendingCallbacks(session, signal)
    this.adopt(await this.request({ method: 'conversation.respond', session, nativeRequestId, option }, signal))
  }
  async reconcileResponse(session: NativeSessionReference, response: NativeResponseIdentity, signal?: AbortSignal) {
    this.assertSession(session)
    return this.historyResponse(await this.request({ method: 'conversation.response-reconcile', session, response }, signal))
  }
  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery, signal?: AbortSignal) {
    this.assertSession(session)
    await this.recoverPendingCallbacks(session, signal)
    const value = WorkerResponseAvailabilitySchema.parse(await this.request({
      method: 'conversation.response-availability', session, query }, signal))
    return normalizeResponseAvailability(session, query, { nativeSessionId: value.nativeSessionId,
      nativeRequestId: value.nativeRequestId, nativeRequestType: value.nativeRequestType,
      qualified: value.qualified, state: value.state, path: value.path, reason: value.reason,
      ...(value.nativeTurnId ? { nativeTurnId: value.nativeTurnId } : {}),
      ...(value.nativeMessageId ? { nativeMessageId: value.nativeMessageId } : {}),
      ...(value.generation ? { generation: value.generation } : {}) })
  }
  async cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string) {
    this.assertSession(session)
    return z.object({ canceled: z.boolean() }).parse(await this.request({ method: 'conversation.cancel', session,
      ...(nativeTurnId ? { nativeTurnId } : {}) }, signal)).canceled
  }
  async steerTurn(session: NativeSessionReference, input: NativeSteerInput, signal?: AbortSignal) {
    this.assertSession(session)
    return z.object({ nativeTurnId: z.string().min(1) }).parse(await this.request({ method: 'conversation.steer',
      session, prompt: input.prompt, correlationId: input.clientCorrelationId, expectedTurnId: input.expectedTurnId }, signal))
  }
  async reconcileSteers(session: NativeSessionReference, inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[], signal?: AbortSignal) {
    this.assertSession(session)
    return z.array(z.object({ nativeSessionId: z.string(), nativeTurnId: z.string(), correlationId: z.string() })).parse(
      await this.request({ method: 'conversation.reconcile-steers', session, inputs }, signal))
  }
  async applySessionPreferences(session: NativeSessionReference, preferences: SessionPreferences, signal?: AbortSignal) {
    this.assertSession(session)
    this.adopt(await this.request({ method: 'conversation.preferences', session, preferences }, signal))
  }
  async sessionControlCapabilities(session: NativeSessionReference) {
    this.assertSession(session)
    const value = z.object({ capabilities: SessionControlCapabilitiesSchema, context: ContextSnapshotSchema.nullable(),
      preferences: SessionPreferencesSchema.nullable(), receipt: WorkerConversationReceiptSchema }).parse(
      await this.request({ method: 'conversation.controls-read', session }))
    const receipt = this.adopt(value)
    if (value.context && value.context.nativeSessionId !== session.nativeSessionId) conflict('The worker context belongs to another session.')
    this.context = value.context
    this.applied = receipt ? receipt.appliedPreferences : value.preferences
    return value.capabilities
  }
  contextSnapshot(session: NativeSessionReference) { this.assertSession(session); return this.context }
  appliedSessionPreferences(session: NativeSessionReference) { this.assertSession(session); return this.applied }
  async compactSession(session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal) {
    this.assertSession(session)
    await input.onDispatch?.()
    const frame = this.frame({ method: 'conversation.compact', session,
      requestId: input.requestId, correlationId: input.clientCorrelationId })
    const lease = await this.capture(frame)
    try {
      let state = z.object({ compaction: CompactionStateSchema }).parse(await lease.request(signal)).compaction
      while (true) {
        if (state.requestId !== input.requestId || state.nativeSessionId !== session.nativeSessionId) conflict('The worker compact result belongs to another request.')
        await input.onProgress(state)
        if (!['accepted', 'running', 'uncertain'].includes(state.status)) return state
        signal?.throwIfAborted()
        await delay(100, undefined, signal ? { signal } : {})
        state = await this.reconcileCompaction(session, state, signal)
        if (state.status === 'uncertain') return state
      }
    } finally { await this.release(lease) }
  }
  async reconcileCompaction(session: NativeSessionReference, state: CompactionState, signal?: AbortSignal) {
    this.assertSession(session)
    return z.object({ compaction: CompactionStateSchema }).parse(await this.request({
      method: 'conversation.compact-reconcile', session, state }, signal)).compaction
  }
  async readCompaction(session: NativeSessionReference, start: NativeSessionStart, state: CompactionState, signal?: AbortSignal) {
    const fields = this.startFields(start)
    const record = this.adopt(await this.request({ method: 'conversation.status' }, signal))
    if (!record?.session || !isDeepStrictEqual(record.session, session)) conflict('The persisted worker session changed.')
    const result = z.object({ compaction: CompactionStateSchema, receipt: WorkerConversationReceiptSchema }).parse(
      await this.request({ method: 'conversation.compact-read', session, state,
        configuration: fields.configuration, correlationId: fields.operationId }, signal))
    this.adopt(result)
    if (result.compaction.requestId !== state.requestId || result.compaction.nativeSessionId !== session.nativeSessionId) {
      conflict('The worker returned another compaction request.')
    }
    return result.compaction
  }
  async close(session: NativeSessionReference) {
    this.assertSession(session)
    this.adopt(await this.request({ method: 'conversation.close', session }))
  }
  async closeForRestart(session: NativeSessionReference) { this.assertSession(session); await this.dispose() }
  async dispose() {
    if (this.preparationActive && !this.session && !this.lifetime.signal.aborted) {
      await this.request({ method: 'conversation.release-preparation' })
      this.preparationActive = false
    }
    this.lifetime.abort(new DomainError('ENGINE_RESTART', 'Main detached its worker conversation observer.', 503))
    for (const lease of this.leases) await this.release(lease)
    this.recoveredCallbacks.clear()
    this.credentialLease = undefined
  }
}
