import { isDeepStrictEqual } from 'node:util'

import {
  NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema,
  NativeSessionReferenceSchema,
  OPENCODE_APPROVAL_OPTIONS_FIXTURE,
  PendingNativeInteractionSchema,
  type ApprovalResponseOption,
  type McpDetection,
  type NativeHarnessCapabilities,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type OpenCodeHarnessConfiguration,
  type PendingNativeInteraction,
} from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from './port.js'
import {
  boundedMapSet, boundedSetAdd, configurationPermissionRules, digest, eventSessionId, failure,
  nativeMessageId, nativePolicy, normalizedHistory, object, OpenCodeTurnHistory,
  OPENCODE_EVENT_BYTES, OPENCODE_EVENT_LIMIT, OPENCODE_HISTORY_PAGE_SIZE,
  parseOpenCodeSse, providerSupports, visibleNativeEvent,
  type JsonObject, type OpenCodeEvent, type OpenCodeMessage,
} from './opencodeProtocol.js'
import {
  childEnvironmentFingerprint, ManagedOpenCodeServer, OpenCodeNativeDeliveryError, QUALIFIED_OPENCODE_VERSION,
  type NativeDeliveryCertainty, type OpenCodeServerController,
} from './opencodeTransport.js'

export {
  ManagedOpenCodeServer, OpenCodeNativeDeliveryError, buildOpenCodeConfigContent,
  type ManagedOpenCodeServerOptions, type NativeDeliveryCertainty, type OpenCodeServerController,
} from './opencodeTransport.js'

interface NativePermissionRequest extends JsonObject {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: JsonObject
  always: string[]
  tool?: { messageID: string; callID: string }
}
interface OwnedTurn {
  correlationId: string
  messageID: string
  promptHash: string | undefined
  submitted: boolean
  observing: boolean
  generation: number
  submittedAt: number
  idleObserved: boolean
  scopedError: JsonObject | undefined
  terminalResult: NativeHistory['terminalResult']
}
interface SessionState {
  directory: string
  configuration: OpenCodeHarnessConfiguration
  events: NativeHarnessEvent[]
  eventBytes: number
  eventIds: Set<string>
  pendingIds: Set<string>
  historyIds: Set<string>
  partTypes: Map<string, string>
  ownedIds: Map<string, boolean>
  sequence: number
  turn: OwnedTurn | undefined
}
interface MessagePage { messages: OpenCodeMessage[]; nextCursor?: string }

export interface OpenCodeNativeSessionManagerOptions {
  server: OpenCodeServerController
  ownerAgentId: string
  appMcpServerName?: string
  expectedAppMcpEndpoint?: string
}
export interface OpenCodeMcpInspection {
  cwd: string
  providerVersion: string
  serverName: string
  nativeStatus: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'not_detected'
  endpoint: string | null
  credentialEnvironmentVariable: string | null
  endpointMatches: boolean | null
  /** Base configuration only; agent/session policy is intentionally not called effective here. */
  baseConfigurationFilters: readonly { permission: string; pattern: string; effect: string }[]
  policyScope: 'base_configuration_only'
  detail?: string
}

/** Native transport; durable routing/command ownership stays in the shared HAP-05 flow. */
export class OpenCodeNativeSessionManager implements NativeHarnessSessionManager {
  readonly harness = 'opencode' as const
  private readonly sessions = new Map<string, SessionState>()
  private lifecycle: Promise<unknown> = Promise.resolve()
  private lifetime = new AbortController()
  private boundEnvironmentFingerprint: string | undefined
  private readyGeneration: number | undefined

  constructor(private readonly options: OpenCodeNativeSessionManagerOptions) {
    if (options.server.ownerAgentId !== undefined && options.server.ownerAgentId !== options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The native manager and resident server must have the same credential owner.')
    }
    this.boundEnvironmentFingerprint = options.server.credentialEnvironmentFingerprint
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(work)
    this.lifecycle = task.catch(() => undefined)
    return task
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }
  private get generation(): number { return this.options.server.generation ?? 0 }

  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    await this.exclusive(() => this.ready(this.signal(signal)))
    return NativeHarnessCapabilitiesSchema.parse({
      provider: 'opencode', providerVersion: QUALIFIED_OPENCODE_VERSION,
      persistentSessions: true, reconnect: true, sameRequestResponses: true,
      cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true, supportedInteractionKinds: ['approval'],
    })
  }

  createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      try {
        combined.throwIfAborted()
        const directory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
        const configuration = this.configuration(input)
        await this.bindEnvironment(input.environment, combined)
        await this.ready(combined)
        await this.qualifyConfiguration(configuration, directory, combined)
        await this.applyMcpControls(configuration, directory, combined)
        const [providerID, ...model] = configuration.model.split('/')
        const response = object(await this.mutate(withDirectory('/session', directory), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: input.kind === 'operator' ? `GraphQL Operator ${input.correlationId}` : `GraphQL ${input.request.executionId}`,
            agent: configuration.nativeAgent,
            model: { providerID, id: model.join('/'), ...(configuration.variant ? { variant: configuration.variant } : {}) },
            permission: nativePolicy(configuration),
          }),
        }, combined))
        if (typeof response.id !== 'string' || !response.id) {
          throw new OpenCodeNativeDeliveryError('OPENCODE_SESSION_ID_MISSING', 'Session creation may have succeeded but did not return a native identity.', 'uncertain')
        }
        const session = NativeSessionReferenceSchema.parse({ harness: 'opencode', providerVersion: QUALIFIED_OPENCODE_VERSION, nativeSessionId: response.id })
        combined.throwIfAborted()
        this.sessions.set(response.id, newState(directory, configuration))
        return session
      } catch (error) { return this.cleanupFailedSetup(error) }
    })
  }

  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      try {
        this.validateReference(session)
        combined.throwIfAborted()
        if (this.sessions.has(session.nativeSessionId)) {
          throw new HarnessExecutionError('OPENCODE_SESSION_ALREADY_ATTACHED', 'This manager already owns that session; attaching must not discard its writer state.')
        }
        const directory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
        const configuration = this.configuration(input)
        await this.bindEnvironment(input.environment, combined)
        await this.ready(combined)
        await this.qualifyConfiguration(configuration, directory, combined)
        const native = object(await this.json(`/session/${encodeURIComponent(session.nativeSessionId)}`, directory, combined))
        this.verifyAttachedSession(native, session.nativeSessionId, directory, configuration)
        await this.applyMcpControls(configuration, directory, combined)
        combined.throwIfAborted()
        this.sessions.set(session.nativeSessionId, newState(directory, configuration))
        return session
      } catch (error) { return this.cleanupFailedSetup(error) }
    })
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    yield* this.watchTurn(session, input.clientCorrelationId, input.prompt, this.signal(signal))
  }

  /** Explicit nonmutating recovery seam: this method never submits prompt_async. */
  async *observeTurn(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    yield* this.watchTurn(session, correlationId, undefined, this.signal(signal))
  }

  private async *watchTurn(session: NativeSessionReference, correlationId: string, prompt: string | undefined, signal: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const state = this.requireSession(session)
    let turn: OwnedTurn | undefined
    let response: Response | undefined
    let initialHistory: NativeHistory | undefined
    try {
      await this.exclusive(async () => {
        signal.throwIfAborted()
        if (this.requireSession(session) !== state) throw new HarnessExecutionError('OPENCODE_SESSION_CONTEXT_MISSING', 'The session was closed before its turn could be reserved.')
        await this.ready(signal)
        if (state.turn?.observing) throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'This turn already has an event observer; detach it before re-subscribing.')
        if (state.turn && !state.turn.terminalResult && state.turn.correlationId !== correlationId) {
          await this.reconcileReady(session, state.turn.correlationId, signal)
          if (!state.turn.terminalResult) throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'The previous native turn is still running or its outcome is uncertain.')
        }
        const messageID = nativeMessageId(correlationId)
        const root = await this.message(session.nativeSessionId, messageID, state.directory, signal)
        if (state.turn?.correlationId === correlationId) {
          turn = state.turn
          if (prompt !== undefined && turn.promptHash && turn.promptHash !== digest(prompt)) {
            throw new HarnessExecutionError('OPENCODE_CORRELATION_CONFLICT', 'The correlation ID was already used for a different prompt.')
          }
        } else {
          if (!root && prompt === undefined) {
            throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_MISSING', 'The requested native turn identity could not be recovered; no prompt was replayed.')
          }
          if (root && prompt !== undefined && root.parts.filter((part) => part.type === 'text' && part.ignored !== true).map((part) => part.text).join('') !== prompt) {
            throw new HarnessExecutionError('OPENCODE_CORRELATION_CONFLICT', 'The persisted correlation belongs to a different prompt.')
          }
          turn = {
            correlationId, messageID, promptHash: prompt === undefined ? undefined : digest(prompt),
            submitted: !!root, observing: false, generation: this.generation, submittedAt: 0,
            idleObserved: false, scopedError: undefined, terminalResult: undefined,
          }
          state.turn = turn
        }
        turn.observing = true
        if (turn.terminalResult) return
        if (turn.submitted) {
          initialHistory = await this.reconcileReady(session, correlationId, signal)
          return
        }
        const status = await this.sessionStatus(session.nativeSessionId, state.directory, signal)
        if (status !== 'idle') throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'The native session has active work; another prompt was not submitted.')
        response = await this.openEvents(state.directory, signal, false)
        const [providerID, ...model] = state.configuration.model.split('/')
        // Claim delivery before awaiting it. An uncertain transport/body failure must
        // never become permission to resend a potentially accepted prompt.
        turn.submitted = true
        turn.submittedAt = Date.now()
        turn.generation = this.generation
        try {
          await this.mutate(withDirectory(`/session/${encodeURIComponent(session.nativeSessionId)}/prompt_async`, state.directory), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageID, model: { providerID, modelID: model.join('/') },
              ...(state.configuration.variant ? { variant: state.configuration.variant } : {}),
              agent: state.configuration.nativeAgent, parts: [{ type: 'text', text: prompt }],
            }),
          }, signal)
        } catch (error) {
          if (error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite') turn.submitted = false
          throw error
        }
      })
      if (!turn) throw new Error('OpenCode turn reservation failed.')
      if (initialHistory) {
        for (const event of initialHistory.events) yield this.recordSynthetic(state, event.type, event.payload)
        for (const pending of initialHistory.pendingInteractions) {
          yield this.recordSynthetic(state, 'interaction.pending', { nativeRequestId: pending.turn.nativeRequestId, nativeSessionId: object(pending.request).sessionID, correlationId })
        }
      }
      if (turn.terminalResult) return
      let failures = 0
      while (true) {
        signal.throwIfAborted()
        try {
          response ??= await this.openEvents(state.directory, signal)
          if (!response.body) throw new Error('OpenCode event stream has no body.')
          for await (const native of parseOpenCodeSse(response.body, signal)) {
            const id = eventSessionId(native)
            if (!id || !(await this.ownedSession(session.nativeSessionId, id, state, signal))) continue
            if (id === session.nativeSessionId && native.type === 'session.error') turn.scopedError = object(object(native.properties).error)
            if (id === session.nativeSessionId && native.type === 'session.idle') turn.idleObserved = true
            if (visibleNativeEvent(native, state.configuration.thinking, state.partTypes)) {
              const event = this.record(state, native)
              if (event) yield event
            }
            if (native.type === 'permission.asked' && typeof native.properties?.id === 'string' && !state.pendingIds.has(native.properties.id)) {
              boundedSetAdd(state.pendingIds, native.properties.id)
              yield this.recordSynthetic(state, 'interaction.pending', { nativeRequestId: native.properties.id,
                nativeSessionId: id, correlationId })
            }
            if (native.type === 'question.asked' || (id === session.nativeSessionId && ['session.idle', 'session.error'].includes(native.type))) break
          }
        } catch (error) {
          if (signal.aborted) throw error
          if (error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite') throw error
          failures += 1
        } finally {
          await response?.body?.cancel().catch(() => undefined)
          response = undefined
        }
        try {
          const history = await this.reconcile(session, correlationId, signal)
          for (const event of history.events) {
            const key = event.payload.nativeEventId
            if (typeof key === 'string' && state.historyIds.has(key)) continue
            if (typeof key === 'string') boundedSetAdd(state.historyIds, key)
            yield this.recordSynthetic(state, event.type, event.payload)
          }
          if (history.terminalResult) return
          for (const pending of history.pendingInteractions) {
            const id = pending.turn.nativeRequestId
            if (id && !state.pendingIds.has(id)) {
              boundedSetAdd(state.pendingIds, id)
              yield this.recordSynthetic(state, 'interaction.pending', { nativeRequestId: id,
                nativeSessionId: object(pending.request).sessionID, correlationId })
            }
          }
          failures = 0
        } catch (error) {
          if (signal.aborted) throw error
          if (error instanceof HarnessExecutionError || (error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite')) throw error
          failures += 1
        }
        await delay(Math.min(2_000, 50 * 2 ** Math.min(failures, 6)), signal)
      }
    } finally {
      await response?.body?.cancel().catch(() => undefined)
      // Detaching observation is deliberately NOT native cancellation or writer release.
      if (turn) {
        turn.observing = false
        if (!turn.submitted && state.turn === turn) state.turn = undefined
      }
    }
  }

  async pending(session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined> {
    return (await this.pendingAll(session, signal))[0]
  }

  async pendingAll(session: NativeSessionReference, signal?: AbortSignal): Promise<readonly PendingNativeInteraction[]> {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    return this.pendingReady(session, combined)
  }

  private async pendingReady(session: NativeSessionReference, signal: AbortSignal): Promise<PendingNativeInteraction[]> {
    const state = this.requireSession(session)
    const requests = await this.permissionRequests(state.directory, signal)
    const owned: NativePermissionRequest[] = []
    for (const request of requests) {
      if (await this.ownedSession(session.nativeSessionId, request.sessionID, state, signal)) owned.push(request)
    }
    const current = new Set(owned.map((item) => item.id))
    for (const id of state.pendingIds) if (!current.has(id)) state.pendingIds.delete(id)
    return owned.map((request) => PendingNativeInteractionSchema.parse({
      session, turn: { nativeTurnId: request.tool?.messageID ?? request.id, nativeRequestId: request.id },
      nativeRequestType: 'permission.asked', request,
      responseOptions: optionsForRequest(request.id),
    }))
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    const combined = this.signal(signal)
    await this.exclusive(async () => {
      await this.ready(combined)
      const state = this.requireSession(session)
      const pending = await this.pendingReady(session, combined)
      const request = pending.find((item) => item.turn.nativeRequestId === nativeRequestId)
      if (!request) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_NOT_PENDING', 'That permission request is no longer pending in an owned session.', 'definite')
      const expected = optionsForRequest(nativeRequestId).find((item) => item.optionId === option.optionId)
      if (!expected || !isDeepStrictEqual(expected, option)) {
        throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_OPTION_INVALID', 'The response option is not valid for this exact native request.', 'definite')
      }
      const reply = option.semantic === 'approve_once' ? 'once' : option.semantic === 'provider_scoped_allow' ? 'always' : option.semantic === 'reject' ? 'reject' : undefined
      if (!reply) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_SEMANTIC_UNSUPPORTED', 'The selected response cannot be represented by OpenCode V1.', 'definite')
      await this.mutate(withDirectory(`/permission/${encodeURIComponent(nativeRequestId)}/reply`, state.directory), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply }),
      }, combined)
      await this.pendingReady(session, combined)
    })
  }

  cancel(session: NativeSessionReference, signal?: AbortSignal): Promise<boolean> {
    const combined = this.signal(signal)
    return this.exclusive(async () => { await this.ready(combined); return this.cancelReady(session, combined) })
  }

  private async cancelReady(session: NativeSessionReference, signal: AbortSignal): Promise<boolean> {
    const state = this.requireSession(session)
    const statuses = object(await this.json('/session/status', state.directory, signal))
    const permissions = await this.permissionRequests(state.directory, signal)
    const questions = await this.json('/question', state.directory, signal)
    const questionSessions = Array.isArray(questions) ? questions.flatMap((item) => typeof object(item).sessionID === 'string' ? [String(object(item).sessionID)] : []) : []
    const targets = new Set([session.nativeSessionId])
    for (const id of [...Object.keys(statuses), ...permissions.map((item) => item.sessionID), ...questionSessions]) {
      if (await this.ownedSession(session.nativeSessionId, id, state, signal)) targets.add(id)
    }
    let accepted = true
    // Abort descendants too, rather than assuming aborting the task parent clears them.
    for (const id of [...targets].reverse()) {
      const result = await this.mutate(withDirectory(`/session/${encodeURIComponent(id)}/abort`, state.directory), { method: 'POST' }, signal)
      if (result !== true) accepted = false
    }
    const rejected = new Set<string>()
    for (const request of await this.permissionRequests(state.directory, signal)) {
      if (rejected.has(request.sessionID) || !(await this.ownedSession(session.nativeSessionId, request.sessionID, state, signal))) continue
      await this.mutate(withDirectory(`/permission/${encodeURIComponent(request.id)}/reply`, state.directory), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'reject' }),
      }, signal)
      rejected.add(request.sessionID)
    }
    await this.rejectQuestions(session, signal)
    const remaining = await this.pendingReady(session, signal)
    const after = object(await this.json('/session/status', state.directory, signal))
    for (const id of Object.keys(after)) {
      if (object(after[id]).type !== 'idle' && await this.ownedSession(session.nativeSessionId, id, state, signal)) accepted = false
    }
    if (remaining.length) accepted = false
    if (accepted && state.turn) state.turn.terminalResult = { outcome: 'canceled' }
    return accepted
  }

  /** Latest authoritative page, not a lifetime-sized copy of the transient event cache. */
  async history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory> {
    return this.historyPage(session, undefined, signal)
  }

  async historyPage(session: NativeSessionReference, before?: string, signal?: AbortSignal): Promise<NativeHistory> {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    const state = this.requireSession(session)
    const page = await this.messagePage(session.nativeSessionId, state.directory, before, combined)
    const pendingInteractions = await this.pendingReady(session, combined)
    return { events: normalizedHistory(page.messages, state.configuration.thinking), pendingInteractions,
      ...(pendingInteractions[0] ? { pendingInteraction: pendingInteractions[0] } : {}),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      // A general history page has no requested turn identity. Do not invent a terminal result.
    }
  }

  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    return this.reconcileReady(session, correlationId, combined)
  }

  private async reconcileReady(session: NativeSessionReference, correlationId: string, signal: AbortSignal): Promise<NativeHistory> {
    const state = this.requireSession(session)
    const turn = state.turn?.correlationId === correlationId ? state.turn : undefined
    if (await this.rejectQuestions(session, signal)) {
      await this.cancelReady(session, signal)
      if (turn) turn.terminalResult = failure('OPENCODE_QUESTION_UNSUPPORTED', 'An owned native question was rejected because this transport supports approvals, not interactive questions.')
    }
    const messageID = nativeMessageId(correlationId)
    const statusBefore = await this.sessionStatus(session.nativeSessionId, state.directory, signal)
    const root = await this.message(session.nativeSessionId, messageID, state.directory, signal)
    const page = await this.messagePage(session.nativeSessionId, state.directory, undefined, signal)
    const pendingInteractions = await this.pendingReady(session, signal)
    const result: NativeHistory = { events: normalizedHistory(page.messages, state.configuration.thinking), pendingInteractions,
      ...(pendingInteractions[0] ? { pendingInteraction: pendingInteractions[0] } : {}),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
    if (turn?.terminalResult) return { ...result, terminalResult: turn.terminalResult }
    if (!root) {
      if (!turn?.submitted) throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_MISSING', 'The requested turn could not be identified in native history; older answers are not substitutes.')
    } else if (root.info.role !== 'user') {
      throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_INVALID', 'The correlated native message is not a user prompt.')
    }
    let terminalResult: NativeHistory['terminalResult']
    if (root) {
      const history = new OpenCodeTurnHistory(root)
      let current = page
      const cursors = new Set<string>()
      let pages = 0
      while (true) {
        for (let index = current.messages.length - 1; index >= 0; index -= 1) if (history.push(current.messages[index]!)) break
        if (history.rooted || !current.nextCursor) break
        if (cursors.has(current.nextCursor) || pages++ > 10_000) throw new Error('OpenCode history pagination did not make bounded progress.')
        boundedSetAdd(cursors, current.nextCursor)
        current = await this.messagePage(session.nativeSessionId, state.directory, current.nextCursor, signal)
      }
      if (!history.rooted) throw new HarnessExecutionError('OPENCODE_TURN_HISTORY_INCOMPLETE', 'Native history did not include the correlated prompt; no older result was selected.')
      terminalResult = history.result
    }
    const statusAfter = await this.sessionStatus(session.nativeSessionId, state.directory, signal)
    if (statusBefore !== 'idle' || statusAfter !== 'idle' || pendingInteractions.length) return result
    if (!terminalResult && turn?.scopedError && (root || turn.idleObserved)) {
      const error = turn.scopedError
      terminalResult = failure(typeof error.name === 'string' ? error.name : 'OPENCODE_TURN_FAILED',
        typeof object(error.data).message === 'string' ? String(object(error.data).message) : 'OpenCode failed before producing an assistant response.')
    }
    if (!terminalResult && root && (!turn || turn.generation !== this.generation || turn.idleObserved)) {
      terminalResult = failure('OPENCODE_TURN_INTERRUPTED', 'The correlated native turn is idle without a final assistant result; it was interrupted or stopped before completion.')
    }
    if (!terminalResult && !root && turn && turn.generation !== this.generation) {
      terminalResult = failure('OPENCODE_TURN_DELIVERY_UNRESOLVED', 'OpenCode restarted without a persisted identity for the submitted turn. The prompt was not replayed.')
    }
    if (terminalResult) {
      if (turn) turn.terminalResult = terminalResult
      result.terminalResult = terminalResult
    }
    return result
  }

  close(session: NativeSessionReference): Promise<void> {
    return this.exclusive(async () => {
      const state = this.requireSession(session)
      if (state.turn?.observing || (state.turn?.submitted && !state.turn.terminalResult)) {
        throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'Cancel or reconcile this native turn before closing its session.')
      }
      this.sessions.delete(session.nativeSessionId)
      if (this.sessions.size === 0) await this.disposeUnusedServer()
    })
  }

  dispose(): Promise<void> {
    // Synchronously invalidate queued setup and observers, then drain the owner lifecycle.
    this.lifetime.abort(new Error('OpenCode session manager disposed.'))
    const stopping = this.options.server.dispose()
    void stopping.catch(() => undefined)
    return this.exclusive(async () => {
      this.sessions.clear()
      try { await stopping } finally { this.boundEnvironmentFingerprint = undefined; this.readyGeneration = undefined }
    })
  }

  restartForCredential(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      if (environment.agentId !== this.options.ownerAgentId) throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The replacement credential belongs to another Agent.')
      if ([...this.sessions.values()].some((state) => state.turn && !state.turn.terminalResult)) {
        throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_BUSY', 'Credential renewal requires all owned turns to be reconciled idle.')
      }
      // Reattached/native work can exist without an in-memory turn marker.
      for (const [id, state] of this.sessions) {
        if (await this.sessionStatus(id, state.directory, combined) !== 'idle') throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_BUSY', 'A persisted native session is still active.')
      }
      if (!this.options.server.restart) throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_UNSUPPORTED', 'This controller cannot replace its credential context.')
      try {
        await this.options.server.restart(environment, combined)
        this.boundEnvironmentFingerprint = childEnvironmentFingerprint(environment)
      } finally {
        // A failed restart can still bind validated desired credentials.
        this.boundEnvironmentFingerprint = this.options.server.credentialEnvironmentFingerprint ?? this.boundEnvironmentFingerprint
        this.readyGeneration = undefined
      }
      await this.ready(combined)
    })
  }

  private async bindEnvironment(environment: ChildProcessEnvironment | undefined, signal: AbortSignal): Promise<void> {
    // An explicitly configured owner-scoped controller is already a validated binding.
    if (!environment && this.boundEnvironmentFingerprint && this.options.server.credentialEnvironmentFingerprint === this.boundEnvironmentFingerprint) return
    const selected = environment ?? { agentId: this.options.ownerAgentId, variables: {} }
    if (selected.agentId !== this.options.ownerAgentId) throw new HarnessExecutionError('OPENCODE_SESSION_OWNER_MISMATCH', 'The session credential belongs to another Agent.')
    if (Object.keys(selected.variables).some((key) => key !== 'GRAPHQL_APP_MCP_TOKEN')) throw new HarnessExecutionError('OPENCODE_CREDENTIAL_ENV_UNSUPPORTED', 'Only the scoped App credential can be bound.')
    const fingerprint = childEnvironmentFingerprint(selected)
    if (this.boundEnvironmentFingerprint === fingerprint) return
    if (this.boundEnvironmentFingerprint) throw new HarnessExecutionError('OPENCODE_CREDENTIAL_CONTEXT_MISMATCH', 'Use explicit idle renewal to change this manager credential context.')
    if (environment) {
      if (!this.options.server.restart) throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_UNSUPPORTED', 'This controller cannot bind the scoped App credential.')
      await this.options.server.restart(selected, signal)
      this.readyGeneration = undefined
    }
    this.boundEnvironmentFingerprint = fingerprint
  }

  private async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.options.server.expectedVersion !== QUALIFIED_OPENCODE_VERSION) throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'OpenCode native mode requires exactly 1.18.31.')
    await this.options.server.ensure(signal)
    if (this.readyGeneration === this.generation) return
    const generation = this.generation
    const health = object(await this.json('/global/health', undefined, signal))
    const document = object(await this.json('/doc', undefined, signal))
    if (health.healthy !== true || health.version !== QUALIFIED_OPENCODE_VERSION) throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'Live OpenCode health/version did not match 1.18.31.')
    const paths = object(document.paths)
    for (const path of ['/session', '/session/status', '/session/{sessionID}', '/session/{sessionID}/message',
      '/session/{sessionID}/message/{messageID}', '/session/{sessionID}/prompt_async', '/session/{sessionID}/abort',
      '/permission', '/permission/{requestID}/reply', '/question', '/question/{requestID}/reject', '/event', '/config', '/mcp']) {
      if (!(path in paths)) throw new HarnessExecutionError('OPENCODE_SERVER_SCHEMA_UNQUALIFIED', `The live OpenCode schema is missing ${path}.`)
    }
    // MCP controls are directory-instance state, so restore once per retained directory.
    const restored = new Set<string>()
    for (const state of this.sessions.values()) {
      if (restored.has(state.directory)) continue
      await this.applyMcpControls(state.configuration, state.directory, signal)
      restored.add(state.directory)
    }
    if (generation !== this.generation) throw new OpenCodeNativeDeliveryError('OPENCODE_SERVER_GENERATION_CHANGED', 'OpenCode changed again while restoring native settings.', 'definite')
    this.readyGeneration = generation
  }

  private async qualifyConfiguration(configuration: OpenCodeHarnessConfiguration, directory: string, signal: AbortSignal): Promise<void> {
    if (configuration.autoApprove || configuration.advanced?.permissionHandling === 'native_auto') throw new HarnessExecutionError('OPENCODE_SERVER_AUTO_CONFLICT', 'Native auto handling conflicts with GraphQL-routed review.')
    if (this.options.server instanceof ManagedOpenCodeServer && !isDeepStrictEqual(configuration.advanced, this.options.server.advancedConfiguration)) {
      throw new HarnessExecutionError('OPENCODE_SERVER_CONFIGURATION_MISMATCH', 'Process-level Advanced settings differ from the pinned session configuration.')
    }
    for (const state of this.sessions.values()) {
      if (state.directory === directory && !isDeepStrictEqual(state.configuration.advanced?.mcp.serverEnabled ?? {}, configuration.advanced?.mcp.serverEnabled ?? {})) {
        throw new HarnessExecutionError('OPENCODE_MCP_CONTEXT_CONFLICT', 'Sessions in one native directory instance cannot select conflicting MCP controls.')
      }
    }
    const [providerID, ...model] = configuration.model.split('/')
    if (!providerID || !model.join('/')) throw new HarnessExecutionError('OPENCODE_MODEL_INVALID', 'OpenCode models require provider/model format.')
    const [providers, agents] = await Promise.all([this.json('/provider', directory, signal), this.json('/agent', directory, signal)])
    if (!providerSupports(providers, providerID, model.join('/'), configuration.variant)) throw new HarnessExecutionError('OPENCODE_MODEL_UNAVAILABLE', 'The selected OpenCode model or named variant is not advertised.')
    if (!Array.isArray(agents) || !agents.some((agent) => object(agent).name === configuration.nativeAgent)) throw new HarnessExecutionError('OPENCODE_NATIVE_AGENT_UNAVAILABLE', 'The selected native Agent is unavailable.')
  }

  private async applyMcpControls(configuration: OpenCodeHarnessConfiguration, directory: string, signal: AbortSignal): Promise<void> {
    const controls = configuration.advanced?.mcp.serverEnabled ?? {}
    if (!Object.keys(controls).length) return
    const configured = object(object(await this.json('/config', directory, signal)).mcp)
    for (const [name, enabled] of Object.entries(controls)) {
      if (!Object.hasOwn(configured, name)) throw new HarnessExecutionError('OPENCODE_MCP_SERVER_NOT_CONFIGURED', `MCP server '${name}' is not in resolved configuration.`)
      const before = object(object(await this.json('/mcp', directory, signal))[name]).status
      const expected = enabled ? 'connected' : 'disabled'
      if (before !== expected) await this.mutate(withDirectory(`/mcp/${encodeURIComponent(name)}/${enabled ? 'connect' : 'disconnect'}`, directory), { method: 'POST' }, signal, false)
      const after = object(object(await this.json('/mcp', directory, signal))[name]).status
      if (after !== expected) throw new HarnessExecutionError('OPENCODE_MCP_CONTROL_NOT_APPLIED', `MCP server '${name}' did not reach the accepted ${expected} state.`)
    }
  }

  private verifyAttachedSession(native: JsonObject, id: string, directory: string, configuration: OpenCodeHarnessConfiguration): void {
    if (native.id !== id) throw new HarnessExecutionError('OPENCODE_SESSION_ID_MISMATCH', 'OpenCode returned a different persisted session identity.')
    if (native.directory !== directory) throw new HarnessExecutionError('OPENCODE_SESSION_DIRECTORY_MISMATCH', 'The persisted session belongs to a different directory.')
    if (!isDeepStrictEqual(native.permission ?? [], nativePolicy(configuration))) throw new HarnessExecutionError('OPENCODE_SESSION_PERMISSION_MISMATCH', 'The complete ordered persisted permission policy differs from the accepted policy. No implicit policy update was performed.')
    if (typeof native.agent === 'string' && native.agent !== configuration.nativeAgent) throw new HarnessExecutionError('OPENCODE_SESSION_CONFIGURATION_MISMATCH', 'The persisted native Agent differs from its pinned configuration.')
    const model = object(native.model)
    const [providerID, ...modelID] = configuration.model.split('/')
    if (Object.keys(model).length && (model.providerID !== providerID || model.id !== modelID.join('/') || (model.variant ?? '') !== configuration.variant)) {
      throw new HarnessExecutionError('OPENCODE_SESSION_CONFIGURATION_MISMATCH', 'The persisted native model or variant differs from its pinned configuration.')
    }
  }

  private configuration(input: NativeSessionStart): OpenCodeHarnessConfiguration {
    const configuration = input.kind === 'operator' ? input.configuration.harness : input.request.configuration.harness
    if (configuration.harness !== 'opencode') throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'OpenCode received a different harness configuration.')
    return structuredClone(configuration)
  }
  private validateReference(session: NativeSessionReference): void {
    if (session.harness !== 'opencode' || session.providerVersion !== QUALIFIED_OPENCODE_VERSION) throw new HarnessExecutionError('OPENCODE_SESSION_UNQUALIFIED', 'The persisted native session is not qualified for this manager.')
  }
  private requireSession(session: NativeSessionReference): SessionState {
    this.validateReference(session)
    const state = this.sessions.get(session.nativeSessionId)
    if (!state) throw new HarnessExecutionError('OPENCODE_SESSION_CONTEXT_MISSING', 'The native session working directory and configuration are unavailable.')
    return state
  }

  private async ownedSession(root: string, candidate: string, state: SessionState, signal: AbortSignal): Promise<boolean> {
    if (candidate === root) return true
    if (state.ownedIds.get(candidate)) return true
    const visited = new Set<string>()
    let id: string | undefined = candidate
    while (id && visited.size < 256 && !visited.has(id)) {
      if (id === root) { boundedMapSet(state.ownedIds, candidate, true); return true }
      visited.add(id)
      const response = await this.options.server.request(withDirectory(`/session/${encodeURIComponent(id)}`, state.directory), { method: 'GET' }, signal)
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return false }
      if (!response.ok) throw await responseError(response, 'OPENCODE_SESSION_LOOKUP_FAILED', response.status >= 500 ? 'uncertain' : 'definite')
      const native = object(await readJson(response))
      if (native.id !== id || native.directory !== state.directory) return false
      id = typeof native.parentID === 'string' ? native.parentID : undefined
    }
    return false
  }

  private async rejectQuestions(session: NativeSessionReference, signal: AbortSignal): Promise<boolean> {
    const state = this.requireSession(session)
    const questions = await this.json('/question', state.directory, signal)
    if (!Array.isArray(questions)) throw new Error('Invalid native question response.')
    let rejected = false
    for (const value of questions) {
      const question = object(value)
      if (typeof question.id !== 'string' || typeof question.sessionID !== 'string') continue
      if (!(await this.ownedSession(session.nativeSessionId, question.sessionID, state, signal))) continue
      await this.mutate(withDirectory(`/question/${encodeURIComponent(question.id)}/reject`, state.directory), { method: 'POST' }, signal)
      rejected = true
    }
    return rejected
  }

  private async permissionRequests(directory: string, signal: AbortSignal): Promise<NativePermissionRequest[]> {
    const value = await this.json('/permission', directory, signal)
    if (!Array.isArray(value)) throw new Error('Invalid native permission response.')
    return value.filter((item): item is NativePermissionRequest => {
      const request = object(item)
      return typeof request.id === 'string' && typeof request.sessionID === 'string' && typeof request.permission === 'string'
        && Array.isArray(request.patterns) && Array.isArray(request.always) && !!request.metadata && typeof request.metadata === 'object'
    })
  }

  private async sessionStatus(id: string, directory: string, signal: AbortSignal): Promise<string> {
    const statuses = object(await this.json('/session/status', directory, signal))
    const status = object(statuses[id]).type
    // V1 removes idle sessions from this sparse map.
    if (status === undefined) return 'idle'
    if (!['idle', 'busy', 'retry'].includes(String(status))) throw new Error('Unknown native session status.')
    return String(status)
  }

  private async message(sessionID: string, messageID: string, directory: string, signal: AbortSignal): Promise<OpenCodeMessage | undefined> {
    const response = await this.options.server.request(withDirectory(`/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`, directory), { method: 'GET' }, signal)
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return undefined }
    if (!response.ok) throw await responseError(response, 'OPENCODE_MESSAGE_LOOKUP_FAILED', response.status >= 500 ? 'uncertain' : 'definite')
    const message = object(await readJson(response))
    if (object(message.info).id !== messageID || object(message.info).sessionID !== sessionID || !Array.isArray(message.parts)) throw new Error('Native message identity did not match the lookup.')
    return message as OpenCodeMessage
  }

  private async messagePage(sessionID: string, directory: string, before: string | undefined, signal: AbortSignal): Promise<MessagePage> {
    const query = `/session/${encodeURIComponent(sessionID)}/message?limit=${OPENCODE_HISTORY_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`
    const response = await this.options.server.request(withDirectory(query, directory), { method: 'GET' }, signal)
    if (!response.ok) throw await responseError(response, 'OPENCODE_HISTORY_UNAVAILABLE', response.status >= 500 ? 'uncertain' : 'definite')
    const nextCursor = response.headers.get('x-next-cursor')
    const value = await readJson(response)
    if (!Array.isArray(value) || value.some((item) => !object(item).info || !Array.isArray(object(item).parts))) throw new Error('Invalid native message history.')
    return { messages: value as OpenCodeMessage[], ...(nextCursor ? { nextCursor } : {}) }
  }

  private async openEvents(directory: string, signal: AbortSignal, ensureReady = true): Promise<Response> {
    if (ensureReady) await this.exclusive(() => this.ready(signal))
    const response = await this.options.server.request(withDirectory('/event', directory), {
      method: 'GET', headers: { accept: 'text/event-stream' },
    }, signal, this.readyGeneration)
    if (!response.ok || !response.body) throw await responseError(response, 'OPENCODE_SSE_UNAVAILABLE', response.status >= 500 ? 'uncertain' : 'definite')
    return response
  }

  private record(state: SessionState, native: OpenCodeEvent): NativeHarnessEvent | undefined {
    const key = native.id ?? native.sseId
    if (key && state.eventIds.has(key)) return undefined
    if (key) boundedSetAdd(state.eventIds, key)
    return this.recordSynthetic(state, native.type, { ...object(native.properties), ...(key ? { nativeEventId: key } : {}) })
  }
  private recordSynthetic(state: SessionState, type: string, payload: JsonObject): NativeHarnessEvent {
    const serialized = JSON.stringify(payload)
    const retained = serialized.length > 64_000 ? { nativeEventId: payload.nativeEventId,
      sessionID: payload.sessionID ?? object(payload.part).sessionID, payloadOmitted: true,
      detail: 'Retrieve this large native payload through paginated authoritative history.' } : payload
    const event = NativeHarnessEventSchema.parse({ sequence: state.sequence++, type, occurredAt: new Date().toISOString(), payload: retained })
    state.events.push(event)
    state.eventBytes += JSON.stringify(event).length
    while (state.events.length > OPENCODE_EVENT_LIMIT || state.eventBytes > OPENCODE_EVENT_BYTES) {
      state.eventBytes -= JSON.stringify(state.events.shift()!).length
    }
    return event
  }

  private async json(path: string, directory: string | undefined, signal: AbortSignal): Promise<unknown> {
    const response = await this.options.server.request(directory ? withDirectory(path, directory) : path, { method: 'GET' }, signal)
    if (!response.ok) throw await responseError(response, response.status === 404 ? 'OPENCODE_SESSION_NOT_FOUND' : 'OPENCODE_SERVER_REQUEST_FAILED', response.status >= 500 ? 'uncertain' : 'definite')
    return response.status === 204 ? undefined : readJson(response)
  }

  private async mutate(path: string, init: RequestInit, signal: AbortSignal, requireReady = true): Promise<unknown> {
    if (signal.aborted) throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_NOT_DISPATCHED', 'The native mutation was canceled before dispatch.', 'definite')
    let response: Response
    try { response = await this.options.server.request(path, init, signal, requireReady ? this.readyGeneration : this.generation) }
    catch (error) {
      if (error instanceof OpenCodeNativeDeliveryError) throw error
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The native mutation may have been accepted before the connection failed.', 'uncertain', { cause: error })
    }
    if (!response.ok) throw await responseError(response, 'OPENCODE_NATIVE_DELIVERY_REJECTED', response.status >= 500 ? 'uncertain' : 'definite')
    try { return response.status === 204 ? undefined : await readJson(response) }
    catch (error) { throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The native mutation was accepted but its response body could not be read.', 'uncertain', { cause: error }) }
  }

  private async cleanupFailedSetup(error: unknown): Promise<never> {
    // Session setup is serialized, including cleanup: another setup cannot be in flight here.
    if (!this.sessions.size) {
      try { await this.disposeUnusedServer() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Session setup and unused-server cleanup both failed.', { cause: cleanupError })
      }
    }
    throw error
  }
  private async disposeUnusedServer(): Promise<void> {
    try { await this.options.server.dispose() }
    finally { this.boundEnvironmentFingerprint = undefined; this.readyGeneration = undefined }
  }

  async inspectNativeMcp(directory: string, signal?: AbortSignal): Promise<OpenCodeMcpInspection> {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    const config = object(await this.json('/config', directory, combined))
    const statuses = object(await this.json('/mcp', directory, combined))
    const name = this.options.appMcpServerName ?? 'graphql-app'
    const configured = object(config.mcp)[name]
    const status = object(statuses[name]).status
    const nativeStatus: OpenCodeMcpInspection['nativeStatus'] = !configured ? 'not_detected'
      : ['connected', 'disabled', 'failed', 'needs_auth', 'needs_client_registration'].includes(String(status))
        ? status as OpenCodeMcpInspection['nativeStatus'] : 'failed'
    const endpoint = typeof object(configured).url === 'string' ? String(object(configured).url) : null
    return { cwd: directory, providerVersion: QUALIFIED_OPENCODE_VERSION, serverName: name, nativeStatus, endpoint,
      credentialEnvironmentVariable: this.options.server.mcpCredentialReferences?.[name] ?? null,
      endpointMatches: this.options.expectedAppMcpEndpoint ? endpoint === this.options.expectedAppMcpEndpoint : null,
      baseConfigurationFilters: configurationPermissionRules(config.permission), policyScope: 'base_configuration_only',
    }
  }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    const first = this.sessions.values().next().value as SessionState | undefined
    const baseline = { harness: 'opencode' as const, serverName: this.options.appMcpServerName ?? 'graphql-app',
      endpointMatches: null, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString() }
    if (!first) return { ...baseline, state: 'status_unavailable', detail: 'A runner working directory is required for native MCP inspection.' }
    try {
      const native = await this.inspectNativeMcp(first.directory, signal)
      const state: McpDetection['state'] = native.nativeStatus === 'not_detected' ? 'not_detected' : native.endpointMatches === false ? 'misconfigured'
        : native.nativeStatus === 'connected' ? 'connected' : native.nativeStatus === 'disabled' ? 'disabled'
          : ['needs_auth', 'needs_client_registration'].includes(native.nativeStatus) ? 'authentication_required' : 'broken'
      return { ...baseline, state, endpointMatches: native.endpointMatches, credentialEnvironmentVariable: native.credentialEnvironmentVariable }
    } catch {
      return { ...baseline, state: 'check_failed', detail: 'OpenCode MCP inspection failed; resolved credential values are not included in diagnostics.' }
    }
  }
}

function newState(directory: string, configuration: OpenCodeHarnessConfiguration): SessionState {
  return { directory, configuration, events: [], eventBytes: 0, eventIds: new Set(), pendingIds: new Set(), historyIds: new Set(),
    partTypes: new Map(), ownedIds: new Map(), sequence: 0, turn: undefined }
}
function withDirectory(path: string, directory: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}`
}
function optionsForRequest(id: string): ApprovalResponseOption[] {
  return OPENCODE_APPROVAL_OPTIONS_FIXTURE.map((option) => ({ ...option, optionId: `${id}:${option.semantic}` }))
}
async function responseError(response: Response, code: string, certainty: NativeDeliveryCertainty): Promise<OpenCodeNativeDeliveryError> {
  // Never echo expanded native configuration or credential-bearing response text.
  await response.body?.cancel().catch(() => undefined)
  return new OpenCodeNativeDeliveryError(code, `OpenCode returned HTTP ${response.status}.`, certainty)
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('OpenCode response body is missing.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 8_000_000) throw new Error('OpenCode response exceeds the bounded native page buffer.')
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
