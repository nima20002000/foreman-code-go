import { errorMessage } from '../../shared/errorMessage.js'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import {
  WorkerConversationRpcRequestSchema, workerConversationProfileSelection, type WorkerConversationBinding, type WorkerConversationConfiguration,
  type WorkerConversationReceipt, type WorkerConversationRpcRequest,
} from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { RemoteNativeIdentity } from '@foreman-code/contracts/remote-execution'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import { compactionBlocksSend, type CompactionState } from '@foreman-code/contracts'
import { isDefiniteCompactionRejection, NativeDeliveryError } from '../harnesses/errors.js'
import { recoverPersistedClaudeCompaction } from '../harnesses/claudeSdk/recoverCompaction.js'
import { unavailableNativeResponse } from '../harnesses/responseAvailability.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'

export interface WorkerConversationAllocation {
  manager: NativeHarnessSessionManager
  inspector?: NativeMcpInspector
  start(input: { correlationId: string; instructionsDelivered: boolean;
    applicationAccess?: { kind: 'operator-chat-mcp'; token: string } }): Promise<NativeSessionStart>
  nativeOwner(session: NativeSessionReference): Promise<RemoteNativeIdentity>
  close(): Promise<void>
  deliverClaudeCredential?(token: string, signal: AbortSignal): Promise<void>
  recoverClaudeAuthority?(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
    submission: NonNullable<WorkerConversationReceipt['turns'][number]['nativeSubmission']>, signal: AbortSignal): Promise<void>
  recoverFiles?(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
    nativeTurnId: string, signal: AbortSignal): Promise<void>
}
export interface WorkerConversationHostPorts {
  journal: WorkerConversationJournal
  currentBinding(): Readonly<DeviceSessionBinding>
  /** Main verifies the original admitted message/control and current role grants. */
  authorize(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<void>
  allocate(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<WorkerConversationAllocation>
  prepare?(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<WorkerConversationAllocation>
  recover?(record: WorkerConversationReceipt, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal,
    request: WorkerConversationRpcRequest): Promise<WorkerConversationAllocation>
  readCompaction?(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.compact-read' }>,
    record: WorkerConversationReceipt, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<CompactionState>
  /** Native callbacks stay behind Main's persisted identity acknowledgement. */
  observeSession(binding: WorkerConversationBinding, session: NativeSessionReference,
    request: WorkerConversationRpcRequest, signal: AbortSignal): Promise<void>
  observeSubmission(binding: WorkerConversationBinding, correlationId: string,
    identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>,
    request: WorkerConversationRpcRequest, signal: AbortSignal): Promise<void>
  observeSettings?(request: WorkerConversationRpcRequest, correlationId: string, signal: AbortSignal): Promise<void>
  observeTerminal?(request: WorkerConversationRpcRequest,
    observation: import('../harnesses/port.js').NativeTerminalObservation, signal: AbortSignal): Promise<void>
}
interface Resident {
  binding: WorkerConversationBinding
  configuration: WorkerConversationConfiguration
  allocation: WorkerConversationAllocation
}
function unavailable(message: string): never {
  throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', message, 409)
}
function sessionOwner(identity: RemoteNativeIdentity): RemoteNativeIdentity {
  return { sessionId: identity.sessionId, processIdentityDigest: identity.processIdentityDigest }
}
function validateConfiguration(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration) {
  const owner = binding.owner
  const roleMatches = owner.kind === 'operator'
    ? 'operatorId' in configuration && configuration.operatorId === owner.operatorId
    : 'agentId' in configuration && configuration.agentId === owner.agentId
      && configuration.workspaceId === owner.workspaceId
  if (!roleMatches || configuration.id !== owner.configurationVersionId
    || commandInputHash(configuration) !== owner.configurationHash
    || configuration.harness.harness !== binding.harness
    || !isDeepStrictEqual(workerConversationProfileSelection(binding, configuration), binding.profile)) {
    unavailable('The saved chat configuration differs from its selected worker owner.')
  }
}

/** Conversation operations share execution-v1 and the existing native adapters. */
export class WorkerConversationHost {
  private readonly residents = new Map<string, Resident>()
  private readonly preparations = new Map<string, Resident>()
  private readonly inspections = new Set<WorkerConversationAllocation>()
  private readonly allocating = new Map<string, Promise<Resident>>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly log = componentLogger('harness')
  private closing = false

  constructor(private readonly ports: WorkerConversationHostPorts) {}

  private current(binding: WorkerConversationBinding, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    signal.throwIfAborted()
    const target = binding.profile.target
    if (this.closing || !isDeepStrictEqual(this.ports.currentBinding(), connection)
      || target.hostRef.kind !== 'device' || target.hostRef.mainId !== connection.mainId
      || target.hostRef.deviceId !== connection.deviceId
      || target.applicationInstallationId !== connection.workerInstallationId) {
      unavailable('The selected chat worker connection changed.')
    }
  }

  private async authorize(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    this.current(request.binding, connection, signal)
    await this.ports.authorize(request, connection, signal)
    this.current(request.binding, connection, signal)
  }

  private async allocate(request: Extract<WorkerConversationRpcRequest, { configuration: WorkerConversationConfiguration }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<Resident> {
    validateConfiguration(request.binding, request.configuration)
    const id = request.binding.owner.conversationId
    const original = this.residents.get(id)
    if (original) {
      if (!isDeepStrictEqual(original.binding, request.binding)
        || !isDeepStrictEqual(original.configuration, request.configuration)) unavailable('The native chat owner changed.')
      return original
    }
    const opening = this.allocating.get(id)
    if (opening) {
      await opening
      return this.allocate(request, connection, signal)
    }
    const task = (async () => {
      const record = await this.ports.journal.read(request.binding)
      if (record?.closed || record?.closing) unavailable('The native chat is closing or closed.')
      if (record?.applicationAccessChange?.state === 'reserved') unavailable('The native App MCP access change needs recovery.')
      const allocation = record?.session
        ? await this.recover(record, request.configuration, connection, signal, request)
        : await this.ports.allocate(request.binding, request.configuration, connection, signal)
      try {
        this.current(request.binding, connection, signal)
        if (allocation.manager.harness !== request.binding.harness) unavailable('The worker allocated another native driver.')
        const resident = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.residents.set(id, resident)
        const preparation = this.preparations.get(id)
        if (preparation) {
          await preparation.allocation.close()
          this.preparations.delete(id)
        }
        return resident
      } catch (error) { this.residents.delete(id); await allocation.close(); throw error }
    })()
    this.allocating.set(id, task)
    try { return await task } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private async prepare(request: Extract<WorkerConversationRpcRequest, { configuration: WorkerConversationConfiguration }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<Resident> {
    validateConfiguration(request.binding, request.configuration)
    const id = request.binding.owner.conversationId
    const live = this.residents.get(id)
    const previousPreparation = this.preparations.get(id)
    if (previousPreparation && !isDeepStrictEqual(previousPreparation.binding, request.binding)
      && sameConversationForAppAccess(previousPreparation.binding, request.binding)) {
      await previousPreparation.allocation.close()
      this.preparations.delete(id)
    }
    const resident = live && isDeepStrictEqual(live.binding, request.binding) ? live : this.preparations.get(id)
    if (resident) {
      if (!isDeepStrictEqual(resident.binding, request.binding)
        || !isDeepStrictEqual(resident.configuration, request.configuration)) unavailable('The native chat owner changed.')
      return resident
    }
    const record = await this.ports.journal.inspectBinding(request.binding)
    if (!this.ports.prepare) {
      if (!record?.session) return this.allocate(request, connection, signal)
      unavailable('The original chat is not available for inspection.')
    }
    if (record?.closing || record?.closed) unavailable('The original chat is not available for inspection.')
    const opening = this.allocating.get(id)
    if (opening) {
      await opening
      return this.prepare(request, connection, signal)
    }
    const task = (async () => {
      const allocation = await this.ports.prepare!(request.binding, request.configuration, connection, signal)
      try {
        this.current(request.binding, connection, signal)
        const prepared = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.preparations.set(id, prepared)
        return prepared
      } catch (error) { await allocation.close(); throw error }
    })()
    this.allocating.set(id, task)
    try { return await task } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private async inspectConfiguration(
    request: Extract<WorkerConversationRpcRequest, { method: 'conversation.inspect-entry' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal,
  ) {
    validateConfiguration(request.binding, request.configuration)
    if (!this.ports.prepare) unavailable('Separate native configuration inspection is unavailable.')
    const record = await this.ports.journal.inspectBinding(request.binding)
    if (record?.closing || record?.closed) unavailable('The original chat is not available for inspection.')
    const key = `inspection:${randomUUID()}`
    const opening = this.ports.prepare(request.binding, request.configuration, connection, signal).then(async allocation => {
      try {
        this.current(request.binding, connection, signal)
        this.inspections.add(allocation)
        return { binding: request.binding, configuration: request.configuration, allocation }
      } catch (error) {
        await allocation.close()
        throw error
      }
    })
    this.allocating.set(key, opening)
    let allocation: WorkerConversationAllocation | undefined
    try {
      allocation = (await opening).allocation
      if (!allocation.inspector) unavailable('Native configuration inspection is unavailable.')
      const result = await allocation.inspector.inspect({ ...request.inspection, phase: 'configuration', signal })
      this.current(request.binding, connection, signal)
      return result
    } finally {
      this.allocating.delete(key)
      if (allocation) {
        await allocation.close()
        this.inspections.delete(allocation)
      }
    }
  }

  private recover(record: WorkerConversationReceipt, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal, request: WorkerConversationRpcRequest) {
    if (!this.ports.recover) unavailable('The original worker process needs native recovery before it can be attached.')
    return this.ports.recover(record, configuration, connection, signal, request)
  }

  private async resident(request: WorkerConversationRpcRequest & { session: NativeSessionReference }) {
    let record = await this.ports.journal.read(request.binding)
    const resident = this.residents.get(request.binding.owner.conversationId)
    if (!record || !isDeepStrictEqual(record.session, request.session) || !resident
      || record.applicationAccessChange?.state === 'reserved'
      || !isDeepStrictEqual(resident.binding, request.binding)) unavailable('The original chat session is not resident.')
    const owner = sessionOwner(await resident.allocation.nativeOwner(request.session))
    record = await this.ports.journal.read(request.binding)
    if (!record || !isDeepStrictEqual(record.nativeOwner, owner)) {
      unavailable('The original native chat process changed.')
    }
    return { resident, record }
  }

  private track(task: Promise<void>) {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  private async bind(resident: Resident, session: NativeSessionReference,
    request: WorkerConversationRpcRequest, signal: AbortSignal) {
    await this.ports.journal.bindSession(resident.binding, session,
      sessionOwner(await resident.allocation.nativeOwner(session)))
    await this.ports.observeSession(resident.binding, session, request, signal)
  }

  private async open(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.open' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    validateConfiguration(request.binding, request.configuration)
    if (request.mode !== 'create' && !request.source) unavailable('Native attachment or fork requires its source session.')
    if (request.previousBinding) return this.changeApplicationAccess(request, connection, signal)
    const record = await this.ports.journal.receive(request.binding, connection)
    const resident = await this.allocate(request, connection, signal)
    if (request.mode === 'fork' && !resident.allocation.manager.forkSession) {
      unavailable('The selected native driver cannot fork a chat session.')
    }
    if (request.mode === 'attach') {
      if (!record.session || !isDeepStrictEqual(record.session, request.source)) unavailable('A different session cannot replace this chat.')
      await this.ports.journal.rebind(request.binding, connection,
        sessionOwner(await resident.allocation.nativeOwner(record.session)))
      return { receipt: await this.ports.journal.read(request.binding) }
    }
    const reserved = await this.ports.journal.reserveCreation(request.binding, request.operationId,
      commandInputHash({ mode: request.mode, source: request.source ?? null, preferences: request.preferences ?? null }))
    if (!reserved.dispatch) return { receipt: reserved.record }
    if (request.preferences) {
      await resident.allocation.manager.configureSessionPreferences?.(request.preferences)
      await this.ports.journal.preferences(request.binding, request.preferences, null)
    }
    await this.authorize(request, connection, signal)
    const start = await resident.allocation.start({ correlationId: request.operationId,
      instructionsDelivered: request.mode === 'fork',
      ...(request.applicationAccess ? { applicationAccess: request.applicationAccess } : {}) })
    const manager = resident.allocation.manager
    let session: NativeSessionReference
    if (request.mode === 'fork') {
      if (!manager.forkSession) unavailable('The selected native driver cannot fork a chat session.')
      session = await manager.forkSession(request.source!, start, signal)
      if (session.nativeSessionId === request.source!.nativeSessionId) unavailable('The native fork returned its source session.')
    } else session = await manager.createSession(start, signal)
    await this.bind(resident, session, request, signal)
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private async changeApplicationAccess(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.open' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const previous = request.previousBinding!
    validateConfiguration(request.binding, request.configuration)
    if (request.mode !== 'attach' || !request.source || !sameConversationForAppAccess(previous, request.binding)) {
      unavailable('App MCP access changes keep the original Operator owner, profile and session.')
    }
    const id = request.binding.owner.conversationId
    if (this.allocating.has(id) || this.running.has(id)) unavailable('The native conversation is busy.')
    const task = (async (): Promise<Resident> => {
      const reserved = await this.ports.journal.reserveApplicationAccess(previous, request.binding, request.operationId, request.source!)
      if (reserved.applied) {
        const resident = this.residents.get(id)
        if (resident && isDeepStrictEqual(resident.binding, request.binding)) return resident
        const allocation = await this.recover(reserved.record, request.configuration, connection, signal, request)
        const recovered = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.residents.set(id, recovered)
        return recovered
      }
      const old = this.residents.get(id)
      if (old) {
        if (!isDeepStrictEqual(old.binding, previous)
          || reserved.reserved && !isDeepStrictEqual(reserved.record.nativeOwner,
            sessionOwner(await old.allocation.nativeOwner(request.source!)))) unavailable('The original native process changed.')
        await old.allocation.close()
        this.residents.delete(id)
      }
      const preparation = this.preparations.get(id)
      if (preparation) {
        await preparation.allocation.close()
        this.preparations.delete(id)
      }
      await this.authorize(request, connection, signal)
      const allocation = await this.recover(reserved.record, request.configuration, connection, signal, request)
      const resident = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
      this.residents.set(id, resident)
      return resident
    })()
    this.allocating.set(id, task)
    try {
      await task
      await this.authorize(request, connection, signal)
      return { receipt: await this.ports.journal.read(request.binding) }
    } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private callbacks(resident: Resident, request: Extract<WorkerConversationRpcRequest,
    { method: 'conversation.initial-turn' | 'conversation.start-turn' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): NativeTurnInput {
    return {
      prompt: request.prompt, clientCorrelationId: request.correlationId,
      onTerminal: async observation => {
        if (observation.submission.clientCorrelationId !== request.correlationId) unavailable('Native terminal input differs from its admission.')
        await this.authorize(request, connection, signal)
        await this.ports.observeTerminal?.(request, observation, signal)
      },
      ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}),
      ...(request.preferences ? { sessionPreferences: request.preferences } : {}),
      onSubmitted: async nativeTurnId => {
        await this.ports.journal.submitted(resident.binding, request.correlationId, { nativeTurnId })
        await this.ports.observeSubmission(resident.binding, request.correlationId, { nativeTurnId }, request, signal)
      },
      onMessageSubmitted: async nativeSubmission => {
        await this.ports.journal.submitted(resident.binding, request.correlationId, { nativeSubmission })
        await this.ports.observeSubmission(resident.binding, request.correlationId, { nativeSubmission }, request, signal)
      },
      onSettingsApplied: async () => {
        await this.ports.observeSettings?.(request, request.correlationId, signal)
        const record = await this.ports.journal.read(resident.binding)
        if (!record?.session || !record.desiredPreferences) return
        await this.ports.journal.preferences(resident.binding, record.desiredPreferences,
          resident.allocation.manager.appliedSessionPreferences?.(record.session) ?? null)
      },
    }
  }

  private pump(resident: Resident, request: WorkerConversationRpcRequest & { correlationId: string },
    connection: Readonly<DeviceSessionBinding>, stream: () => AsyncIterable<unknown>) {
    const task = (async () => {
      let streamStarted = false
      try {
        await this.authorize(request, connection, this.lifetime.signal)
        streamStarted = true
        for await (const event of stream()) void event
        const record = await this.ports.journal.read(resident.binding)
        if (!record?.session) unavailable('The native session was never observed.')
        const history = await resident.allocation.manager.reconcile(record.session, request.correlationId, this.lifetime.signal)
        await this.finish(resident.binding, request.correlationId, history)
      } catch (error) {
        const notDelivered = !streamStarted
          || error instanceof NativeDeliveryError && error.delivery === 'not_sent' && error.cleanup === 'confirmed'
          || error && typeof error === 'object'
          && 'certainty' in error && error.certainty === 'definite'
          && 'deliveryState' in error && error.deliveryState === 'not-delivered'
        if (notDelivered) await this.reject(resident.binding, request, error)
        else await this.ports.journal.finishTurn(resident.binding, request.correlationId)
        this.log.error({ err: error, conversationId: resident.binding.owner.conversationId }, 'Worker chat needs native recovery')
      }
    })()
    const key = `${resident.binding.owner.conversationId}:${request.correlationId}`
    this.running.set(key, task)
    void task.then(() => this.running.delete(key), () => this.running.delete(key))
    void this.track(task)
  }

  private reject(binding: WorkerConversationBinding, request: WorkerConversationRpcRequest & { correlationId: string },
    error: unknown) {
    const message = errorMessage(error, 'Native input was not delivered.')
    return this.ports.journal.rejectTurn(binding, request.correlationId,
      { outcome: 'failed', error: { code: 'NATIVE_INPUT_NOT_DELIVERED', message, retryable: true } },
      request.method === 'conversation.initial-turn' ? request.operationId : undefined)
  }

  private finish(binding: WorkerConversationBinding, correlationId: string, history: NativeHistory) {
    let terminal = history.correlationId === correlationId ? history.terminalResult : undefined
    if (history.terminalTurn?.correlationId === correlationId) terminal = history.terminalTurn.result
    return this.ports.journal.finishTurn(binding, correlationId, terminal)
  }

  private async compact(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.compact' }>,
    resident: Resident, connection: Readonly<DeviceSessionBinding>) {
    const manager = resident.allocation.manager
    if (!manager.compactSession) unavailable('The selected native driver cannot compact this session.')
    const reserved = await this.ports.journal.reserveCompact(request.binding, request.requestId,
      commandInputHash({ session: request.session, correlationId: request.correlationId }))
    if (!reserved.dispatch) return { compaction: reserved.state }
    const task = (async () => {
      let offered = false
      let progress = reserved.state
      try {
        const state = await manager.compactSession!(request.session, {
          requestId: request.requestId, clientCorrelationId: request.correlationId,
          onDispatch: async () => {
            await this.authorize(request, connection, this.lifetime.signal)
            progress = await this.ports.journal.compactProgress(request.binding,
              { ...progress, dispatchPhase: 'dispatched' })
            offered = true
          },
          onProgress: async state => { progress = await this.ports.journal.compactProgress(request.binding, state) },
        }, this.lifetime.signal)
        await this.ports.journal.compactProgress(request.binding, state)
      } catch (error) {
        const record = await this.ports.journal.read(request.binding)
        const latest = record?.compactions.find(value => value.state.requestId === request.requestId)?.state ?? reserved.state
        if (['accepted', 'running', 'uncertain'].includes(latest.status)) {
          const definite = !offered || isDefiniteCompactionRejection(error)
          await this.ports.journal.compactProgress(request.binding, { ...latest,
            status: definite ? 'failed' : 'uncertain',
            message: definite ? 'The native provider rejected compaction.' : 'Native compaction needs recovery.',
            observedAt: new Date().toISOString() })
        }
        this.log.error({ err: error, conversationId: request.binding.owner.conversationId }, 'Worker compaction needs recovery')
      }
    })()
    void this.track(task)
    return { compaction: reserved.state }
  }

  private async readCompaction(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.compact-read' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    validateConfiguration(request.binding, request.configuration)
    const record = await this.ports.journal.read(request.binding)
    const original = record?.compactions.find(value => value.state.requestId === request.state.requestId)
    if (!record || !original || !isDeepStrictEqual(record.session, request.session)
      || request.state.nativeSessionId !== request.session.nativeSessionId) unavailable('The persisted compaction owner changed.')
    let state = original.state
    if (!compactionBlocksSend(state)) {
      await this.authorize(request, connection, signal)
      return { compaction: state, receipt: record }
    }
    if (this.ports.readCompaction) state = await this.ports.readCompaction({ ...request, state }, record, connection, signal)
    else if (request.configuration.harness.harness === 'claude') {
      const profile = request.configuration.harness.configDirectory
      if (state.claudeSession?.profilePath !== profile
        || state.claudeSession?.cwd !== request.binding.workingDirectory
        || state.claudeSession?.deviceId !== connection.deviceId) unavailable('The persisted Claude profile changed.')
      state = await recoverPersistedClaudeCompaction(state)
    } else unavailable('The selected native driver has no installed compaction reader.')
    await this.authorize(request, connection, signal)
    const compaction = await this.ports.journal.compactProgress(request.binding, state)
    return { compaction, receipt: await this.ports.journal.read(request.binding) }
  }

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal = this.lifetime.signal): Promise<unknown> {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    await this.authorize(request, connection, signal)
    if (request.method === 'conversation.status') return { receipt: await this.ports.journal.read(request.binding) }
    if (request.method === 'conversation.release-preparation') {
      const preparation = this.preparations.get(request.binding.owner.conversationId)
      if (preparation) {
        if (!isDeepStrictEqual(preparation.binding, request.binding)) unavailable('The prepared native owner changed.')
        await preparation.allocation.close()
        this.preparations.delete(request.binding.owner.conversationId)
        return { acknowledged: true }
      }
      const record = await this.ports.journal.read(request.binding)
      if (record?.session || record?.turns.length) unavailable('A prepared owner cannot close an admitted model message.')
      const resident = this.residents.get(request.binding.owner.conversationId)
      if (resident) {
        if (!isDeepStrictEqual(resident.binding, request.binding)) unavailable('The prepared native owner changed.')
        await resident.allocation.close()
        this.residents.delete(request.binding.owner.conversationId)
      }
      return { acknowledged: true }
    }
    if (request.method === 'conversation.compact-read') return this.readCompaction(request, connection, signal)
    if (request.method === 'conversation.inspect-entry') {
      if (request.inspection.harness !== request.binding.harness
        || request.inspection.workingDirectory !== request.binding.workingDirectory) {
        unavailable('The native MCP inspector does not address this selected worker profile.')
      }
      if (request.inspection.phase === 'configuration') return this.inspectConfiguration(request, connection, signal)
      const resident = await this.prepare(request, connection, signal)
      if (request.inspection.harness !== request.binding.harness
        || request.inspection.workingDirectory !== request.binding.workingDirectory || !resident.allocation.inspector) {
        unavailable('The native MCP inspector does not address this selected worker profile.')
      }
      return resident.allocation.inspector.inspect({ harness: request.inspection.harness,
        runnerId: request.inspection.runnerId, workingDirectory: request.inspection.workingDirectory,
        serverName: request.inspection.serverName,
        ...(request.inspection.phase ? { phase: request.inspection.phase } : {}), signal })
    }
    if (request.method === 'conversation.open') return this.open(request, connection, signal)
    if (request.method === 'conversation.refresh-mcp') {
      const resident = await this.prepare(request, connection, signal)
      if (!resident.allocation.deliverClaudeCredential || request.binding.harness !== 'claude') {
        unavailable('This native owner has no scoped Claude credential delivery.')
      }
      await resident.allocation.deliverClaudeCredential(request.applicationAccess.token, signal)
      await this.authorize(request, connection, signal)
      return { acknowledged: true }
    }
    if (request.method === 'conversation.capabilities' || request.method === 'conversation.inspect-mcp') {
      const resident = await this.prepare(request, connection, signal)
      return request.method === 'conversation.capabilities' ? resident.allocation.manager.capabilities(signal)
        : resident.allocation.manager.inspectMcp(signal)
    }
    if (request.method === 'conversation.initial-turn') {
      const resident = await this.allocate(request, connection, signal)
      const manager = resident.allocation.manager
      if (!manager.startInitialTurn) unavailable('The native driver does not use atomic initial message admission.')
      await this.ports.journal.receive(request.binding, connection)
      const initial = await this.ports.journal.reserveInitialTurn(request.binding, request.operationId,
        commandInputHash({ mode: 'initial-turn', correlationId: request.correlationId }), request.correlationId,
        commandInputHash({ prompt: request.prompt, mode: request.sessionMode ?? 'regular',
          preferences: request.preferences ?? null }), request.sessionMode ?? 'regular')
      if (initial.dispatch) {
        try {
          if (request.preferences) {
            await manager.configureSessionPreferences?.(request.preferences)
            await this.ports.journal.preferences(request.binding, request.preferences, null)
          }
          const start = await resident.allocation.start({ correlationId: request.correlationId, instructionsDelivered: false,
            ...(request.applicationAccess ? { applicationAccess: request.applicationAccess } : {}) })
          this.pump(resident, request, connection, () => manager.startInitialTurn!(start, {
            ...this.callbacks(resident, request, connection, this.lifetime.signal),
            onSessionObserved: session => this.bind(resident, session, request, this.lifetime.signal),
          }, this.lifetime.signal))
        } catch (error) {
          await this.reject(resident.binding, request, error)
        }
      }
      return { receipt: await this.ports.journal.read(request.binding) }
    }
    if (request.method === 'conversation.close') {
      const record = await this.ports.journal.read(request.binding)
      if (record?.closed && isDeepStrictEqual(record.session, request.session)) return { receipt: record }
    }
    if (!('session' in request)) unavailable('This native operation requires its conversation session.')
    const { resident, record } = await this.resident(request)
    const manager = resident.allocation.manager
    switch (request.method) {
      case 'conversation.retire-turn': {
        if (!record.turns.some(turn => turn.correlationId === request.correlationId)) unavailable('The native turn is not owned by this conversation.')
        await manager.retireTurn?.(request.session, request.correlationId)
        return { receipt: await this.ports.journal.read(request.binding) }
      }
      case 'conversation.start-turn': {
        const reserved = await this.ports.journal.reserveTurn(request.binding, request.correlationId, commandInputHash({
          prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }),
        { mode: request.sessionMode ?? 'regular' })
        if (reserved.dispatch) this.pump(resident, request, connection, () => manager.startTurn(request.session,
          this.callbacks(resident, request, connection, this.lifetime.signal), this.lifetime.signal))
        return { receipt: await this.ports.journal.read(request.binding) }
      }
      case 'conversation.history':
      case 'conversation.reconcile': {
        const turn = record.turns.find(turn => turn.correlationId === request.correlationId)
        const running = request.correlationId !== undefined
          && this.running.has(`${request.binding.owner.conversationId}:${request.correlationId}`)
        if (request.method === 'conversation.reconcile' && turn?.nativeSubmission
          && !['completed', 'rejected'].includes(turn.status)) {
          await resident.allocation.recoverClaudeAuthority?.(request, turn.nativeSubmission, signal)
          await this.authorize(request, connection, signal)
        }
        if (!running && request.method === 'conversation.reconcile' && turn?.nativeTurnId
          && !['completed', 'rejected'].includes(turn.status)) {
          if ((request.sessionMode ?? 'regular') !== (turn.sessionMode ?? 'regular')) unavailable('The recovered turn mode changed.')
          await resident.allocation.recoverFiles?.(request, turn.nativeTurnId, signal)
          await this.authorize(request, connection, signal)
        }
        let history: NativeHistory
        if (turn?.status === 'rejected' && turn.result) {
          history = { events: [], pendingInteractions: [], nonSubmission: {
            nativeSessionId: request.session.nativeSessionId, clientCorrelationId: turn.correlationId, result: turn.result,
          } }
        } else if (request.afterSequence !== undefined && request.correlationId && manager.reconcileHistoryPage) {
          history = await manager.reconcileHistoryPage(request.session, request.correlationId, request.afterSequence, signal)
        } else if (turn && request.correlationId && !running) {
          history = await manager.reconcile(request.session, request.correlationId, signal)
        } else {
          // Main can reconcile a message before its Worker reservation exists.
          history = await manager.history(request.session, signal)
        }
        if (request.correlationId && !running && record.turns.some(turn => turn.correlationId === request.correlationId)) {
          await this.finish(request.binding, request.correlationId, history)
        }
        if (request.afterSequence !== undefined) {
          const after = request.afterSequence
          history = { ...history, events: history.events.filter(event => event.sequence > after) }
        }
        return { history, context: manager.contextSnapshot?.(request.session) ?? null,
          receipt: await this.ports.journal.read(request.binding) }
      }
      case 'conversation.pending': return manager.pending(request.session, signal)
      case 'conversation.controls-read': return {
        capabilities: await manager.sessionControlCapabilities?.(request.session) ?? null,
        context: manager.contextSnapshot?.(request.session) ?? null,
        preferences: manager.appliedSessionPreferences?.(request.session) ?? null,
        receipt: await this.ports.journal.read(request.binding),
      }
      case 'conversation.preferences':
        if (!manager.applySessionPreferences) unavailable('The native driver cannot apply these preferences.')
        await this.ports.journal.preferences(request.binding, request.preferences, record.appliedPreferences)
        if (record.turns.some(turn => !['completed', 'rejected'].includes(turn.status))
          || record.compactions.some(control => ['accepted', 'running', 'uncertain'].includes(control.state.status))) {
          return { receipt: await this.ports.journal.read(request.binding) }
        }
        await manager.applySessionPreferences(request.session, request.preferences, signal)
        return { receipt: await this.ports.journal.preferences(request.binding, request.preferences,
          manager.appliedSessionPreferences?.(request.session) ?? null) }
      case 'conversation.compact': return this.compact(request, resident, connection)
      case 'conversation.compact-reconcile': {
        const original = record.compactions.find(value => value.state.requestId === request.state.requestId)
        if (!original || request.state.nativeSessionId !== request.session.nativeSessionId) unavailable('The compaction owner changed.')
        if (!compactionBlocksSend(original.state)) return { compaction: original.state }
        const state = await manager.reconcileCompaction?.(request.session, original.state, signal) ?? original.state
        return { compaction: await this.ports.journal.compactProgress(request.binding, state) }
      }
      case 'conversation.cancel': return { canceled: await manager.cancel(request.session, signal, request.nativeTurnId) }
      case 'conversation.respond':
        await manager.respond(request.session, request.nativeRequestId, request.option, signal)
        return { receipt: await this.ports.journal.read(request.binding) }
      case 'conversation.response-reconcile': {
        if (!manager.reconcileResponse) unavailable('The native driver cannot recover response delivery.')
        return { history: await manager.reconcileResponse(request.session, request.response, signal),
          context: manager.contextSnapshot?.(request.session) ?? null, receipt: record }
      }
      case 'conversation.response-availability': {
        const query = { nativeRequestId: request.query.nativeRequestId, nativeRequestType: request.query.nativeRequestType,
          ...(request.query.expectedNativeTurnId ? { expectedNativeTurnId: request.query.expectedNativeTurnId } : {}),
          ...(request.query.expectedNativeMessageId ? { expectedNativeMessageId: request.query.expectedNativeMessageId } : {}),
          ...(request.query.expectedGeneration ? { expectedGeneration: request.query.expectedGeneration } : {}) }
        return manager.inspectResponseAvailability ? manager.inspectResponseAvailability(request.session, query, signal)
          : unavailableNativeResponse(request.session, query, 'unsupported')
      }
      case 'conversation.steer':
        if (!manager.steerTurn) unavailable('This native driver cannot steer a turn.')
        return manager.steerTurn(request.session, { prompt: request.prompt,
          clientCorrelationId: request.correlationId, expectedTurnId: request.expectedTurnId }, signal)
      case 'conversation.reconcile-steers': return manager.reconcileSteers?.(request.session, request.inputs, signal) ?? []
      case 'conversation.close':
        await this.ports.journal.closeRequested(request.binding)
        await manager.close(request.session)
        await resident.allocation.close()
        this.residents.delete(request.binding.owner.conversationId)
        return { receipt: await this.ports.journal.closeConfirmed(request.binding) }
    }
  }

  async drainForUpdate(): Promise<void> {
    while (this.tasks.size || this.allocating.size) {
      await Promise.allSettled([...this.tasks, ...this.allocating.values()])
    }
  }

  async shutdown() {
    this.closing = true
    this.lifetime.abort(new DomainError('ENGINE_RESTART', 'The worker native owner is shutting down.', 503))
    await Promise.allSettled([...this.tasks, ...this.allocating.values()])
    const results = await Promise.allSettled([...this.residents.values(), ...this.preparations.values()]
      .map(resident => resident.allocation.close()).concat([...this.inspections].map(allocation => allocation.close())))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Worker conversation cleanup is incomplete.')
    this.residents.clear()
    this.preparations.clear()
    this.inspections.clear()
  }
}
