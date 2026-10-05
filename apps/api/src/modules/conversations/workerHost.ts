import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@graphql/contracts/command-identity-node'
import {
  WorkerConversationRpcRequestSchema, type WorkerConversationBinding, type WorkerConversationConfiguration,
  type WorkerConversationReceipt, type WorkerConversationRpcRequest,
} from '@graphql/contracts/remote-execution-rpc'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { NativeSessionReference } from '@graphql/contracts'
import type { RemoteNativeIdentity } from '@graphql/contracts/remote-execution'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import type { WorkerConversationJournal } from './workerJournal.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../../infrastructure/logger.js'

export interface WorkerConversationAllocation {
  manager: NativeHarnessSessionManager
  start(input: { correlationId: string; instructionsDelivered: boolean }): Promise<NativeSessionStart>
  nativeOwner(session: NativeSessionReference): Promise<RemoteNativeIdentity>
  close(): Promise<void>
}
export interface WorkerConversationHostPorts {
  journal: WorkerConversationJournal
  currentBinding(): Readonly<DeviceSessionBinding>
  /** Main verifies the original admitted message/control and current role grants. */
  authorize(request: WorkerConversationRpcRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<void>
  allocate(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<WorkerConversationAllocation>
  recover?(record: WorkerConversationReceipt, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<WorkerConversationAllocation>
  /** Native callbacks stay behind Main's persisted identity acknowledgement. */
  observeSession(binding: WorkerConversationBinding, session: NativeSessionReference, signal: AbortSignal): Promise<void>
  observeSubmission(binding: WorkerConversationBinding, correlationId: string,
    identity: Pick<NativeHistory, 'nativeTurnId' | 'nativeSubmission'>, signal: AbortSignal): Promise<void>
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
    || !isDeepStrictEqual(configuration.harnessProfileSelection, binding.profile)) {
    unavailable('The saved chat configuration differs from its selected worker owner.')
  }
}

/** Conversation operations share execution-v1 and the existing native adapters. */
export class WorkerConversationHost {
  private readonly residents = new Map<string, Resident>()
  private readonly allocating = new Map<string, Promise<Resident>>()
  private readonly tasks = new Set<Promise<void>>()
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
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
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
      const allocation = record?.session
        ? await this.recover(record, request.configuration, connection, signal)
        : await this.ports.allocate(request.binding, request.configuration, connection, signal)
      try {
        this.current(request.binding, connection, signal)
        if (allocation.manager.harness !== request.binding.harness) unavailable('The worker allocated another native driver.')
        const resident = { binding: structuredClone(request.binding), configuration: structuredClone(request.configuration), allocation }
        this.residents.set(id, resident)
        return resident
      } catch (error) { await allocation.close(); throw error }
    })()
    this.allocating.set(id, task)
    try { return await task } finally { if (this.allocating.get(id) === task) this.allocating.delete(id) }
  }

  private recover(record: WorkerConversationReceipt, configuration: WorkerConversationConfiguration,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    if (!this.ports.recover) unavailable('The original worker process needs native recovery before it can be attached.')
    return this.ports.recover(record, configuration, connection, signal)
  }

  private async resident(request: WorkerConversationRpcRequest & { session: NativeSessionReference }) {
    const record = await this.ports.journal.read(request.binding)
    const resident = this.residents.get(request.binding.owner.conversationId)
    if (!record || !isDeepStrictEqual(record.session, request.session) || !resident
      || !isDeepStrictEqual(resident.binding, request.binding)) unavailable('The original chat session is not resident.')
    if (!isDeepStrictEqual(record.nativeOwner, sessionOwner(await resident.allocation.nativeOwner(request.session)))) {
      unavailable('The original native chat process changed.')
    }
    return { resident, record }
  }

  private track(task: Promise<void>) {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  private async bind(resident: Resident, session: NativeSessionReference, signal: AbortSignal) {
    await this.ports.journal.bindSession(resident.binding, session,
      sessionOwner(await resident.allocation.nativeOwner(session)))
    await this.ports.observeSession(resident.binding, session, signal)
  }

  private async open(request: Extract<WorkerConversationRpcRequest, { method: 'conversation.open' }>,
    connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    if (request.mode !== 'create' && !request.source) unavailable('Native attachment or fork requires its source session.')
    const resident = await this.allocate(request, connection, signal)
    if (request.mode === 'fork' && !resident.allocation.manager.forkSession) {
      unavailable('The selected native driver cannot fork a chat session.')
    }
    const record = await this.ports.journal.receive(request.binding, connection)
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
      instructionsDelivered: request.mode === 'fork' })
    const manager = resident.allocation.manager
    let session: NativeSessionReference
    if (request.mode === 'fork') {
      if (!manager.forkSession) unavailable('The selected native driver cannot fork a chat session.')
      session = await manager.forkSession(request.source!, start, signal)
      if (session.nativeSessionId === request.source!.nativeSessionId) unavailable('The native fork returned its source session.')
    } else session = await manager.createSession(start, signal)
    await this.bind(resident, session, signal)
    return { receipt: await this.ports.journal.read(request.binding) }
  }

  private callbacks(resident: Resident, request: { correlationId: string; prompt: string;
    sessionMode?: NativeTurnInput['sessionMode']; preferences?: NativeTurnInput['sessionPreferences'] }, signal: AbortSignal): NativeTurnInput {
    return {
      prompt: request.prompt, clientCorrelationId: request.correlationId,
      ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}),
      ...(request.preferences ? { sessionPreferences: request.preferences } : {}),
      onSubmitted: async nativeTurnId => {
        await this.ports.journal.submitted(resident.binding, request.correlationId, { nativeTurnId })
        await this.ports.observeSubmission(resident.binding, request.correlationId, { nativeTurnId }, signal)
      },
      onMessageSubmitted: async nativeSubmission => {
        await this.ports.journal.submitted(resident.binding, request.correlationId, { nativeSubmission })
        await this.ports.observeSubmission(resident.binding, request.correlationId, { nativeSubmission }, signal)
      },
      onSettingsApplied: async () => {
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
      try {
        await this.authorize(request, connection, this.lifetime.signal)
        for await (const event of stream()) void event
        const record = await this.ports.journal.read(resident.binding)
        if (!record?.session) unavailable('The native session was never observed.')
        const history = await resident.allocation.manager.reconcile(record.session, request.correlationId, this.lifetime.signal)
        await this.finish(resident.binding, request.correlationId, history)
      } catch (error) {
        await this.ports.journal.finishTurn(resident.binding, request.correlationId)
        this.log.error({ err: error, conversationId: resident.binding.owner.conversationId }, 'Worker chat needs native recovery')
      }
    })()
    this.track(task)
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
      try {
        const state = await manager.compactSession!(request.session, {
          requestId: request.requestId, clientCorrelationId: request.correlationId,
          onDispatch: async () => {
            await this.authorize(request, connection, this.lifetime.signal)
            await this.ports.journal.compactProgress(request.binding, { ...reserved.state, dispatchPhase: 'offered' })
            offered = true
          },
          onProgress: async state => { await this.ports.journal.compactProgress(request.binding, state) },
        }, this.lifetime.signal)
        await this.ports.journal.compactProgress(request.binding, state)
      } catch (error) {
        const record = await this.ports.journal.read(request.binding)
        const latest = record?.compactions.find(value => value.state.requestId === request.requestId)?.state ?? reserved.state
        if (['accepted', 'running', 'uncertain'].includes(latest.status)) {
          await this.ports.journal.compactProgress(request.binding, { ...latest,
            status: offered ? 'uncertain' : 'failed', message: 'Native compaction needs recovery.',
            observedAt: new Date().toISOString() })
        }
        this.log.error({ err: error, conversationId: request.binding.owner.conversationId }, 'Worker compaction needs recovery')
      }
    })()
    this.track(task)
    return { compaction: reserved.state }
  }

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal = this.lifetime.signal): Promise<unknown> {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    await this.authorize(request, connection, signal)
    if (request.method === 'conversation.status') return { receipt: await this.ports.journal.read(request.binding) }
    if (request.method === 'conversation.open') return this.open(request, connection, signal)
    if (request.method === 'conversation.capabilities' || request.method === 'conversation.inspect-mcp') {
      const resident = await this.allocate(request, connection, signal)
      return request.method === 'conversation.capabilities' ? resident.allocation.manager.capabilities(signal)
        : resident.allocation.manager.inspectMcp(signal)
    }
    if (request.method === 'conversation.initial-turn') {
      const resident = await this.allocate(request, connection, signal)
      const manager = resident.allocation.manager
      if (!manager.startInitialTurn) unavailable('The native driver does not use atomic initial message admission.')
      await this.ports.journal.receive(request.binding, connection)
      const creation = await this.ports.journal.reserveCreation(request.binding, request.operationId,
        commandInputHash({ mode: 'initial-turn', correlationId: request.correlationId }))
      const turn = await this.ports.journal.reserveTurn(request.binding, request.correlationId, commandInputHash({
        prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }))
      if (creation.dispatch && turn.dispatch) {
        if (request.preferences) {
          await manager.configureSessionPreferences?.(request.preferences)
          await this.ports.journal.preferences(request.binding, request.preferences, null)
        }
        const start = await resident.allocation.start({ correlationId: request.correlationId, instructionsDelivered: false })
        this.pump(resident, request, connection, () => manager.startInitialTurn!(start, {
          ...this.callbacks(resident, request, this.lifetime.signal),
          onSessionObserved: session => this.bind(resident, session, this.lifetime.signal),
        }, this.lifetime.signal))
      }
      return { receipt: await this.ports.journal.read(request.binding) }
    }
    if (request.method === 'conversation.close') {
      const record = await this.ports.journal.read(request.binding)
      if (record?.closed && isDeepStrictEqual(record.session, request.session)) return { receipt: record }
    }
    const { resident, record } = await this.resident(request)
    const manager = resident.allocation.manager
    switch (request.method) {
      case 'conversation.start-turn': {
        const reserved = await this.ports.journal.reserveTurn(request.binding, request.correlationId, commandInputHash({
          prompt: request.prompt, mode: request.sessionMode ?? 'regular', preferences: request.preferences ?? null }))
        if (reserved.dispatch) this.pump(resident, request, connection, () => manager.startTurn(request.session,
          this.callbacks(resident, request, this.lifetime.signal), this.lifetime.signal))
        return { receipt: await this.ports.journal.read(request.binding) }
      }
      case 'conversation.history':
      case 'conversation.reconcile': {
        let history: NativeHistory
        if (request.correlationId) history = await manager.reconcile(request.session, request.correlationId, signal)
        else if (request.before && manager.historyPage) history = await manager.historyPage(request.session, request.before, signal)
        else history = await manager.history(request.session, signal)
        if (request.correlationId && record.turns.some(turn => turn.correlationId === request.correlationId)) {
          await this.finish(request.binding, request.correlationId, history)
        }
        return { history, context: manager.contextSnapshot?.(request.session) ?? null,
          receipt: await this.ports.journal.read(request.binding) }
      }
      case 'conversation.pending': return manager.pending(request.session, signal)
      case 'conversation.controls-read': return {
        capabilities: await manager.sessionControlCapabilities?.(request.session) ?? null,
        context: manager.contextSnapshot?.(request.session) ?? null,
        preferences: manager.appliedSessionPreferences?.(request.session) ?? null, receipt: record,
      }
      case 'conversation.preferences':
        if (!manager.applySessionPreferences) unavailable('The native driver cannot apply these preferences.')
        await this.ports.journal.preferences(request.binding, request.preferences, record.appliedPreferences)
        if (record.turns.some(turn => turn.status !== 'completed')
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
        const state = await manager.reconcileCompaction?.(request.session, original.state, signal) ?? original.state
        return { compaction: await this.ports.journal.compactProgress(request.binding, state) }
      }
      case 'conversation.cancel': return { canceled: await manager.cancel(request.session, signal, request.nativeTurnId) }
      case 'conversation.respond':
        await manager.respond(request.session, request.nativeRequestId, request.option, signal)
        return { receipt: await this.ports.journal.read(request.binding) }
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

  async shutdown() {
    this.closing = true
    this.lifetime.abort(new DomainError('ENGINE_RESTART', 'The worker native owner is shutting down.', 503))
    await Promise.allSettled([...this.tasks, ...this.allocating.values()])
    const results = await Promise.allSettled([...this.residents.values()].map(resident => resident.allocation.close()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Worker conversation cleanup is incomplete.')
    this.residents.clear()
  }
}
