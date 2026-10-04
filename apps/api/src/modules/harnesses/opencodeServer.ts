import { childHistoryCursor, childHistoryEvent, encodeChildHistoryCursor } from '../subagents/nativeReadback.js'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { unavailableNativeResponse, type NativeResponseAvailability, type NativeResponseAvailabilityQuery } from './responseAvailability.js'
import { openCodePermissionTurnId } from './opencodeInteractions.js'
import { createOpenCodeBoundFetch, OPENCODE_HTTP_BODY_LIMIT, type OpenCodeClientFactory } from './opencodeClient.js'
import { APP_MCP_SERVER_NAME, APP_MCP_TOKEN, appMcpServerName, chatExcludedAppMcpServerNames, isAppLauncher, isSupportedAppMcpServerName, isSupportedAppMcpTokenName } from './appMcpLauncher.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema,
  NativeSessionReferenceSchema,
  OPENCODE_APPROVAL_OPTIONS_FIXTURE,
  OpenCodeHarnessConfigurationSchema,
  PendingNativeInteractionSchema,
  type ApprovalResponseOption,
  type McpDetection,
  type NativeHarnessCapabilities,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type OpenCodeHarnessConfiguration,
  type PendingNativeInteraction,
} from '@foreman-code/contracts'

import { HarnessExecutionError } from './errors.js'
import { nativeQualification } from './nativeQualification.js'
import { openCodeOptions } from './operatorOptions.js'
import { endpointMatches, type NativeMcpEntryEvidence } from './mcpDetection.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from './port.js'
import {
  boundedMapSet, boundedSetAdd, configurationPermissionRules, digest, eventSessionId, failure,
  nativeMessageId, nativePolicy, normalizedHistory, object, OpenCodeTurnHistory,
  OPENCODE_EVENT_BYTES, OPENCODE_EVENT_LIMIT, OPENCODE_HISTORY_PAGE_SIZE,
  parseOpenCodeSse, providerSupports, visibleNativeEvent,
  type JsonObject, type OpenCodeEvent, type OpenCodeMessage,
} from './opencodeProtocol.js'
import {
  assertOpenCodeChatMcpDisabled, childEnvironmentFingerprint, ManagedOpenCodeServer, OpenCodeNativeDeliveryError,
  type NativeDeliveryCertainty, type OpenCodeServerController,
} from './opencodeTransport.js'
import { redactKnownSecrets } from './secrets.js'
import { OpenCodeNativeAutoReplies, usesOpenCodeNativeAuto } from './opencodeNativeAuto.js'
import type { NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import { isOpenCodeReplyAcknowledgement } from './openCodeResponseAcknowledgement.js'
import type { NativeResponseJournal } from './recovery/responseJournal.js'
import { OPENCODE_RECONCILIATION_EVENT, openCodeReconciliationPayload } from './opencodeReconciliation.js'
import { agentInstructionBundle, type AgentInstructionBundle } from '../skills/instructions.js'
import { prepareOpenCodeChatFiles, type OpenCodeChatFiles, type OpenCodeManagedFileTurn } from './opencodeFiles/chat.js'
import { harnessProfile } from './qualification/profiles.js'
import type { RunSubagent, RunSubagentCommandReceipt } from '@foreman-code/contracts/subagents'
import type { SubagentControlLease } from '../subagents/types.js'
import { SubagentDispatchRejectedError } from '../subagents/controlErrors.js'

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
  activityObserved?: boolean
  observerAbort?: AbortController
  scopedError: JsonObject | undefined
  questionFailure?: NonNullable<NativeHistory['terminalResult']>
  terminalResult: NativeHistory['terminalResult']
  nativeMessageId?: string
  reconciliationEvents?: readonly NativeHarnessEvent[]
  /** The native turn owns file inputs/tools across observer detach and retry. */
  files?: OpenCodeManagedFileTurn
  fileIdentity?: string
}
interface SessionState {
  readonly connectionId: string
  responsesInFlight: Set<string>
  responsesUncertain: Set<string>
  autoReplies: OpenCodeNativeAutoReplies
  directory: string
  configuration: OpenCodeHarnessConfiguration
  /** The accepted configuration's pinned app instructions, sent as system on every new turn. */
  instructions: AgentInstructionBundle | undefined
  events: NativeHarnessEvent[]
  eventBytes: number
  eventIds: Set<string>
  pendingIds: Set<string>
  historyIds: Set<string>
  partTypes: Map<string, string>
  ownedIds: Map<string, boolean>
  sequence: number
  turn: OwnedTurn | undefined
  admissionPending?: AbortController
  recoveryCorrelationId?: string
}
interface MessagePage { messages: OpenCodeMessage[]; nextCursor?: string }

export interface OpenCodeNativeSessionManagerOptions {
  /** Authenticated durable chat admission + execution-host capabilities only. */
  chatFiles?: OpenCodeChatFiles
  responseJournal?: NativeResponseJournal
  /** Injected beneath the real manager for deterministic transport replay. */
  clientFactory?: OpenCodeClientFactory
  server: OpenCodeServerController
  ownerAgentId: string
  appMcpServerName?: string
  expectedAppMcpEndpoint?: string
  credentialEnvironmentVariable?: string
  /** Agent chat has no App MCP authority; other consumers keep their scoped credential checks. */
  appMcpAccess?: 'scoped' | 'none'
}
export interface OpenCodeMcpInspection {
  automaticEndpoint?: boolean
  cwd: string
  providerVersion: string
  serverName: string
  nativeStatus: 'connected' | 'disabled' | 'failed' | 'needs_auth' | 'needs_client_registration' | 'not_detected' | 'status_unavailable'
  transport?: NativeMcpEntryEvidence['transport']
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
  // Same-manager retry proof only. Durable restart recovery still requires the
  // closure-store receipt and never infers closure from a missing process.
  private readonly restartClosures = new Map<string, NativeSessionReference>()
  private lifecycle: Promise<unknown> = Promise.resolve()
  private lifetime = new AbortController()
  private disposal: Promise<void> | undefined
  private boundEnvironmentFingerprint: string | undefined
  private readyGeneration: number | undefined
  private healthVersion: string | undefined
  private readonly knownSecrets = new Set<string>()
  private readonly responseReceipts = new Map<string, NativeResponseDeliveryEvidence>()
  private readonly childCommandAttempts = new Set<string>()

  constructor(private readonly options: OpenCodeNativeSessionManagerOptions) {
    if (options.chatFiles && options.appMcpAccess !== 'none') {
      throw new HarnessExecutionError('OPENCODE_APP_MCP_UNAVAILABLE', 'File chat requires a credential-free, App-MCP-disabled native manager.')
    }
    if (options.server.ownerAgentId !== undefined && options.server.ownerAgentId !== options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The native manager and resident server must have the same credential owner.')
    }
    if (options.appMcpAccess === 'none') {
      const empty = childEnvironmentFingerprint({ agentId: options.ownerAgentId, variables: {} })
      if ((options.server.credentialEnvironmentFingerprint && options.server.credentialEnvironmentFingerprint !== empty)
        || (options.server instanceof ManagedOpenCodeServer
          && options.server.disabledAppMcpServerName !== (options.appMcpServerName ?? APP_MCP_SERVER_NAME))) {
        throw new HarnessExecutionError('OPENCODE_APP_MCP_UNAVAILABLE', 'Chat requires its own credential-free server with the App MCP launch override.')
      }
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
  private get providerVersion(): string { return this.healthVersion ?? this.options.server.expectedVersion }

  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    await this.exclusive(() => this.ready(this.signal(signal)))
    return NativeHarnessCapabilitiesSchema.parse({
      provider: 'opencode', providerVersion: this.providerVersion,
      persistentSessions: true, reconnect: true, sameRequestResponses: true,
      cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true, supportedInteractionKinds: ['approval'],
    })
  }

  async discoverOptions(directory: string, signal?: AbortSignal) {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      await this.ready(combined)
      const [providers, agents] = await Promise.all([this.json('/provider', directory, combined), this.json('/agent', directory, combined)])
      return { providerVersion: this.providerVersion, ...openCodeOptions(providers, agents) }
    })
  }

  async checkConfiguration(value: OpenCodeHarnessConfiguration, directory: string, signal?: AbortSignal): Promise<void> {
    const combined = this.signal(signal)
    await this.exclusive(async () => {
      await this.ready(combined)
      await this.qualifyConfiguration(value, directory, combined)
      const [providers, agents] = await Promise.all([this.json('/provider', directory, combined), this.json('/agent', directory, combined)])
      const options = openCodeOptions(providers, agents)
      if (!options.models.some((model) => model.id === value.model && model.variants.includes(value.variant))) {
        throw new HarnessExecutionError('OPENCODE_AUTH_REQUIRED', 'The selected model and variant must belong to a connected provider.')
      }
      // Inspect switches without connecting/disconnecting a native MCP server.
      const configured = object(object(await this.json('/config', directory, combined)).mcp)
      for (const savedName of Object.keys(value.advanced?.mcp.serverEnabled ?? {})) {
        if (this.options.appMcpAccess === 'none'
          && chatExcludedAppMcpServerNames(this.options.appMcpServerName ?? APP_MCP_SERVER_NAME).includes(savedName)) continue
        const name = appMcpServerName(configured, savedName)
        if (!Object.hasOwn(configured, name)) throw new HarnessExecutionError('OPENCODE_MCP_SERVER_NOT_CONFIGURED', 'An accepted MCP server is not configured.')
      }
    })
  }

  createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      try {
        combined.throwIfAborted()
        const directory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
        const configuration = this.configuration(input)
        const instructions = sessionInstructions(input)
        await this.bindEnvironment(input.environment, combined)
        await this.ready(combined)
        await this.assertConfiguration(configuration, directory, combined)
        await this.applyMcpControls(configuration, directory, combined)
        const [providerID, ...model] = configuration.model.split('/')
        const response = object(await this.mutate(withDirectory('/session', directory), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: input.kind === 'operator' ? `Foreman Code Operator ${input.correlationId}` : `Foreman Code ${input.request.executionId}`,
            agent: configuration.nativeAgent,
            model: { providerID, id: model.join('/'), ...(configuration.variant ? { variant: configuration.variant } : {}) },
            permission: nativePolicy(configuration),
          }),
        }, combined))
        if (typeof response.id !== 'string' || !response.id) {
          throw new OpenCodeNativeDeliveryError('OPENCODE_SESSION_ID_MISSING', 'Session creation may have succeeded but did not return a native identity.', 'uncertain')
        }
        const session = NativeSessionReferenceSchema.parse({ harness: 'opencode', providerVersion: this.providerVersion, nativeSessionId: response.id })
        // A returned provider identity is authoritative even if cancellation raced
        // the response. Publish and return it so the caller can persist ownership.
        this.sessions.set(response.id, newState(directory, configuration, instructions))
        this.restartClosures.delete(response.id)
        return session
      } catch (error) { return this.cleanupFailedSetup(error) }
    })
  }

  /** `POST /session/{id}/fork` copies source history into a new session; the source session is not written. */
  forkSession(source: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      try {
        combined.throwIfAborted()
        const directory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
        const configuration = this.configuration(input)
        const instructions = sessionInstructions(input)
        await this.bindEnvironment(input.environment, combined)
        await this.ready(combined)
        this.validateReference(source)
        await this.assertConfiguration(configuration, directory, combined)
        const response = object(await this.mutate(withDirectory(`/session/${encodeURIComponent(source.nativeSessionId)}/fork`, directory), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        }, combined, true, 'OPENCODE_SESSION_NOT_FOUND'))
        if (typeof response.id !== 'string' || !response.id || response.id === source.nativeSessionId) {
          throw new OpenCodeNativeDeliveryError('OPENCODE_SESSION_ID_MISSING', 'Session fork may have succeeded but did not return a new native identity.', 'uncertain')
        }
        // A fork copies history, not the permission ruleset. Apply the accepted policy explicitly, then verify it.
        await this.mutate(withDirectory(`/session/${encodeURIComponent(response.id)}`, directory), {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permission: nativePolicy(configuration) }),
        }, combined)
        const native = object(await this.json(`/session/${encodeURIComponent(response.id)}`, directory, combined))
        this.verifyAttachedSession(native, response.id, directory, configuration)
        await this.applyMcpControls(configuration, directory, combined)
        this.sessions.set(response.id, newState(directory, configuration, instructions))
        this.restartClosures.delete(response.id)
        return NativeSessionReferenceSchema.parse({ harness: 'opencode', providerVersion: this.providerVersion, nativeSessionId: response.id })
      } catch (error) { return this.cleanupFailedSetup(error) }
    })
  }

  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      try {
        combined.throwIfAborted()
        if (this.sessions.has(session.nativeSessionId)) {
          throw new HarnessExecutionError('OPENCODE_SESSION_ALREADY_ATTACHED', 'This manager already owns that session; attaching must not discard its writer state.')
        }
        const directory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
        const configuration = this.configuration(input)
        const instructions = sessionInstructions(input)
        await this.bindEnvironment(input.environment, combined)
        await this.ready(combined)
        this.validateReference(session)
        await this.assertConfiguration(configuration, directory, combined)
        const native = object(await this.json(`/session/${encodeURIComponent(session.nativeSessionId)}`, directory, combined))
        this.verifyAttachedSession(native, session.nativeSessionId, directory, configuration)
        await this.applyMcpControls(configuration, directory, combined)
        combined.throwIfAborted()
        const state = newState(directory, configuration, instructions)
        if (input.correlationId) state.recoveryCorrelationId = input.correlationId
        this.sessions.set(session.nativeSessionId, state)
        this.restartClosures.delete(session.nativeSessionId)
        return session
      } catch (error) { return this.cleanupFailedSetup(error) }
    })
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    yield* this.watchTurn(session, input.clientCorrelationId, input.prompt, this.signal(signal), input.onSubmitted)
  }

  /** Explicit nonmutating recovery seam: this method never submits prompt_async. */
  async *observeTurn(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    yield* this.watchTurn(session, correlationId, undefined, this.signal(signal))
  }

  private async *watchTurn(session: NativeSessionReference, correlationId: string, prompt: string | undefined, signal: AbortSignal,
    onSubmitted?: (nativeTurnId: string) => Promise<void>): AsyncIterable<NativeHarnessEvent> {
    const state = this.requireSession(session)
    if (state.admissionPending) throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'This session already has pending turn admission.')
    const admission = new AbortController()
    state.admissionPending = admission
    signal = AbortSignal.any([signal, admission.signal])
    let turn: OwnedTurn | undefined
    let response: Response | undefined
    let responseGeneration: number | undefined
    let initialHistory: NativeHistory | undefined
    try {
      await this.exclusive(async () => {
        signal.throwIfAborted()
        if (this.requireSession(session) !== state) throw new HarnessExecutionError('OPENCODE_SESSION_CONTEXT_MISSING', 'The session was closed before its turn could be reserved.')
        await this.ready(signal)
        if (this.options.chatFiles && [...this.sessions.values()].some((other) => other !== state
          && other.turn && (other.turn.files || (other.turn.submitted && !other.turn.terminalResult)))) {
          throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'File chat cannot share its native process with another active chat turn.')
        }
        if (state.turn?.observing) throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'This turn already has an event observer; detach it before re-subscribing.')
        if (state.turn && !state.turn.terminalResult && state.turn.correlationId !== correlationId) {
          await this.reconcileReady(session, state.turn.correlationId, signal)
          if (!state.turn.terminalResult) throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'The previous native turn is still running or its outcome is uncertain.')
        }
        if (state.turn?.terminalResult && state.turn.files) {
          await this.finishFiles(state.turn, 'terminal')
        }
        const messageID = nativeMessageId(correlationId)
        const root = await this.message(session.nativeSessionId, messageID, state.directory, signal)
        if (state.turn?.correlationId === correlationId) {
          turn = state.turn
          if (prompt !== undefined && turn.promptHash && turn.promptHash !== turnDigest(prompt, state.instructions, turn.fileIdentity)) {
            throw new HarnessExecutionError('OPENCODE_CORRELATION_CONFLICT', 'The correlation ID was already used for a different prompt.')
          }
        } else {
          if (!root && prompt === undefined) {
            throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_MISSING', 'The requested native turn identity could not be recovered; no prompt was replayed.')
          }
          if (root && prompt !== undefined && (root.parts.filter((part) => part.type === 'text' && part.ignored !== true).map((part) => part.text).join('') !== prompt
            || (root.info.system ?? undefined) !== state.instructions?.text)) {
            throw new HarnessExecutionError('OPENCODE_CORRELATION_CONFLICT', 'The persisted correlation belongs to a different prompt.')
          }
          turn = {
            correlationId, messageID, promptHash: prompt === undefined ? undefined : turnDigest(prompt, state.instructions),
            submitted: !!root, observing: false, generation: this.generation, submittedAt: 0,
            idleObserved: false, scopedError: undefined, terminalResult: undefined,
          }
          state.turn = turn
          state.autoReplies.resume()
        }
        turn.observing = true
        turn.observerAbort = admission
        if (turn.terminalResult) return
        if (turn.submitted) {
          initialHistory = await this.reconcileReady(session, correlationId, signal)
          // Exact persisted submission precedes this observer's new subscription.
          // The original pre-submission stream still requires its live root event.
          if (root?.info.role === 'user') turn.activityObserved = true
          // An observer can yield saved history before its next pull. Subscribe
          // now so native completion in that interval is not missed.
          if (turn.files && !initialHistory.terminalResult) {
            responseGeneration = this.generation
            response = await this.openEvents(state.directory, signal, false)
          }
          return
        }
        const status = await this.sessionStatus(session.nativeSessionId, state.directory, signal)
        if (status !== 'idle') throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'The native session has active work; another prompt was not submitted.')
        if (!turn.files && this.options.chatFiles) {
          const files = await prepareOpenCodeChatFiles(this.options.chatFiles, {
            ownerAgentId: this.options.ownerAgentId, nativeSessionId: session.nativeSessionId,
            nativeTurnId: messageID, clientCorrelationId: correlationId, directory: state.directory,
            configuration: state.configuration,
          }, this.options.server, this.options.appMcpServerName ?? APP_MCP_SERVER_NAME, signal, (token) => { this.knownSecrets.add(token) })
          if (files) {
            turn.files = files
            turn.fileIdentity = files.inputs.identity
            turn.promptHash = turnDigest(prompt ?? '', state.instructions, turn.fileIdentity)
          }
        }
        responseGeneration = this.generation
        response = await this.openEvents(state.directory, signal, false)
        const [providerID, ...model] = state.configuration.model.split('/')
        // Claim delivery before awaiting it. An uncertain transport/body failure must
        // never become permission to resend a potentially accepted prompt.
        turn.files?.bridge.submissionAttempted()
        turn.submitted = true
        turn.submittedAt = Date.now()
        turn.generation = this.generation
        let nativeAcknowledged = false
        try {
          await this.mutate(withDirectory(`/session/${encodeURIComponent(session.nativeSessionId)}/prompt_async`, state.directory), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageID, model: { providerID, modelID: model.join('/') },
              ...(state.configuration.variant ? { variant: state.configuration.variant } : {}),
              agent: state.configuration.nativeAgent, parts: [
                { type: 'text', text: turn.files ? `${prompt ?? ''}\n\n${turn.files.inputs.promptSuffix}` : prompt },
                ...(turn.files?.inputs.imageParts ?? []),
              ],
              ...(state.instructions ? { system: state.instructions.text } : {}),
            }),
          }, signal)
          nativeAcknowledged = true
          await onSubmitted?.(messageID)
          await turn.files?.bridge.acknowledge(signal)
        } catch (error) {
          // A file/listener/adoption failure AFTER native acceptance is not a
          // rejected prompt, even if the secondary error claims definite delivery.
          if (!nativeAcknowledged && error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite') turn.submitted = false
          throw error
        }
      })
      if (state.admissionPending === admission) delete state.admissionPending
      if (!turn) throw new Error('OpenCode turn reservation failed.')
      if (initialHistory) {
        // Authoritative history already carries stable content-addressed identities.
        for (const event of initialHistory.events) yield structuredClone(event)
        for (const pending of initialHistory.pendingInteractions) {
          yield this.recordSynthetic(state, 'interaction.pending', { nativeRequestId: pending.turn.nativeRequestId, nativeSessionId: object(pending.request).sessionID, correlationId })
        }
      }
      if (turn.terminalResult) return
      let failures = 0
      while (true) {
        signal.throwIfAborted()
        try {
          if (!response) {
            responseGeneration = this.generation
            response = await this.openEvents(state.directory, signal)
          }
          if (!response.body) throw new Error('OpenCode event stream has no body.')
          for await (const native of parseOpenCodeSse(response.body, signal)) {
            if (responseGeneration !== this.generation || state.turn !== turn) throw new OpenCodeNativeDeliveryError('OPENCODE_OBSERVER_STALE', 'Native observer ownership changed.', 'uncertain')
            const id = eventSessionId(native)
            if (!id || !(await this.ownedSession(session.nativeSessionId, id, state, signal))) continue
            if (responseGeneration !== this.generation || state.turn !== turn) throw new OpenCodeNativeDeliveryError('OPENCODE_OBSERVER_STALE', 'Native observer ownership changed during ancestry lookup.', 'uncertain')
            if (id === session.nativeSessionId && native.type === 'session.error') turn.scopedError = object(object(native.properties).error)
            if (id === session.nativeSessionId && native.type === 'message.updated'
              && object(native.properties?.info).id === turn.messageID
              && object(native.properties?.info).role === 'user') turn.activityObserved = true
            // A stream may already contain the previous session-global idle when subscribed.
            if (id === session.nativeSessionId && native.type === 'session.idle' && turn.activityObserved) turn.idleObserved = true
            if (native.type === 'permission.asked' && usesOpenCodeNativeAuto(state.configuration)) {
              for (const request of await this.autoReplyPending(session, signal)) {
                yield this.recordSynthetic(state, 'permission.auto_replied', {
                  nativeRequestId: request.id, nativeSessionId: request.sessionID, correlationId, reply: 'once',
                })
              }
              // This is a native client response, not a durable Foreman Code review.
              continue
            }
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
          if (error instanceof HarnessExecutionError || (error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite')) throw error
          failures += 1
        } finally {
          await response?.body?.cancel().catch(() => undefined)
          response = undefined
          responseGeneration = undefined
          state.partTypes.clear()
        }
        try {
          const history = await this.reconcile(session, correlationId, signal)
          for (const event of history.events) {
            const key = event.payload.nativeEventId
            if (typeof key === 'string' && state.historyIds.has(key)) continue
            if (typeof key === 'string') boundedSetAdd(state.historyIds, key)
            yield structuredClone(event)
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
      if (state.admissionPending === admission) delete state.admissionPending
      // Detaching observation is deliberately NOT native cancellation or writer release.
      if (turn) {
        turn.observing = false
        if (turn.observerAbort === admission) delete turn.observerAbort
        if (!turn.submitted && state.turn === turn) {
          await this.finishFiles(turn, 'definite_rejection')
          state.turn = undefined
        }
      }
    }
  }

  private async finishFiles(turn: OwnedTurn, evidence: 'terminal' | 'definite_rejection'): Promise<void> {
    if (!turn.files) return
    await turn.files.finish(evidence, AbortSignal.timeout(10_000))
    delete turn.files
  }

  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
    signal?: AbortSignal): Promise<NativeResponseAvailability> {
    const unavailable = (reason: NativeResponseAvailability['reason'], recovery = false): NativeResponseAvailability => ({
      ...unavailableNativeResponse(session, query, reason), ...(recovery ? { state: 'recovery_required' as const } : {}),
    })
    const ownerSignal = this.signal(signal)
    const combined = AbortSignal.any([ownerSignal, AbortSignal.timeout(30_000)])
    const state = this.sessions.get(session.nativeSessionId)
    if (!state || combined.aborted) return unavailable('session_closed')
    if (session.harness !== 'opencode' || session.providerVersion !== this.providerVersion) return unavailable('identity_mismatch')
    if (query.nativeRequestType !== 'permission.asked' || usesOpenCodeNativeAuto(state.configuration)) return unavailable('unsupported')
    const generation = this.generation
    const resident = this.options.server.requestResident
    if (!resident) return unavailable('unsupported')
    const current = () => !combined.aborted && this.sessions.get(session.nativeSessionId) === state
      && this.generation === generation && this.readyGeneration === generation
      && this.options.server.residentGeneration === generation
      && this.options.server.ownerAgentId === this.options.ownerAgentId
      && this.options.server.expectedVersion === session.providerVersion
      && harnessProfile('opencode', session.providerVersion) !== null
      && this.options.server.credentialEnvironmentFingerprint === this.boundEnvironmentFingerprint
    if (!current()) return unavailable('unqualified', true)
    if (state.responsesInFlight.has(query.nativeRequestId)) return unavailable('response_in_flight')
    if (this.responseReceipts.has(JSON.stringify([session.nativeSessionId, query.nativeRequestId]))) return unavailable('request_consumed')
    if (state.responsesUncertain.has(query.nativeRequestId)) return unavailable('callback_lost', true)
    const read = async (path: string): Promise<unknown> => {
      if (!current()) throw new Error('Native response owner changed.')
      const response = await resident.call(this.options.server, withDirectory(path, state.directory), combined, generation)
      if (!response) throw new Error('Native resident transport is unavailable.')
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error('Native response inspection was rejected.') }
      const value = await readJson(response, combined)
      if (!current()) throw new Error('Native response owner changed during its read.')
      return value
    }
    try {
      const permissions = await read('/permission')
      if (!Array.isArray(permissions)) return unavailable('unqualified')
      const matching = permissions.filter(value => object(value).id === query.nativeRequestId)
      if (!matching.length) return unavailable('request_consumed')
      if (matching.length !== 1) return unavailable('identity_mismatch')
      const request = object(matching[0])
      if (typeof request.sessionID !== 'string' || typeof request.permission !== 'string'
        || !Array.isArray(request.patterns) || !Array.isArray(request.always) || !request.metadata || typeof request.metadata !== 'object') return unavailable('unqualified')
      const visited = new Set<string>()
      let owner: string | undefined = request.sessionID
      while (owner && !visited.has(owner) && visited.size < 256) {
        visited.add(owner)
        const native = object(await read(`/session/${encodeURIComponent(owner)}`))
        if (native.id !== owner || native.directory !== state.directory) return unavailable('identity_mismatch')
        if (owner === session.nativeSessionId) {
          try { this.verifyAttachedSession(native, owner, state.directory, state.configuration) }
          catch { return unavailable('unqualified') }
          break
        }
        owner = typeof native.parentID === 'string' ? native.parentID : undefined
      }
      if (owner !== session.nativeSessionId) return unavailable('identity_mismatch')
      const tool = object(request.tool)
      const rootId = state.turn?.messageID ?? (state.recoveryCorrelationId ? nativeMessageId(state.recoveryCorrelationId) : undefined)
      const message = typeof tool.messageID === 'string'
        ? await read(`/session/${encodeURIComponent(request.sessionID)}/message/${encodeURIComponent(tool.messageID)}`) : undefined
      if (message && (object(object(message).info).id !== tool.messageID
        || object(object(message).info).sessionID !== request.sessionID
        || object(object(message).info).role !== 'assistant')) return unavailable('identity_mismatch')
      const nativeTurnId = openCodePermissionTurnId({ id: query.nativeRequestId, sessionID: request.sessionID,
        ...(typeof tool.messageID === 'string' ? { tool: { messageID: tool.messageID } } : {}),
      }, rootId ? { nativeSessionId: session.nativeSessionId, nativeTurnId: rootId } : undefined, message as OpenCodeMessage | undefined)
      if (query.expectedNativeTurnId !== undefined && nativeTurnId !== query.expectedNativeTurnId) return unavailable('identity_mismatch')
      const latest = await read('/permission')
      if (!Array.isArray(latest)) return unavailable('unqualified')
      const remaining = latest.filter(value => object(value).id === query.nativeRequestId)
      if (!remaining.length) return unavailable('request_consumed')
      if (remaining.length !== 1 || !isDeepStrictEqual(object(remaining[0]), request)) return unavailable('identity_mismatch')
      if (!current()) return unavailable('callback_lost', true)
      if (this.responseReceipts.has(JSON.stringify([session.nativeSessionId, query.nativeRequestId]))) return unavailable('request_consumed')
      if (state.responsesInFlight.has(query.nativeRequestId)) return unavailable('response_in_flight')
      if (state.responsesUncertain.has(query.nativeRequestId)) return unavailable('callback_lost', true)
      return { nativeSessionId: session.nativeSessionId, nativeRequestId: query.nativeRequestId,
        nativeRequestType: query.nativeRequestType, nativeTurnId, generation: `${state.connectionId}:${generation}`,
        qualified: true, state: 'available', path: 'qualified_recovery', reason: 'qualified_recovery' }
    } catch { return unavailable(ownerSignal.aborted ? 'session_closed' : 'callback_lost', !ownerSignal.aborted) }
  }

  async pending(session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined> {
    return (await this.pendingAll(session, signal))[0]
  }

  async pendingAll(session: NativeSessionReference, signal?: AbortSignal): Promise<readonly PendingNativeInteraction[]> {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    return this.pendingReady(session, combined)
  }

  private async ownedPermissions(session: NativeSessionReference, signal: AbortSignal): Promise<NativePermissionRequest[]> {
    const state = this.requireSession(session)
    const requests = await this.permissionRequests(state.directory, signal)
    const owned: NativePermissionRequest[] = []
    for (const request of requests) {
      if (await this.ownedSession(session.nativeSessionId, request.sessionID, state, signal)) owned.push(request)
    }
    const current = new Set(owned.map((item) => item.id))
    for (const id of state.pendingIds) if (!current.has(id)) state.pendingIds.delete(id)
    return owned
  }

  private autoReplyPending(session: NativeSessionReference, signal: AbortSignal) {
    const state = this.requireSession(session)
    return state.autoReplies.consume(
      (current) => this.ownedPermissions(session, current),
      async (request, current) => {
        await this.mutate(withDirectory(`/permission/${encodeURIComponent(request.id)}/reply`, state.directory), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'once' }),
        }, current)
      }, signal,
    )
  }

  private async pendingReady(session: NativeSessionReference, signal: AbortSignal, handleAuto = true): Promise<PendingNativeInteraction[]> {
    const state = this.requireSession(session)
    if (handleAuto && usesOpenCodeNativeAuto(state.configuration) && !state.autoReplies.stopped) {
      // Reconnect/history use the same authoritative queue as SSE. Only actual
      // owned asks are answered; native allow/deny policy is never changed.
      await this.autoReplyPending(session, signal)
      return []
    }
    const pending: PendingNativeInteraction[] = []
    for (const request of await this.ownedPermissions(session, signal)) {
      const rootId = state.turn?.messageID ?? (state.recoveryCorrelationId ? nativeMessageId(state.recoveryCorrelationId) : undefined)
      const message = request.tool && rootId && request.sessionID === session.nativeSessionId
        ? await this.message(session.nativeSessionId, request.tool.messageID, state.directory, signal) : undefined
      const nativeTurnId = openCodePermissionTurnId(request,
        rootId ? { nativeSessionId: session.nativeSessionId, nativeTurnId: rootId } : undefined, message)
      pending.push(PendingNativeInteractionSchema.parse({ session,
        turn: { nativeTurnId, nativeRequestId: request.id }, nativeRequestType: 'permission.asked',
        request, responseOptions: optionsForRequest(request.id),
      }))
    }
    return pending
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    const combined = this.signal(signal)
    await this.exclusive(async () => {
      await this.ready(combined)
      const state = this.requireSession(session)
      if (usesOpenCodeNativeAuto(state.configuration)) throw new OpenCodeNativeDeliveryError(
        'OPENCODE_NATIVE_AUTO_RESPONSE_CONFLICT', 'Native automatic handling cannot also accept a routed response.', 'definite',
      )
      if (state.responsesUncertain.has(nativeRequestId)) throw new OpenCodeNativeDeliveryError(
        'OPENCODE_PERMISSION_DELIVERY_UNCERTAIN', 'The prior native response remains unresolved; it was not retransmitted.', 'uncertain')
      const pending = await this.pendingReady(session, combined)
      const request = pending.find((item) => item.turn.nativeRequestId === nativeRequestId)
      if (!request) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_NOT_PENDING', 'That permission request is no longer pending in an owned session.', 'definite')
      const expected = optionsForRequest(nativeRequestId).find((item) => item.optionId === option.optionId)
      if (!expected || !isDeepStrictEqual(expected, option)) {
        throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_OPTION_INVALID', 'The response option is not valid for this exact native request.', 'definite')
      }
      const reply = option.semantic === 'approve_once' ? 'once' : option.semantic === 'provider_scoped_allow' ? 'always' : option.semantic === 'reject' ? 'reject' : undefined
      if (!reply) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_SEMANTIC_UNSUPPORTED', 'The selected response cannot be represented by OpenCode V1.', 'definite')
      // Subscribe before dispatch so an exact provider reply event can recover
      // a lost HTTP acknowledgement. Observation is bounded and never retransmits.
      const observer = new AbortController()
      const observedSignal = AbortSignal.any([combined, observer.signal, AbortSignal.timeout(5_000)])
      let events: Response | undefined
      let acknowledged = false
      let dispatchAttempted = false
      let observing: Promise<void> = Promise.resolve()
      const acknowledge = () => {
        const receipt: NativeResponseDeliveryEvidence = {
          source: 'provider_acknowledgement', harness: session.harness, providerVersion: session.providerVersion,
          nativeSessionId: session.nativeSessionId, nativeRequestId, nativeRequestType: request.nativeRequestType,
          optionId: expected.optionId, semantic: expected.semantic,
        }
        // Persist before resolving respond(), evicting a cache entry, or committing a caller transaction.
        // A journal failure is an uncertain outcome; it never authorizes another native send.
        try { this.options.responseJournal?.record(receipt) }
        catch (error) {
          throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_JOURNAL_UNCERTAIN',
            'The exact native reply was acknowledged but its durable journal could not be committed.', 'uncertain', { cause: error })
        }
        boundedMapSet(this.responseReceipts, JSON.stringify([session.nativeSessionId, nativeRequestId]), receipt)
        acknowledged = true
      }
      state.responsesInFlight.add(nativeRequestId)
      try {
        try {
          events = await this.openEvents(state.directory, observedSignal, false)
          const stream = events.body!
          observing = (async () => {
            let count = 0
            for await (const event of parseOpenCodeSse(stream, observedSignal)) {
              if (isOpenCodeReplyAcknowledgement(event, String(object(request.request).sessionID), nativeRequestId, reply)) {
                acknowledge()
                return
              }
              if (++count >= 1_024) return
            }
          })().catch(() => undefined)
        } catch { /* A successful exact HTTP reply remains usable without SSE. */ }
        combined.throwIfAborted()
        try {
          dispatchAttempted = true
          const result = await this.mutate(withDirectory(`/permission/${encodeURIComponent(nativeRequestId)}/reply`, state.directory), {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply }),
          }, combined)
          if (result !== true) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_ACK_INVALID',
            'The provider did not return its qualified response acknowledgement.', 'uncertain')
          acknowledge()
        } catch (error) {
          if (!(error instanceof OpenCodeNativeDeliveryError) || error.certainty !== 'uncertain') throw error
          await observing
          if (!acknowledged) throw error
        }
        // Retain acknowledgement BEFORE any secondary read or caller database commit.
        // A failed pending-list refresh is not a failed native send.
      } catch (error) {
        if (dispatchAttempted && !acknowledged
          && !(error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite')) state.responsesUncertain.add(nativeRequestId)
        throw error
      } finally {
        state.responsesInFlight.delete(nativeRequestId)
        observer.abort()
        await observing
        await events?.body?.cancel().catch(() => undefined)
      }
    })
  }

  /** Local quiescence only: no native write, cancellation receipt, or terminal evidence. */
  stopAutomaticResponses(session: NativeSessionReference): void {
    this.requireSession(session).autoReplies.stop()
  }

  cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string): Promise<boolean> {
    const state = this.sessions.get(session.nativeSessionId)
    if (session.harness === 'opencode' && harnessProfile('opencode', session.providerVersion) === 'opencode-1.18.31'
      && state && (!nativeTurnId || state.turn?.messageID === nativeTurnId)) {
      state.autoReplies.stop()
      state.admissionPending?.abort(new Error('OpenCode turn admission canceled.'))
      if (!state.turn?.terminalResult) state.turn?.observerAbort?.abort(new Error('OpenCode turn admission canceled.'))
      // Close facade admission synchronously even while prompt ACK/startup holds the lifecycle.
      // Serialized cancellation retries durable revocation and reports unresolved cleanup.
      void state.turn?.files?.bridge.revoke().catch(() => undefined)
    }
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      await this.ready(combined)
      const state = this.requireSession(session)
      if (nativeTurnId) {
        const correlationId = state.turn?.correlationId ?? state.recoveryCorrelationId
        if (!correlationId || nativeMessageId(correlationId) !== nativeTurnId) return false
        const history = await this.reconcileReady(session, correlationId, combined)
        if (history.nativeTurnId !== nativeTurnId || history.terminalResult) return false
        if (!await this.isLatestUserTurn(session.nativeSessionId, nativeTurnId, state.directory, combined)) return false
      }
      return this.cancelReady(session, combined)
    })
  }

  private async isLatestUserTurn(sessionId: string, messageId: string, directory: string, signal: AbortSignal): Promise<boolean> {
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let count = 0; count < 100; count += 1) {
      const page = await this.messagePage(sessionId, directory, cursor, signal)
      if (page.messages.some((message) => message.info.sessionID !== sessionId)) {
        throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_INVALID', 'History contains a message from another native session.')
      }
      const latestUser = [...page.messages].reverse().find((message) => message.info.role === 'user')
      if (latestUser) return latestUser.info.id === messageId
      if (!page.nextCursor || seen.has(page.nextCursor)) return false
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    }
    return false // Unbounded/incomplete history never authorizes canceling a newer turn.
  }

  private async cancelReady(session: NativeSessionReference, signal: AbortSignal): Promise<boolean> {
    const state = this.requireSession(session)
    const generation = this.generation
    const current = () => {
      signal.throwIfAborted()
      if (generation !== this.generation) throw new OpenCodeNativeDeliveryError('OPENCODE_RECONCILIATION_STALE', 'Native cancellation ownership changed during reconciliation.', 'uncertain')
    }
    state.autoReplies.stop()
    const fileErrors: unknown[] = []
    try { await state.turn?.files?.bridge.revoke() } catch (error) { fileErrors.push(error) }
    const statuses = object(await this.json('/session/status', state.directory, signal))
    const permissions = await this.permissionRequests(state.directory, signal)
    const questions = await this.json('/question', state.directory, signal)
    const questionSessions = Array.isArray(questions) ? questions.flatMap((item) => typeof object(item).sessionID === 'string' ? [String(object(item).sessionID)] : []) : []
    current()
    const targets = new Set([session.nativeSessionId])
    for (const id of [...Object.keys(statuses), ...permissions.map((item) => item.sessionID), ...questionSessions]) {
      if (await this.ownedSession(session.nativeSessionId, id, state, signal)) targets.add(id)
    }
    let accepted = true
    // Abort descendants too, rather than assuming aborting the task parent clears them.
    for (const id of [...targets].reverse()) {
      current()
      const result = await this.mutate(withDirectory(`/session/${encodeURIComponent(id)}/abort`, state.directory), { method: 'POST' }, signal)
      current()
      if (result !== true) accepted = false
    }
    const rejected = new Set<string>()
    for (const request of await this.permissionRequests(state.directory, signal)) {
      if (rejected.has(request.sessionID) || !(await this.ownedSession(session.nativeSessionId, request.sessionID, state, signal))) continue
      current()
      await this.mutate(withDirectory(`/permission/${encodeURIComponent(request.id)}/reply`, state.directory), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'reject' }),
      }, signal)
      rejected.add(request.sessionID)
    }
    await this.rejectQuestions(session, signal)
    const remaining = await this.pendingReady(session, signal, false)
    const after = object(await this.json('/session/status', state.directory, signal))
    for (const id of Object.keys(after)) {
      if (object(after[id]).type !== 'idle' && await this.ownedSession(session.nativeSessionId, id, state, signal)) accepted = false
    }
    current()
    if (remaining.length) accepted = false
    if (accepted && state.turn) {
      state.turn.terminalResult = { outcome: 'canceled' }
      try { await this.finishFiles(state.turn, 'terminal') } catch (error) { fileErrors.push(error) }
    }
    if (fileErrors.length) throw new AggregateError(fileErrors, 'Native cancellation requires file cleanup retry.')
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
      responseDeliveries: this.receipts(session),
      ...(pendingInteractions[0] ? { pendingInteraction: pendingInteractions[0] } : {}),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      // A general history page has no requested turn identity. Do not invent a terminal result.
    }
  }

  subagentControl(child: RunSubagent, assertOwner: () => void): SubagentControlLease | undefined {
    // Workflow allocations own one root. Never guess among shared sessions or
    // advertise active-turn steering for OpenCode's session-wide prompt API.
    if (child.provider !== 'opencode' || child.nativeMode !== 'opencode-task' || this.sessions.size !== 1
      || child.parentAgentId !== this.options.ownerAgentId || child.profile.providerVersion !== this.healthVersion
      || !['pending', 'running', 'waiting', 'completed'].includes(child.status) || !child.native.childSessionId) return undefined
    const [root, state] = [...this.sessions.entries()][0]!
    const target = child.native.childSessionId, generation = this.generation
    const idle = ['waiting', 'completed'].includes(child.status)
    if (target === root) return undefined
    const signal = this.signal(AbortSignal.timeout(10000))
    const current = () => {
      assertOwner(); this.lifetime.signal.throwIfAborted()
      if (this.sessions.get(root) !== state || this.generation !== generation || this.readyGeneration !== generation) {
        throw new OpenCodeNativeDeliveryError('SUBAGENT_OWNER_STALE', 'The exact child control owner changed.', 'uncertain')
      }
    }
    const ancestry = async () => {
      let id = target
      const visited = new Set<string>()
      while (id !== root && visited.size < 32 && !visited.has(id)) {
        current(); visited.add(id)
        const info = object(await this.json(`/session/${encodeURIComponent(id)}`, state.directory, signal))
        current()
        if (info.id !== id || info.directory !== state.directory || typeof info.parentID !== 'string'
          || id === target && info.parentID !== child.native.parentSessionId) break
        id = info.parentID
      }
      if (id !== root) throw new HarnessExecutionError('SUBAGENT_ANCESTRY_INVALID', 'The exact admitted parent does not own this child.')
    }
    const checkReceipt = (receipt: RunSubagentCommandReceipt) => {
      current()
      if (receipt.subagentId !== child.id || receipt.runId !== child.runId || receipt.workspaceId !== child.workspaceId
        || receipt.nativeTurnId !== null || receipt.operation !== 'run_subagent_input_v1') {
        throw new HarnessExecutionError('SUBAGENT_COMMAND_IDENTITY_INVALID', 'The receipt does not address this idle child.')
      }
    }
    return {
      generation: `${state.connectionId}:${generation}`, nativeTurnId: idle ? null : child.native.currentTurnId ?? null,
      matches: other => {
        try { current(); return other.id === child.id && other.parentExecutionId === child.parentExecutionId
          && other.parentAttemptKey === child.parentAttemptKey && isDeepStrictEqual(other.native, child.native)
          && isDeepStrictEqual(other.profile, child.profile) && ['pending', 'running', 'waiting', 'completed'].includes(other.status) }
        catch { return false }
      },
      assertCurrent: current,
      ...(idle ? { sendInput: (receipt: RunSubagentCommandReceipt, text: string) => this.exclusive(async () => {
        try {
          checkReceipt(receipt); signal.throwIfAborted()
          await ancestry()
          if (await this.sessionStatus(target, state.directory, signal) !== 'idle') throw new SubagentDispatchRejectedError()
          current()
        } catch { throw new SubagentDispatchRejectedError() }
        if (this.childCommandAttempts.has(receipt.id) || this.childCommandAttempts.size >= 4096) {
          throw new HarnessExecutionError('SUBAGENT_COMMAND_NOT_REPLAYABLE', 'The command cannot be dispatched again.')
        }
        this.childCommandAttempts.add(receipt.id)
        // Preserve the child's native agent/model/system defaults. Do not
        // overwrite them with the parent's configuration or adopt its turn.
        try {
          await this.mutate(withDirectory(`/session/${encodeURIComponent(target)}/prompt_async`, state.directory), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageID: receipt.nativeCorrelationId, parts: [{ type: 'text', text }] }),
          }, signal)
        } catch (error) {
          if (error instanceof OpenCodeNativeDeliveryError && error.certainty === 'definite') throw new SubagentDispatchRejectedError()
          throw error
        }
        current()
      }) } : {}),
      reconcile: async receipt => {
        checkReceipt(receipt); signal.throwIfAborted(); await ancestry()
        const message = await this.message(target, receipt.nativeCorrelationId, state.directory, signal)
        current()
        return message?.info.role === 'user' ? 'acknowledged' : 'uncertain'
      },
    }
  }

  async subagentHistory(session: NativeSessionReference, cursor?: string, signal?: AbortSignal) {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    const state = this.requireSession(session), generation = this.generation
    const current = () => {
      combined.throwIfAborted()
      if (this.generation !== generation || this.sessions.get(session.nativeSessionId) !== state) throw new OpenCodeNativeDeliveryError('SUBAGENT_HISTORY_OWNER_STALE', 'The exact native history owner changed.', 'uncertain')
    }
    const page = childHistoryCursor(session.nativeSessionId, cursor)
    const queue = [session.nativeSessionId], children = new Map<string, JsonObject>()
    const events: NativeHarnessEvent[] = []
    for (let index = 0; index < queue.length; index++) {
      if (queue.length > 32) throw new HarnessExecutionError('SUBAGENT_HISTORY_LIMIT', 'The bounded native descendant tree is full.')
      const parent = queue[index]!
      const response = await this.json(`/session/${encodeURIComponent(parent)}/children`, state.directory, combined)
      current()
      if (!Array.isArray(response) || response.length > 32) throw new HarnessExecutionError('SUBAGENT_HISTORY_INVALID', 'Invalid bounded child roster.')
      for (const raw of response) {
        const child = object(raw)
        if (typeof child.id !== 'string' || child.parentID !== parent || child.directory !== state.directory || child.id === parent || children.has(child.id)) {
          throw new HarnessExecutionError('SUBAGENT_ANCESTRY_INVALID', 'Child roster does not prove exact ancestry and directory.')
        }
        children.set(child.id, child); queue.push(child.id)
        events.push(childHistoryEvent('session.created', { info: child }))
      }
    }
    const ids = [...children.keys()].sort()
    const target = page.target === session.nativeSessionId ? ids[0] : page.target
    if (!target) return { events, nextCursor: null }
    if (!children.has(target) || !await this.ownedSession(session.nativeSessionId, target, state, combined)) throw new HarnessExecutionError('SUBAGENT_ANCESTRY_INVALID', 'Requested child is not owned by its exact parent.')
    current()
    const messages = await this.messagePage(target, state.directory, page.cursor ?? undefined, combined)
    current()
    for (const event of normalizedHistory(messages.messages, false)) {
      const id = eventSessionId({ type: event.type, properties: event.payload })
      if (id !== target) throw new HarnessExecutionError('SUBAGENT_HISTORY_INVALID', 'Child history returned another native session.')
      events.push(childHistoryEvent(event.type, { ...event.payload, subagentNativeId: target }, event.occurredAt))
    }
    const next = ids.find(id => id > target)
    return { events, nextCursor: messages.nextCursor ? encodeChildHistoryCursor({ root: page.root, target, cursor: messages.nextCursor })
      : next ? encodeChildHistoryCursor({ root: page.root, target: next, cursor: null }) : null }
  }

  async reconcileResponse(
    session: NativeSessionReference,
    response: import('./port.js').NativeResponseIdentity,
    signal?: AbortSignal,
  ): Promise<NativeHistory> {
    this.validateReference(session)
    signal?.throwIfAborted()
    const durable = this.options.responseJournal?.read(session, response)
    if (durable) return { events: [], pendingInteractions: [], responseDeliveries: [durable] }
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    this.requireSession(session)
    const pendingInteractions = await this.pendingReady(session, combined)
    const receipt = this.responseReceipts.get(JSON.stringify([session.nativeSessionId, response.nativeRequestId]))
    return { events: [], pendingInteractions,
      responseDeliveries: receipt && receipt.providerVersion === session.providerVersion
        && receipt.nativeRequestType === response.nativeRequestType
        && receipt.optionId === response.option.optionId && receipt.semantic === response.option.semantic
        ? [structuredClone(receipt)] : [],
    }
  }

  private receipts(session: NativeSessionReference): NativeResponseDeliveryEvidence[] {
    return [...this.responseReceipts.values()].filter((receipt) => receipt.nativeSessionId === session.nativeSessionId
      && receipt.providerVersion === session.providerVersion).map((receipt) => structuredClone(receipt))
  }

  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
    const combined = this.signal(signal)
    await this.exclusive(() => this.ready(combined))
    return this.reconcileReady(session, correlationId, combined)
  }

  private async reconcileReady(session: NativeSessionReference, correlationId: string, signal: AbortSignal): Promise<NativeHistory> {
    const state = this.requireSession(session)
    const generation = this.generation
    const assertCurrent = () => {
      signal.throwIfAborted()
      if (generation !== this.generation || this.requireSession(session) !== state) {
        throw new OpenCodeNativeDeliveryError('OPENCODE_RECONCILIATION_STALE', 'The native generation changed during history reconciliation.', 'uncertain')
      }
    }
    assertCurrent()
    let turn = state.turn?.correlationId === correlationId ? state.turn : undefined
    const rejectedQuestion = await this.rejectQuestions(session, signal)
    assertCurrent()
    const questionFailure = rejectedQuestion
      ? failure('OPENCODE_QUESTION_UNSUPPORTED', 'An owned native question was rejected because this transport supports approvals, not interactive questions.')
      : undefined
    if (questionFailure) {
      if (turn) turn.questionFailure = questionFailure
      const canceled = await this.cancelReady(session, signal)
      assertCurrent()
      if (turn && canceled) turn.terminalResult = questionFailure
    }
    const messageID = nativeMessageId(correlationId)
    const statusBefore = await this.ownedStatus(session, state, signal)
    assertCurrent()
    const root = await this.message(session.nativeSessionId, messageID, state.directory, signal)
    assertCurrent()
    const page = await this.messagePage(session.nativeSessionId, state.directory, undefined, signal)
    assertCurrent()
    const pendingInteractions = await this.pendingReady(session, signal)
    assertCurrent()
    if (!turn && root?.info.role === 'user') {
      if (state.turn && !state.turn.terminalResult) {
        throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'A different owned turn is still active; recovery cannot replace it.')
      }
      turn = {
        correlationId, messageID, promptHash: undefined, submitted: true, observing: false,
        // A recovered idle prompt without a final answer is interrupted, not a new submission.
        generation: this.generation - 1, submittedAt: 0, idleObserved: false,
        scopedError: undefined, terminalResult: undefined,
      }
      state.turn = turn
    }
    if (turn && questionFailure) turn.questionFailure = questionFailure
    const result: NativeHistory = { correlationId, nativeTurnId: messageID, responseDeliveries: this.receipts(session),
      events: normalizedHistory(page.messages, state.configuration.thinking), pendingInteractions,
      ...(pendingInteractions[0] ? { pendingInteraction: pendingInteractions[0] } : {}),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }
    if (turn?.terminalResult) {
      await this.finishFiles(turn, 'terminal')
      return historyWithOwnedTerminal(result, turn, this.generation)
    }
    if (!root) {
      if (!turn?.submitted) throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_MISSING', 'The requested turn could not be identified in native history; older answers are not substitutes.')
    } else if (root.info.role !== 'user') {
      throw new HarnessExecutionError('OPENCODE_TURN_IDENTITY_INVALID', 'The correlated native message is not a user prompt.')
    }
    let terminalResult: NativeHistory['terminalResult']
    let terminalMessage: OpenCodeMessage | undefined
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
    assertCurrent()
      }
      if (!history.rooted) throw new HarnessExecutionError('OPENCODE_TURN_HISTORY_INCOMPLETE', 'Native history did not include the correlated prompt; no older result was selected.')
      terminalResult = history.result
      terminalMessage = history.resultMessage
      if (history.resultMessageId) {
        result.nativeMessageId = history.resultMessageId
      }
    }
    if (root && turn?.files?.bridge.needsAcknowledgement && turn.generation === this.generation && !terminalResult) {
      await turn.files.bridge.acknowledge(signal)
    }
    const statusAfter = await this.ownedStatus(session, state, signal)
    assertCurrent()
    if (statusBefore !== 'idle' || statusAfter !== 'idle' || pendingInteractions.length
      || (usesOpenCodeNativeAuto(state.configuration) && !state.autoReplies.stopped && state.autoReplies.hasPending)) return result
    // Another observation may have finished while this scan awaited provider I/O.
    // Reuse its complete result/source pair; do not mint a competing receipt.
    if (turn?.terminalResult) {
      await this.finishFiles(turn, 'terminal')
      return historyWithOwnedTerminal(result, turn, this.generation)
    }
    if (turn?.questionFailure) {
      terminalResult = turn.questionFailure
      terminalMessage = undefined
      delete result.nativeMessageId
    }
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
      if (turn) {
        turn.terminalResult = terminalResult
        if (result.nativeMessageId !== undefined) turn.nativeMessageId = result.nativeMessageId
        else delete turn.nativeMessageId
      }
      // Only the actual rooted scan above, after both idle checks and the pending
      // checks, may produce this observation. Generic interrupted/error fallbacks
      // have no selected assistant and must NOT acknowledge Worker continuation.
      if (terminalMessage && turn?.generation === this.generation
        && ['succeeded', 'failed'].includes(terminalResult.outcome)) {
        const source = normalizedHistory([terminalMessage], state.configuration.thinking)[0]!
        const payload = openCodeReconciliationPayload(session, this.options.ownerAgentId,
          correlationId, messageID, source, terminalResult.outcome as 'succeeded' | 'failed')
        if (payload) {
          const marker = this.recordSynthetic(state, OPENCODE_RECONCILIATION_EVENT, payload)
          // The selected answer may be on an older page (e.g. native compaction).
          // Preserve its original source ID, then append the distinct observation.
          const events = [source, marker]
          if (turn) turn.reconciliationEvents = events
          result.events = [...result.events, ...events.filter((event) => !result.events.some(
            (raw) => raw.connectionId === event.connectionId && raw.sequence === event.sequence))]
        }
      }
      result.terminalResult = terminalResult
      result.terminalTurn = { correlationId, providerId: messageID, result: terminalResult }
      if (turn) await this.finishFiles(turn, 'terminal')
    }
    return result
  }

  close(session: NativeSessionReference): Promise<void> {
    return this.closeOwnedSession(session, false)
  }

  /** A process restart preserves the durable native turn for reconciliation.
   * Stop and ordinary cleanup still use close(), which rejects unresolved work. */
  closeForRestart(session: NativeSessionReference): Promise<void> {
    return this.closeOwnedSession(session, true)
  }

  private closeOwnedSession(session: NativeSessionReference, restart: boolean): Promise<void> {
    return this.exclusive(async () => {
      this.validateReference(session)
      const closed = this.restartClosures.get(session.nativeSessionId)
      if (restart && closed) {
        if (!isDeepStrictEqual(closed, session)) {
          throw new HarnessExecutionError('OPENCODE_SESSION_CONTEXT_MISSING', 'The restart closure belongs to another native session identity.')
        }
        return
      }
      const state = this.requireSession(session)
      if (!restart && (state.turn?.observing || (state.turn?.submitted && !state.turn.terminalResult))) {
        throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'Cancel or reconcile this native turn before closing its session.')
      }
      if (restart && state.turn?.files && this.sessions.size !== 1) {
        throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'File input cleanup requires closing its dedicated native process.')
      }
      if (this.sessions.size === 1) {
        await this.disposeUnusedServer()
        await state.turn?.files?.nativeProcessClosed(AbortSignal.timeout(10_000))
      } else if (state.turn?.files) await this.finishFiles(state.turn, 'terminal')
      if (restart) this.restartClosures.set(session.nativeSessionId, structuredClone(session))
      this.sessions.delete(session.nativeSessionId)
    })
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    // Synchronously invalidate queued setup and observers, then drain the owner lifecycle.
    this.lifetime.abort(new Error('OpenCode session manager disposed.'))
    // Close facade admission synchronously and attempt revoke independently of a
    // failed native-process stop. A shutdown failure must not leave live tools.
    const revoking = Promise.allSettled([...this.sessions.values()].flatMap((state) =>
      state.turn?.files ? [state.turn.files.bridge.revoke()] : []))
    const stopping = this.options.server.dispose()
    void stopping.catch(() => undefined)
    const attempt = this.exclusive(async () => {
      const revoked = await revoking
      const errors: unknown[] = revoked.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      try { await stopping } catch (error) {
        errors.push(error)
        if (!this.options.chatFiles && errors.length === 1) throw error
        throw new AggregateError(errors, `Native process shutdown and file revocation require retry: ${String(error)}`, { cause: error })
      }
      for (const state of this.sessions.values()) {
        try { await state.turn?.files?.nativeProcessClosed(AbortSignal.timeout(10_000)) } catch (error) { errors.push(error) }
      }
      // Keep failed cleanup reachable for a subsequent dispose attempt.
      if (errors.length) throw new AggregateError(errors, 'Disposed native manager still requires file cleanup.')
      this.sessions.clear()
      this.boundEnvironmentFingerprint = undefined
      this.readyGeneration = undefined
      this.healthVersion = undefined
      this.knownSecrets.clear()
      this.responseReceipts.clear()
    })
    this.disposal = attempt
    void attempt.catch(() => { if (this.disposal === attempt) this.disposal = undefined })
    return attempt
  }

  restartForCredential(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void> {
    const combined = this.signal(signal)
    return this.exclusive(async () => {
      if (this.options.appMcpAccess === 'none' && Object.keys(environment.variables).length) {
        throw new HarnessExecutionError('OPENCODE_APP_MCP_UNAVAILABLE', 'Agent chat cannot receive scoped App MCP credentials.')
      }
      if (environment.agentId !== this.options.ownerAgentId) throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The replacement credential belongs to another Agent.')
      if ([...this.sessions.values()].some((state) => state.turn && !state.turn.terminalResult)) {
        throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_BUSY', 'Credential renewal requires all owned turns to be reconciled idle.')
      }
      // Reattached/native work can exist without an in-memory turn marker.
      for (const [id, state] of this.sessions) {
        if (await this.sessionStatus(id, state.directory, combined) !== 'idle') throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_BUSY', 'A persisted native session is still active.')
      }
      if (!this.options.server.restart) throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_UNSUPPORTED', 'This controller cannot replace its credential context.')
      Object.values(environment.variables).forEach((value) => this.knownSecrets.add(value))
      try {
        await this.options.server.restart(environment, combined)
        this.boundEnvironmentFingerprint = childEnvironmentFingerprint(environment)
      } finally {
        // A failed restart can still bind validated desired credentials.
        this.boundEnvironmentFingerprint = this.options.server.credentialEnvironmentFingerprint ?? this.boundEnvironmentFingerprint
        this.readyGeneration = undefined
        this.healthVersion = undefined
      }
      await this.ready(combined)
    })
  }

  private async bindEnvironment(environment: ChildProcessEnvironment | undefined, signal: AbortSignal): Promise<void> {
    if (this.options.appMcpAccess === 'none' && Object.keys(environment?.variables ?? {}).length) {
      throw new HarnessExecutionError('OPENCODE_APP_MCP_UNAVAILABLE', 'Agent chat cannot receive scoped App MCP credentials.')
    }
    // An explicitly configured owner-scoped controller is already a validated binding.
    if (!environment && this.boundEnvironmentFingerprint && this.options.server.credentialEnvironmentFingerprint === this.boundEnvironmentFingerprint) return
    const selected = environment ?? { agentId: this.options.ownerAgentId, variables: {} }
    if (selected.agentId !== this.options.ownerAgentId) throw new HarnessExecutionError('OPENCODE_SESSION_OWNER_MISMATCH', 'The session credential belongs to another Agent.')
    const credentialEnvironmentVariable = this.options.credentialEnvironmentVariable ?? APP_MCP_TOKEN
    const keys = Object.keys(selected.variables)
    const appCredential = isSupportedAppMcpTokenName(credentialEnvironmentVariable)
    if (keys.length > 1 || keys.some((key) => appCredential ? !isSupportedAppMcpTokenName(key) : key !== credentialEnvironmentVariable)
      || keys.some((key) => !selected.variables[key])) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_ENV_UNSUPPORTED', 'Only the scoped App credential can be bound.')
    }
    if (appCredential) readProductEnvironment(selected.variables, 'MCP_TOKEN')
    Object.values(selected.variables).forEach((value) => this.knownSecrets.add(value))
    const fingerprint = childEnvironmentFingerprint(selected)
    if (this.boundEnvironmentFingerprint === fingerprint) return
    if (this.boundEnvironmentFingerprint) throw new HarnessExecutionError('OPENCODE_CREDENTIAL_CONTEXT_MISMATCH', 'Use explicit idle renewal to change this manager credential context.')
    if (environment) {
      if (!this.options.server.restart) throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_UNSUPPORTED', 'This controller cannot bind the scoped App credential.')
      await this.options.server.restart(selected, signal)
      this.readyGeneration = undefined
      this.healthVersion = undefined
    }
    this.boundEnvironmentFingerprint = fingerprint
  }

  /** Same qualified server and settings as execution, without creating a native session. */
  async qualifyConfiguration(value: OpenCodeHarnessConfiguration, directory: string, signal?: AbortSignal) {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    const parsed = OpenCodeHarnessConfigurationSchema.safeParse(value)
    if (!parsed.success) throw new HarnessExecutionError('OPENCODE_CONFIGURATION_INVALID', 'The accepted OpenCode settings are invalid or contain conflicting permission modes.')
    await this.ready(combined)
    const providers = object(await this.assertConfiguration(parsed.data, directory, combined))
    const providerId = parsed.data.model.split('/')[0]
    if (!Array.isArray(providers.connected) || !providers.connected.includes(providerId)) {
      throw new HarnessExecutionError('OPENCODE_AUTH_REQUIRED', 'The selected native provider is not connected. Configure its credentials before saving these defaults.')
    }
    return nativeQualification(parsed.data, this.providerVersion)
  }

  private async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.options.server.ensure(signal)
    if (harnessProfile('opencode', this.options.server.expectedVersion) === null) throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'OpenCode native mode requires a qualified version.')
    if (this.readyGeneration === this.generation) return
    const generation = this.generation
    const health = object(await this.json('/global/health', undefined, signal))
    const document = object(await this.json('/doc', undefined, signal))
    if (health.healthy !== true || typeof health.version !== 'string'
      || harnessProfile('opencode', health.version) === null || health.version !== this.options.server.expectedVersion) {
      throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'Live OpenCode health/version did not match the qualified server.')
    }
    const paths = object(document.paths)
    for (const path of ['/session', '/session/status', '/session/{sessionID}', '/session/{sessionID}/message',
      '/session/{sessionID}/message/{messageID}', '/session/{sessionID}/prompt_async', '/session/{sessionID}/abort',
      '/permission', '/permission/{requestID}/reply', '/question', '/question/{requestID}/reject', '/event', '/config', '/mcp']) {
      if (!(path in paths)) throw new HarnessExecutionError('OPENCODE_SERVER_SCHEMA_UNQUALIFIED', `The live OpenCode schema is missing ${path}.`)
    }
    for (const state of this.sessions.values()) {
      if (state.turn?.files && state.turn.generation !== generation) {
        await state.turn.files.nativeProcessClosed(AbortSignal.timeout(10_000))
        delete state.turn.files
      }
    }
    // MCP controls are directory-instance state, so restore once per retained directory.
    const restored = new Set<string>()
    for (const state of this.sessions.values()) {
      if (restored.has(state.directory)) continue
      await this.applyMcpControls(state.configuration, state.directory, signal)
      restored.add(state.directory)
    }
    if (generation !== this.generation) throw new OpenCodeNativeDeliveryError('OPENCODE_SERVER_GENERATION_CHANGED', 'OpenCode changed again while restoring native settings.', 'definite')
    this.healthVersion = health.version
    this.readyGeneration = generation
  }

  private async assertConfiguration(configuration: OpenCodeHarnessConfiguration, directory: string, signal: AbortSignal): Promise<unknown> {
    await this.assertChatMcpDisabled(directory, signal)
    const boundNames = (configuration.advanced?.permissionRules ?? []).flatMap((rule) => {
      if (/^graphql[-_]files(?:[-_]|$)/.test(rule.permission)) return []
      const name = APP_MCP_SERVER_NAMES.find((candidate) => rule.permission === candidate
        || rule.permission.startsWith(`${candidate}_`) || rule.permission.startsWith(`${candidate}*`))
      return name ? [name] : []
    })
    if (this.options.appMcpAccess !== 'none' && boundNames.length) {
      const configured = object(object(await this.json('/config', directory, signal)).mcp)
      const installedName = appMcpServerName(configured)
      if (Object.hasOwn(configured, installedName) && boundNames.some((name) => name !== installedName)) {
        throw new HarnessExecutionError('OPENCODE_MCP_PERMISSION_REVIEW_REQUIRED',
          'Saved MCP permission rules use another supported app name. Review the Agent or Operator settings before starting with the renamed connection.')
      }
    }
    if (this.options.server instanceof ManagedOpenCodeServer && !isDeepStrictEqual(configuration.advanced, this.options.server.advancedConfiguration)) {
      throw new HarnessExecutionError('OPENCODE_SERVER_CONFIGURATION_MISMATCH', 'Process-level Advanced settings differ from the pinned session configuration.')
    }
    for (const state of this.sessions.values()) {
      if (state.directory === directory && !isDeepStrictEqual(state.configuration.advanced?.mcp.serverEnabled ?? {}, configuration.advanced?.mcp.serverEnabled ?? {})) {
        throw new HarnessExecutionError('OPENCODE_MCP_CONTEXT_CONFLICT', 'Sessions in one native directory instance cannot select conflicting MCP controls.')
      }
      if (state.directory === directory && !isDeepStrictEqual(nativePolicy(state.configuration), nativePolicy(configuration))) {
        throw new HarnessExecutionError('OPENCODE_PERMISSION_CONTEXT_CONFLICT', 'Sessions in one native directory instance cannot share different permission lifetimes.')
      }
    }
    const [providerID, ...model] = configuration.model.split('/')
    if (!providerID || !model.join('/')) throw new HarnessExecutionError('OPENCODE_MODEL_INVALID', 'OpenCode models require provider/model format.')
    const [providers, agents] = await Promise.all([this.json('/provider', directory, signal), this.json('/agent', directory, signal)])
    if (!providerSupports(providers, providerID, model.join('/'), configuration.variant)) throw new HarnessExecutionError('OPENCODE_MODEL_UNAVAILABLE', 'The selected OpenCode model or named variant is not advertised.')
    if (!Array.isArray(agents) || !agents.some((agent) => object(agent).name === configuration.nativeAgent)) throw new HarnessExecutionError('OPENCODE_NATIVE_AGENT_UNAVAILABLE', 'The selected native Agent is unavailable.')
    return providers
  }

  private async applyMcpControls(configuration: OpenCodeHarnessConfiguration, directory: string, signal: AbortSignal): Promise<void> {
    await this.assertChatMcpDisabled(directory, signal)
    const controls = configuration.advanced?.mcp.serverEnabled ?? {}
    if (!Object.keys(controls).length) return
    const configured = object(object(await this.json('/config', directory, signal)).mcp)
    const appControls = Object.entries(controls).filter(([name]) => isSupportedAppMcpServerName(name))
    if (this.options.appMcpAccess !== 'none' && appControls.some(([, enabled]) => enabled !== appControls[0]?.[1])) throw new HarnessExecutionError(
      'OPENCODE_MCP_CONTROL_CONFLICT', 'Supported app MCP names have conflicting enable settings.')
    for (const [configuredName, enabled] of Object.entries(controls)) {
      // The accepted switch is retained, but cannot reconnect workflow tools in chat.
      if (this.options.appMcpAccess === 'none'
        && chatExcludedAppMcpServerNames(this.options.appMcpServerName ?? APP_MCP_SERVER_NAME).includes(configuredName)) continue
      const name = appMcpServerName(configured, configuredName)
      if (!Object.hasOwn(configured, name)) throw new HarnessExecutionError('OPENCODE_MCP_SERVER_NOT_CONFIGURED', `MCP server '${name}' is not in resolved configuration.`)
      const before = object(object(await this.json('/mcp', directory, signal))[name]).status
      const expected = enabled ? 'connected' : 'disabled'
      if (before !== expected) await this.mutate(withDirectory(`/mcp/${encodeURIComponent(name)}/${enabled ? 'connect' : 'disconnect'}`, directory), { method: 'POST' }, signal, false)
      const after = object(object(await this.json('/mcp', directory, signal))[name]).status
      if (after !== expected) throw new HarnessExecutionError('OPENCODE_MCP_CONTROL_NOT_APPLIED', `MCP server '${name}' did not reach the accepted ${expected} state.`)
    }
  }

  private async assertChatMcpDisabled(directory: string, signal: AbortSignal): Promise<void> {
    if (this.options.appMcpAccess !== 'none') return
    assertOpenCodeChatMcpDisabled(await this.json('/config', directory, signal), await this.json('/mcp', directory, signal),
      this.options.appMcpServerName ?? APP_MCP_SERVER_NAME)
  }

  private verifyAttachedSession(native: JsonObject, id: string, directory: string, configuration: OpenCodeHarnessConfiguration): void {
    if (native.id !== id) throw new HarnessExecutionError('OPENCODE_SESSION_ID_MISMATCH', 'OpenCode returned a different persisted session identity.')
    if (native.directory !== directory) throw new HarnessExecutionError('OPENCODE_SESSION_DIRECTORY_MISMATCH', 'The persisted session belongs to a different directory.')
    if (!isDeepStrictEqual(native.permission ?? [], nativePolicy(configuration))) throw new HarnessExecutionError('OPENCODE_SESSION_PERMISSION_MISMATCH', 'The complete ordered persisted permission policy differs from the accepted policy. No implicit policy update was performed.')
    if (typeof native.agent === 'string' && native.agent !== configuration.nativeAgent) throw new HarnessExecutionError('OPENCODE_SESSION_CONFIGURATION_MISMATCH', 'The persisted native Agent differs from its pinned configuration.')
    const model = object(native.model)
    const [providerID, ...modelID] = configuration.model.split('/')
    // OpenCode stores its unnamed variant as "default" in session metadata.
    const variant = model.variant === 'default' ? '' : (model.variant ?? '')
    if (Object.keys(model).length && (model.providerID !== providerID || model.id !== modelID.join('/') || variant !== configuration.variant)) {
      throw new HarnessExecutionError('OPENCODE_SESSION_CONFIGURATION_MISMATCH', 'The persisted native model or variant differs from its pinned configuration.')
    }
  }

  private configuration(input: NativeSessionStart): OpenCodeHarnessConfiguration {
    const configuration = input.kind === 'operator' ? input.configuration.harness : input.request.configuration.harness
    if (configuration.harness !== 'opencode') throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'OpenCode received a different harness configuration.')
    const parsed = OpenCodeHarnessConfigurationSchema.safeParse(configuration)
    if (!parsed.success) throw new HarnessExecutionError('OPENCODE_CONFIGURATION_INVALID', 'The accepted OpenCode settings are invalid or contain conflicting permission modes.')
    return structuredClone(parsed.data)
  }
  private validateReference(session: NativeSessionReference): void {
    if (session.harness !== 'opencode' || harnessProfile('opencode', session.providerVersion) === null
      || session.providerVersion !== this.providerVersion) throw new HarnessExecutionError('OPENCODE_SESSION_UNQUALIFIED', 'The persisted native session is not qualified for this manager.')
  }
  private requireSession(session: NativeSessionReference): SessionState {
    this.validateReference(session)
    const state = this.sessions.get(session.nativeSessionId)
    if (!state) throw new HarnessExecutionError('OPENCODE_SESSION_CONTEXT_MISSING', 'The native session working directory and configuration are unavailable.')
    return state
  }

  private async ownedSession(root: string, candidate: string, state: SessionState, signal: AbortSignal): Promise<boolean> {
    const generation = this.generation
    if (candidate === root) return true
    if (state.ownedIds.get(candidate)) return true
    const visited = new Set<string>()
    let id: string | undefined = candidate
    while (id && visited.size < 256 && !visited.has(id)) {
      if (id === root) { boundedMapSet(state.ownedIds, candidate, true); return true }
      visited.add(id)
      const response = await this.clientRequest(withDirectory(`/session/${encodeURIComponent(id)}`, state.directory), { method: 'GET' }, signal, generation)
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return false }
      if (!response.ok) throw await responseError(response, 'OPENCODE_SESSION_LOOKUP_FAILED', response.status >= 500 ? 'uncertain' : 'definite')
      const native = object(await readJson(response))
      signal.throwIfAborted()
      if (generation !== this.generation) throw new OpenCodeNativeDeliveryError('OPENCODE_RECONCILIATION_STALE', 'Native ancestry changed while its response was being read.', 'uncertain')
      if (native.id !== id || native.directory !== state.directory) return false
      id = typeof native.parentID === 'string' ? native.parentID : undefined
    }
    return false
  }

  private async rejectQuestions(session: NativeSessionReference, signal: AbortSignal): Promise<boolean> {
    const state = this.requireSession(session)
    const generation = this.generation
    const current = () => {
      signal.throwIfAborted()
      if (generation !== this.generation) throw new OpenCodeNativeDeliveryError('OPENCODE_RECONCILIATION_STALE', 'Native question ownership changed during reconciliation.', 'uncertain')
    }
    const questions = await this.json('/question', state.directory, signal)
    current()
    if (!Array.isArray(questions)) throw new Error('Invalid native question response.')
    let rejected = false
    for (const value of questions) {
      const question = object(value)
      if (typeof question.id !== 'string' || typeof question.sessionID !== 'string') continue
      if (!(await this.ownedSession(session.nativeSessionId, question.sessionID, state, signal))) continue
      current()
      await this.mutate(withDirectory(`/question/${encodeURIComponent(question.id)}/reject`, state.directory), { method: 'POST' }, signal)
      current()
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

  private async ownedStatus(session: NativeSessionReference, state: SessionState, signal: AbortSignal): Promise<string> {
    const statuses = object(await this.json('/session/status', state.directory, signal))
    for (const [id, value] of Object.entries(statuses)) {
      const status = object(value).type
      if (status === 'idle') continue
      if (await this.ownedSession(session.nativeSessionId, id, state, signal)) {
        if (status !== 'busy' && status !== 'retry') throw new Error('Unknown native session status.')
        return status
      }
    }
    return 'idle'
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
    const response = await this.clientRequest(withDirectory(`/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`, directory), { method: 'GET' }, signal, this.generation)
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return undefined }
    if (!response.ok) throw await responseError(response, 'OPENCODE_MESSAGE_LOOKUP_FAILED', response.status >= 500 ? 'uncertain' : 'definite')
    const message = this.sanitize(object(await readJson(response)))
    if (object(message.info).id !== messageID || object(message.info).sessionID !== sessionID || !Array.isArray(message.parts)) throw new Error('Native message identity did not match the lookup.')
    return message as OpenCodeMessage
  }

  private async messagePage(sessionID: string, directory: string, before: string | undefined, signal: AbortSignal): Promise<MessagePage> {
    const query = `/session/${encodeURIComponent(sessionID)}/message?limit=${OPENCODE_HISTORY_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`
    const response = await this.clientRequest(withDirectory(query, directory), { method: 'GET' }, signal, this.generation)
    if (!response.ok) throw await responseError(response, 'OPENCODE_HISTORY_UNAVAILABLE', response.status >= 500 ? 'uncertain' : 'definite')
    const nextCursor = response.headers.get('x-next-cursor')
    const value = this.sanitize(await readJson(response))
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
    // Provider-controlled SSE cannot impersonate our history-scan observation.
    if (native.type === OPENCODE_RECONCILIATION_EVENT) return undefined
    const key = native.id ?? native.sseId
    if (key && state.eventIds.has(key)) return undefined
    if (key) boundedSetAdd(state.eventIds, key)
    return this.recordSynthetic(state, native.type, { ...object(native.properties), ...(key ? { nativeEventId: key } : {}) })
  }
  private recordSynthetic(state: SessionState, type: string, payload: JsonObject): NativeHarnessEvent {
    payload = this.sanitize(payload)
    const serialized = JSON.stringify(payload)
    const retained = serialized.length > 64_000 ? { nativeEventId: payload.nativeEventId,
      sessionID: payload.sessionID ?? object(payload.part).sessionID, payloadOmitted: true,
      detail: 'Retrieve this large native payload through paginated authoritative history.' } : payload
    const event = NativeHarnessEventSchema.parse({ sequence: state.sequence++, connectionId: state.connectionId, type, occurredAt: new Date().toISOString(), payload: retained })
    state.events.push(event)
    state.eventBytes += JSON.stringify(event).length
    while (state.events.length > OPENCODE_EVENT_LIMIT || state.eventBytes > OPENCODE_EVENT_BYTES) {
      state.eventBytes -= JSON.stringify(state.events.shift()!).length
    }
    return event
  }

  private sanitize<T>(value: T): T {
    const secrets = [...this.knownSecrets]
    if (this.options.server instanceof ManagedOpenCodeServer) {
      return this.options.server.redactWithAdditionalSecrets(value, secrets)
    }
    const safe = redactKnownSecrets(value, secrets)
    return this.options.server.redact ? this.options.server.redact(safe) : safe
  }

  private clientRequest(path: string, init: RequestInit, signal: AbortSignal, generation: number): Promise<Response> {
    const url = new URL(path, 'http://opencode.invalid')
    const directory = url.searchParams.get('directory') ?? ''
    const client = (this.options.clientFactory ?? createOpenCodeBoundFetch)({
      server: this.options.server, ownerAgentId: this.options.ownerAgentId, directory, generation, signal, ownerSignal: this.lifetime.signal,
    })
    return client(url, init)
  }

  private async json(path: string, directory: string | undefined, signal: AbortSignal): Promise<unknown> {
    const response = await this.clientRequest(directory ? withDirectory(path, directory) : path, { method: 'GET' }, signal, this.generation)
    if (!response.ok) throw await responseError(response, response.status === 404 ? 'OPENCODE_SESSION_NOT_FOUND' : 'OPENCODE_SERVER_REQUEST_FAILED', response.status >= 500 ? 'uncertain' : 'definite')
    return response.status === 204 ? undefined : this.sanitize(await readJson(response))
  }

  private async mutate(path: string, init: RequestInit, signal: AbortSignal, requireReady = true, notFoundCode?: string): Promise<unknown> {
    if (signal.aborted) throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_NOT_DISPATCHED', 'The native mutation was canceled before dispatch.', 'definite')
    const generation = (requireReady ? this.readyGeneration : this.generation) ?? this.generation
    let response: Response
    try { response = await this.clientRequest(path, init, signal, generation) }
    catch (error) {
      if (error instanceof OpenCodeNativeDeliveryError) throw error
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The native mutation may have been accepted before the connection failed.', 'uncertain', { cause: error })
    }
    if (!response.ok) throw await responseError(response, response.status === 404 && notFoundCode ? notFoundCode : 'OPENCODE_NATIVE_DELIVERY_REJECTED',
      response.status >= 500 ? 'uncertain' : 'definite')
    try {
      const result = response.status === 204 ? undefined : this.sanitize(await readJson(response, this.lifetime.signal))
      if (generation !== this.generation || this.lifetime.signal.aborted) throw new Error('Native mutation owner changed during response read.')
      return result
    }
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
    const revoking = Promise.allSettled([...this.sessions.values()].flatMap((state) =>
      state.turn?.files ? [state.turn.files.bridge.revoke()] : []))
    const errors: unknown[] = []
    try { await this.options.server.dispose() } catch (error) { errors.push(error) }
    const revoked = await revoking
    errors.push(...revoked.flatMap((result) => result.status === 'rejected' ? [result.reason] : []))
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Native process closure and file revocation require retry.')
    this.boundEnvironmentFingerprint = undefined
    this.readyGeneration = undefined
    this.healthVersion = undefined
  }

  async inspectNativeMcp(
    directory: string,
    signal?: AbortSignal,
    phase: 'configuration' | 'health' = 'health',
  ): Promise<OpenCodeMcpInspection> {
    const combined = this.signal(signal)
    let name = this.options.appMcpServerName ?? APP_MCP_SERVER_NAME
    if (!this.options.server.inspectMcpConfiguration) {
      throw new HarnessExecutionError('OPENCODE_MCP_AUTH_EVIDENCE_UNAVAILABLE', 'This controller cannot prove the App Authorization environment reference.')
    }
    const proof = await this.options.server.inspectMcpConfiguration(directory, name, combined)
    if (proof) name = proof.name
    const expected = this.options.expectedAppMcpEndpoint
    if (phase === 'configuration' || !proof) {
      return {
        cwd: directory, providerVersion: this.providerVersion, serverName: name,
        ...(proof?.automaticEndpoint ? { automaticEndpoint: true } : {}),
        nativeStatus: !proof ? 'not_detected' : proof.enabled === false ? 'disabled' : 'status_unavailable',
        transport: proof?.transport ?? 'unknown', endpoint: proof?.endpoint ?? null,
        credentialEnvironmentVariable: proof?.credentialEnvironmentVariable ?? null,
        endpointMatches: proof?.automaticEndpoint ? true : expected && proof ? endpointMatches(proof.endpoint, expected) : null,
        baseConfigurationFilters: [], policyScope: 'base_configuration_only',
      }
    }
    await this.exclusive(() => this.ready(combined))
    const config = object(await this.json('/config', directory, combined))
    const statuses = object(await this.json('/mcp', directory, combined))
    const configured = object(config.mcp)[name]
    const status = object(statuses[name]).status
    const entry = object(configured)
    const nativeStatus: OpenCodeMcpInspection['nativeStatus'] = !configured ? 'not_detected'
      : entry.enabled === false ? 'disabled'
        : ['connected', 'disabled', 'failed', 'needs_auth', 'needs_client_registration'].includes(String(status))
          ? status as OpenCodeMcpInspection['nativeStatus'] : 'status_unavailable'
    const endpoint = typeof entry.url === 'string' ? entry.url : null
    const automaticEndpoint = proof.automaticEndpoint === true && isSupportedAppMcpServerName(name) && isAppLauncher('opencode', entry)
    const matchesProof = (automaticEndpoint || (entry.type === 'remote' && entry.oauth === false
      && entry.url === proof.endpoint)) && (entry.enabled !== false) === (proof.enabled !== false)
    return { cwd: directory, providerVersion: this.providerVersion, serverName: name, nativeStatus, endpoint, automaticEndpoint,
      transport: automaticEndpoint ? 'stdio' : entry.type === 'remote' ? 'streamable-http' : 'unknown',
      credentialEnvironmentVariable: matchesProof ? proof.credentialEnvironmentVariable ?? null : null,
      endpointMatches: automaticEndpoint ? true : expected ? endpointMatches(endpoint ?? undefined, expected) : null,
      baseConfigurationFilters: configurationPermissionRules(config.permission), policyScope: 'base_configuration_only',
    }
  }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    const first = this.sessions.values().next().value as SessionState | undefined
    const baseline = { harness: 'opencode' as const, serverName: this.options.appMcpServerName ?? APP_MCP_SERVER_NAME,
      endpointMatches: null, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString() }
    if (!first) return { ...baseline, state: 'status_unavailable', detail: 'A runner working directory is required for native MCP inspection.' }
    try {
      const native = await this.inspectNativeMcp(first.directory, signal)
      const state: McpDetection['state'] = native.nativeStatus !== 'not_detected'
        && (!isSupportedAppMcpTokenName(native.credentialEnvironmentVariable ?? undefined) || (native.transport !== 'streamable-http' && !native.automaticEndpoint))
        ? 'misconfigured'
        : native.nativeStatus === 'not_detected' ? 'not_detected' : native.endpointMatches === false ? 'misconfigured'
          : native.nativeStatus === 'connected' ? 'connected' : native.nativeStatus === 'disabled' ? 'disabled'
            : ['needs_auth', 'needs_client_registration'].includes(native.nativeStatus) ? 'authentication_required'
              : native.nativeStatus === 'status_unavailable' ? 'status_unavailable' : 'broken'
      return { ...baseline, serverName: native.serverName, state, endpointMatches: native.endpointMatches, credentialEnvironmentVariable: native.credentialEnvironmentVariable }
    } catch {
      return { ...baseline, state: 'check_failed', detail: 'OpenCode MCP inspection failed; resolved credential values are not included in diagnostics.' }
    }
  }
}

/** Repeated/concurrent observation retains the first qualified source identity.
 * A replacement native producer generation must not reuse its positive receipt. */
function historyWithOwnedTerminal(history: NativeHistory, turn: OwnedTurn, generation: number): NativeHistory {
  if (!turn.terminalResult) return history
  const events = turn.generation === generation ? turn.reconciliationEvents ?? [] : []
  return { ...history,
    events: [...history.events, ...events.filter((event) => !history.events.some(
      (raw) => raw.connectionId === event.connectionId && raw.sequence === event.sequence))],
    terminalResult: turn.terminalResult,
    ...(turn.nativeMessageId ? { nativeMessageId: turn.nativeMessageId } : {}),
    terminalTurn: { correlationId: turn.correlationId, providerId: turn.messageID, result: turn.terminalResult },
  }
}

/** Resolved before any native side effect, so invalid pinned instructions fail before task work. */
function sessionInstructions(input: NativeSessionStart): AgentInstructionBundle | undefined {
  return agentInstructionBundle(input.kind === 'operator' ? input.configuration : input.request.configuration)
}
/** A reused correlation must match both task text and the accepted instruction identity. */
function turnDigest(prompt: string, instructions: AgentInstructionBundle | undefined, fileIdentity?: string): string {
  const legacy = `${instructions?.hash ?? 'none'}\n${prompt}`
  // Preserve text-only correlation identity byte-for-byte.
  return digest(fileIdentity ? JSON.stringify([legacy, fileIdentity]) : legacy)
}
function newState(directory: string, configuration: OpenCodeHarnessConfiguration, instructions: AgentInstructionBundle | undefined): SessionState {
  return { connectionId: randomUUID(), responsesInFlight: new Set(), responsesUncertain: new Set(), autoReplies: new OpenCodeNativeAutoReplies(), directory, configuration, instructions, events: [], eventBytes: 0, eventIds: new Set(), pendingIds: new Set(), historyIds: new Set(),
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
async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('OpenCode response body is missing.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > OPENCODE_HTTP_BODY_LIMIT) throw new Error('OpenCode response exceeds the bounded native page buffer.')
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}
