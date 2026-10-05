import { sessionStartConfiguration, sessionStartDirectory } from '../harnesses/sessionStart.js'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import {
  CompactionStateSchema, ContextSnapshotSchema, McpDetectionSchema, NativeHarnessCapabilitiesSchema,
  PendingNativeInteractionSchema, SessionControlCapabilitiesSchema, SessionPreferencesSchema,
  type CompactionState, type ContextSnapshot, type NativeSessionReference, type SessionPreferences,
} from '@foreman-code/contracts'
import {
  WorkerConversationHistorySchema, WorkerConversationReceiptSchema, WorkerMcpInspectionSchema, WorkerResponseAvailabilitySchema,
  type WorkerConversationBinding, type WorkerConversationConfiguration, type WorkerConversationRpcRequest,
  type WorkerConversationProfileFacts,
} from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput,
  NativeInitialTurnInput, NativeCompactInput, NativeSteerInput, NativeResponseIdentity } from '../harnesses/port.js'
import { normalizeResponseAvailability, type NativeResponseAvailabilityQuery } from '../harnesses/responseAvailability.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { MainWorkerConversationBridge, type WorkerConversationCallbacks, type WorkerConversationChannel } from './workerBridge.js'
import { DomainError } from '../errors.js'

function conflict(message: string): never { throw new DomainError('WORKER_CONVERSATION_CONFLICT', message, 409) }
interface ManagerOptions {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  channel: WorkerConversationChannel
  bridge: MainWorkerConversationBridge
  current(request: WorkerConversationRpcRequest): Promise<void>
  observeSession?(session: NativeSessionReference): Promise<void>
  profile?(): Promise<WorkerConversationProfileFacts>
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
  private readonly lifetime = new AbortController()

  constructor(private readonly options: ManagerOptions) { this.harness = options.binding.harness }

  private frame(input: Record<string, unknown>): WorkerConversationRpcRequest {
    return { ...input, binding: this.options.binding } as WorkerConversationRpcRequest
  }
  private capture(frame: WorkerConversationRpcRequest, callbacks: WorkerConversationCallbacks = {}) {
    const lease = this.options.bridge.capture({ request: frame, channel: this.options.channel,
      callbacks: { ...(this.options.profile ? { profile: this.options.profile } : {}), ...callbacks },
      current: () => { this.lifetime.signal.throwIfAborted(); return this.options.current(frame) } })
    this.leases.add(lease)
    return lease
  }
  private release(lease: ReturnType<MainWorkerConversationBridge['capture']>) {
    lease.close()
    this.leases.delete(lease)
  }
  private async request(input: Record<string, unknown>, signal?: AbortSignal) {
    const lease = this.capture(this.frame(input))
    try { return await lease.request(signal) } finally { this.release(lease) }
  }
  private adopt(raw: unknown) {
    const value = z.object({ receipt: WorkerConversationReceiptSchema.optional() }).passthrough().parse(raw)
    const receipt = value.receipt
    if (!receipt) return undefined
    if (!isDeepStrictEqual(receipt.binding, this.options.binding)) conflict('The worker returned another conversation owner.')
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const) {
      if (receipt.connection[field] !== this.options.channel.binding[field]) conflict('The original worker installation changed.')
    }
    if (this.receipt && (receipt.revision < this.receipt.revision
      || this.receipt.session && !isDeepStrictEqual(receipt.session, this.receipt.session)
      || this.receipt.nativeOwner && !isDeepStrictEqual(receipt.nativeOwner, this.receipt.nativeOwner))) {
      conflict('The original worker native owner changed.')
    }
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
    if (!roleMatches || commandInputHash(configuration) !== this.options.binding.owner.configurationHash
      || workingDirectory !== this.options.binding.workingDirectory || !start.correlationId) {
      conflict('The native startup differs from its saved conversation admission.')
    }
    const owner = this.options.binding.owner
    if (owner.kind === 'agent' && (start.kind !== 'agent-chat'
      || start.conversationId !== owner.conversationId || start.workflowId !== owner.workflowId
      || start.workflowNodeId !== owner.workflowNodeId)) {
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
    const frame = this.frame({ method: 'conversation.open', ...this.startFields(start), mode,
      ...(source ? { source } : {}) })
    const lease = this.capture(frame, { sessionObserved: async session => {
      if (session.harness !== this.harness || mode === 'fork' && session.nativeSessionId === source?.nativeSessionId) {
        conflict('The worker returned a foreign or non-independent session.')
      }
      this.session = structuredClone(session)
      await this.options.observeSession?.(session)
    } })
    try {
      const receipt = this.adopt(await lease.request(signal))
      if (!receipt?.session) conflict('Native creation is unresolved; a replacement session will not be created.')
      if (mode === 'attach' && !isDeepStrictEqual(receipt.session, source)) conflict('The worker attached a different session.')
      return receipt.session
    } finally { this.release(lease) }
  }
  async createSession(start: NativeSessionStart, signal?: AbortSignal) { return this.open(start, 'create', undefined, signal) }
  async attachSession(session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    return this.open(start, 'attach', session, signal)
  }
  async forkSession(source: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal) {
    return this.open(start, 'fork', source, signal)
  }
  async configureSessionPreferences(preferences: SessionPreferences) { this.preferences = SessionPreferencesSchema.parse(preferences) }
  async capabilities(signal?: AbortSignal) {
    return NativeHarnessCapabilitiesSchema.parse(await this.request({ method: 'conversation.capabilities',
      configuration: this.options.configuration }, signal))
  }
  async inspectMcp(signal?: AbortSignal) {
    return McpDetectionSchema.parse(await this.request({ method: 'conversation.inspect-mcp', configuration: this.options.configuration }, signal))
  }
  readonly inspector: NativeMcpInspector = { inspect: async input => {
    const value = WorkerMcpInspectionSchema.parse(await this.request({
    method: 'conversation.inspect-entry', configuration: this.options.configuration,
    inspection: { harness: input.harness, runnerId: input.runnerId, workingDirectory: input.workingDirectory,
      serverName: input.serverName, ...(input.phase ? { phase: input.phase } : {}) },
    }, input.signal))
    const entry = value.entry
    return { harness: value.harness, providerVersion: value.providerVersion, runnerId: value.runnerId,
      workingDirectory: value.workingDirectory, inspectedAt: value.inspectedAt,
      ...(value.generation !== undefined ? { generation: value.generation } : {}),
      ...(value.authorizationScope !== undefined ? { authorizationScope: value.authorizationScope } : {}),
      ...(entry ? { entry: { name: entry.name, transport: entry.transport,
        ...(entry.automaticEndpoint !== undefined ? { automaticEndpoint: entry.automaticEndpoint } : {}),
        ...(entry.endpoint !== undefined ? { endpoint: entry.endpoint } : {}),
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

  private async *stream(frame: WorkerConversationRpcRequest, input: NativeTurnInput,
    initial: NativeInitialTurnInput | undefined, signal?: AbortSignal) {
    const lease = this.capture(frame, {
      sessionObserved: async session => {
        if (!initial || session.harness !== this.harness) conflict('Unexpected initial native session observation.')
        await initial.onSessionObserved(session)
        this.session = structuredClone(session)
        await this.options.observeSession?.(session)
      },
      submitted: async (_correlationId, identity) => {
        if (identity.nativeTurnId) await input.onSubmitted?.(identity.nativeTurnId)
        if (identity.nativeSubmission) await input.onMessageSubmitted?.(identity.nativeSubmission)
      },
      settingsApplied: async () => { await input.onSettingsApplied?.() },
    })
    const pollSignal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    let sequence: number | undefined
    try {
      if (this.session && !initial) {
        const history = await this.history(this.session, pollSignal)
        sequence = (history.nextSequence ?? Math.max(-1, ...history.events.map(event => event.sequence)) + 1) - 1
      }
      this.adopt(await lease.request(pollSignal))
      while (true) {
        pollSignal.throwIfAborted()
        if (!this.session) {
          this.adopt(await this.request({ method: 'conversation.status' }, pollSignal))
          if (!this.session) { await delay(100, undefined, { signal: pollSignal }); continue }
        }
        const value = z.object({ history: WorkerConversationHistorySchema, context: ContextSnapshotSchema.nullable(),
          receipt: WorkerConversationReceiptSchema }).parse(await this.request({ method: 'conversation.history',
          session: this.session, correlationId: input.clientCorrelationId }, pollSignal))
        this.adopt(value)
        this.context = value.context
        if (sequence !== undefined && value.history.firstRetainedSequence !== undefined
          && sequence < value.history.firstRetainedSequence - 1) conflict('The worker event window has advanced; recover persisted history.')
        for (const event of value.history.events) {
          if (sequence !== undefined && event.sequence <= sequence) continue
          sequence = event.sequence
          yield event
        }
        const turn = value.receipt.turns.find(turn => turn.correlationId === input.clientCorrelationId)
        if (turn?.status === 'completed') return
        if (turn?.status === 'uncertain') conflict('The original worker turn needs native recovery; input was not replayed.')
        await delay(100, undefined, { signal: pollSignal })
      }
    } finally { this.release(lease) }
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
    return this.readHistory(session, {}, signal)
  }
  private async readHistory(session: NativeSessionReference, fields: Record<string, unknown>, signal?: AbortSignal): Promise<NativeHistory> {
    this.assertSession(session)
    return this.historyResponse(await this.request({ method: 'conversation.history', session, ...fields }, signal))
  }
  private historyResponse(raw: unknown): NativeHistory {
    const value = z.object({ history: WorkerConversationHistorySchema, context: ContextSnapshotSchema.nullable(),
      receipt: WorkerConversationReceiptSchema }).parse(raw)
    this.adopt(value)
    this.context = value.context
    const history = value.history
    return { events: history.events, pendingInteractions: history.pendingInteractions,
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
      ...(history.responseDeliveries ? { responseDeliveries: history.responseDeliveries } : {}),
      ...(history.canceledRequestIds ? { canceledRequestIds: history.canceledRequestIds } : {}),
    }
  }
  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal) {
    return this.readHistory(session, { correlationId }, signal)
  }
  async historyPage(session: NativeSessionReference, before?: string, signal?: AbortSignal) {
    return this.readHistory(session, before ? { before } : {}, signal)
  }
  async pending(session: NativeSessionReference, signal?: AbortSignal) {
    this.assertSession(session)
    const raw = await this.request({ method: 'conversation.pending', session }, signal)
    return raw == null ? undefined : PendingNativeInteractionSchema.parse(raw)
  }
  async respond(session: NativeSessionReference, nativeRequestId: string,
    option: Parameters<NativeHarnessSessionManager['respond']>[2], signal?: AbortSignal) {
    this.assertSession(session)
    this.adopt(await this.request({ method: 'conversation.respond', session, nativeRequestId, option }, signal))
  }
  async reconcileResponse(session: NativeSessionReference, response: NativeResponseIdentity, signal?: AbortSignal) {
    this.assertSession(session)
    return this.historyResponse(await this.request({ method: 'conversation.response-reconcile', session, response }, signal))
  }
  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery, signal?: AbortSignal) {
    this.assertSession(session)
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
    this.adopt(value)
    if (value.context && value.context.nativeSessionId !== session.nativeSessionId) conflict('The worker context belongs to another session.')
    this.context = value.context
    this.applied = value.preferences
    return value.capabilities
  }
  contextSnapshot(session: NativeSessionReference) { this.assertSession(session); return this.context }
  appliedSessionPreferences(session: NativeSessionReference) { this.assertSession(session); return this.applied }
  async compactSession(session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal) {
    this.assertSession(session)
    await input.onDispatch?.()
    const frame = this.frame({ method: 'conversation.compact', session,
      requestId: input.requestId, correlationId: input.clientCorrelationId })
    const lease = this.capture(frame)
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
    } finally { this.release(lease) }
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
    this.lifetime.abort(new DomainError('ENGINE_RESTART', 'Main detached its worker conversation observer.', 503))
    for (const lease of this.leases) this.release(lease)
  }
}
