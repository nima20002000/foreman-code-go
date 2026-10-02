import { createHash, randomUUID } from 'node:crypto'
import type { AgentHarness, ExecutionResult, McpDetection, NativeHarnessEvent, NativeSessionReference } from '@graphql/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import type { NativeMcpHttpCredentialAcknowledgement } from '../mcpDetection.js'
import { unavailableNativeResponse, type NativeResponseAvailability, type ResponseAvailabilityInspector } from '../responseAvailability.js'
import { claudeMcpDetection, decodeClaudeMcpControl, type ClaudeMcpInspection } from './mcpInspection.js'
import type { ClaudeResponseAvailabilityQuery, ClaudeLiveCallbackReader, ClaudeNativeCallbackContext, ClaudeCallbackAuthority, ClaudePendingNotification } from './callbackAvailability.js'
import { ClaudeBoundedQueue } from './queue.js'
import type { ClaudeNativeObservation, ClaudeSdkRunner, ClaudeSdkSession, ClaudeSessionScope } from './port.js'

/** Message receipts are distinct from native turns. The shared port consumes this additive seam. */
export interface ClaudeMessageSubmission {
  kind: 'message'
  nativeSessionId: string
  nativeMessageId: string
  clientCorrelationId: string
}
export interface ClaudeMessageTurnInput extends NativeTurnInput {
  callbackAuthority?: ClaudeCallbackAuthority
  onMessageSubmitted?(identity: ClaudeMessageSubmission): Promise<void>
}
export interface ClaudeSessionQualification {
  sdkVersion: string
  cliVersion: string
  basicTurns: boolean
  resume: boolean
  fork: boolean
  history: boolean
  interactions?: boolean
}
/** Stable client identity permits read-only recovery; it is not a native receipt before observation. */
export function claudePromptUuid(correlationId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['graphql-claude-message-v2', correlationId])).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface ClaudeInitialTurnInput extends ClaudeMessageTurnInput {
  onSessionObserved(session: NativeSessionReference): Promise<void>
}

export interface ClaudeNativeSessionManager extends NativeHarnessSessionManager, ResponseAvailabilityInspector {
  /** Read-only SDK callback context from a proven root tool/message owner. */
  refreshInspectionCredentials(start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection>
  prepareInspection(start: NativeSessionStart, signal?: AbortSignal): Promise<ClaudeMcpInspection>
  startInitialTurn(start: NativeSessionStart, input: ClaudeInitialTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  nativeCallbackContext(nativeSessionId: string, toolUseId: string): ClaudeNativeCallbackContext | undefined
  callbackAuthority(context: ClaudeNativeCallbackContext): ClaudeCallbackAuthority | undefined
  notifyPendingChanged(notification: ClaudePendingNotification): void
  waitNativeCallbackContext(toolUseId: string, signal: AbortSignal, nativeSessionId?: string): Promise<ClaudeNativeCallbackContext>
}

interface Turn {
  correlationId: string
  promptUuid: string
  input: ClaudeMessageTurnInput
  submitted: boolean
  observing: boolean
  replyObserved: boolean
  resultBeforeReply: boolean
  events: ClaudeBoundedQueue<NativeHarnessEvent>
  terminal?: ExecutionResult
  nativeMessageId?: string
  assistantMessageId?: string
  authority?: ClaudeCallbackAuthority
}
interface Runtime {
  sdk: ClaudeSdkSession
  generation: string
  currentAuthorizationScope: string
  httpCredentialAcknowledgement?: NativeMcpHttpCredentialAcknowledgement
  credentialServers?: Readonly<Record<string, unknown>>
  replacingForResume?: boolean
  closed: boolean
  session?: NativeSessionReference
  events: NativeHarnessEvent[]
  nextSequence: number
  turns: Map<string, Turn>
  messageOwners: Map<string, Turn>
  toolOwners: Map<string, Turn>
  restoredReceipts: Map<string, ClaudeMessageSubmission>
  active?: Turn
  controlPending?: boolean
  pumping?: Promise<void>
  decode?: (raw: unknown) => readonly Pick<NativeHarnessEvent, 'type' | 'payload'>[]
  failure?: unknown
  onSessionObserved?: (session: NativeSessionReference) => Promise<void>
  initialized: Promise<NativeSessionReference>
  resolveInit(session: NativeSessionReference): void
  rejectInit(error: unknown): void
}

export function createClaudeNativeSessionManager(options: {
  runner: ClaudeSdkRunner
  scope: ClaudeSessionScope
  sdkOptions: Readonly<Record<string, unknown>>
  qualification: ClaudeSessionQualification
  now?: () => string
  decodeFactory?: (start: NativeSessionStart) => (raw: unknown) => readonly Pick<NativeHarnessEvent, 'type' | 'payload'>[]
  interactionPort?: Pick<NativeHarnessSessionManager, 'pending' | 'respond' | 'reconcileResponse' | 'stopAutomaticResponses'>
  cancelPendingRequests?(): void
  initializationTimeoutMs?: number
  liveCallbacks?: ClaudeLiveCallbackReader
  inspectionStart?: () => NativeSessionStart | Promise<NativeSessionStart>
  expectedMcp?: { serverName: string; url?: string }
  appMcpAccess?: 'management' | 'none'
  credentialEnvironmentVariables?: readonly string[]
  supportedInteractionKinds?: readonly string[]
  pendingInteractions?: (session: NativeSessionReference) => readonly import('@graphql/contracts').PendingNativeInteraction[]
}): ClaudeNativeSessionManager {
  // The provider enum addition is integrated by the designated shared-contract writer.
  const harness = 'claude' as AgentHarness
  const resident = new Map<string, Runtime>()
  const all = new Set<Runtime>()
  const callbackWaiters = new Set<{ toolUseId: string; nativeSessionId?: string; signal: AbortSignal; abort(): void; resolve(context: ClaudeNativeCallbackContext): void; reject(error: unknown): void }>()
  const forks = new Map<string, { identity: string; promise: Promise<NativeSessionReference> }>()
  const initialTurns = new Map<string, { identity: string; turn: Turn; opening: Promise<NativeSessionReference> }>()
  let prepared: { identity: string; opening: Promise<Runtime> } | undefined
  let disposed = false
  const now = options.now ?? (() => new Date().toISOString())
  function qualified(capability: 'basicTurns' | 'resume' | 'fork' | 'history') {
    if (!options.qualification[capability]) throw new HarnessExecutionError('CLAUDE_CAPABILITY_UNQUALIFIED', `Claude ${capability} has not been qualified on the selected installation.`)
  }
  function runtimeFor(session: NativeSessionReference): Runtime {
    const runtime = resident.get(session.nativeSessionId)
    if (!runtime || session.harness !== harness || session.providerVersion !== options.qualification.cliVersion) throw new HarnessExecutionError('CLAUDE_SESSION_UNAVAILABLE', 'The exact owned Claude session is not resident.')
    return runtime
  }
  function record(runtime: Runtime, type: string, payload: Record<string, unknown>, turn?: Turn): NativeHarnessEvent {
    const event = { type, payload: turn ? { ...payload, clientCorrelationId: turn.correlationId } : payload, sequence: runtime.nextSequence++, occurredAt: now() }
    runtime.events.push(event)
    if (runtime.events.length > 256) runtime.events.shift()
    if (turn?.observing) turn.events.offer(event)
    return event
  }
  function rememberOwner(map: Map<string, Turn>, id: string, turn: Turn): void {
    const previous = map.get(id)
    if (previous && previous !== turn) throw new HarnessExecutionError('CLAUDE_MESSAGE_IDENTITY_CONFLICT', 'Native provenance identity was reused across application messages.')
    if (!previous && map.size >= 2048) map.delete(map.keys().next().value!)
    map.set(id, turn)
  }
  async function observed(runtime: Runtime, observation: ClaudeNativeObservation) {
    for (const turn of runtime.turns.values()) {
      if (!observation.promptUuids.includes(turn.promptUuid)) continue
      if (observation.kind === 'reply') turn.replyObserved = true
      if (turn.submitted) continue
      await runtime.initialized // Native SID persistence precedes input ACK/file/callback publication.
      // Only a native echo establishes consumption of this client UUID as a native input message.
      const identity: ClaudeMessageSubmission = { kind: 'message', nativeSessionId: observation.nativeSessionId, nativeMessageId: turn.promptUuid, clientCorrelationId: turn.correlationId }
      await turn.input.onMessageSubmitted?.(identity)
      turn.submitted = true
      turn.nativeMessageId = turn.promptUuid
      record(runtime, 'message.submitted', { nativeSessionId: observation.nativeSessionId, nativeMessageId: turn.promptUuid, clientCorrelationId: turn.correlationId,
        ...(observation.providerMessageId ? { source: { eventId: observation.providerMessageId } } : {}) }, turn)
    }
  }
  async function ownedControl<T>(runtime: Runtime, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    // Reserve before the first await and keep input fenced through actual SDK cleanup.
    if (runtime.active || runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'The pre-input control operation cannot overlap model work or another control operation.')
    if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query is closed.')
    runtime.controlPending = true
    let closing: Promise<void> | undefined
    const close = () => {
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      closing ??= runtime.sdk.close()
      void closing.catch(() => undefined)
    }
    const timer = setTimeout(close, options.initializationTimeoutMs ?? 10_000)
    signal?.addEventListener('abort', close, { once: true })
    try {
      const value = await operation() // SDK close rejects/joins the actual control waiter; no abandoned RPC race.
      signal?.throwIfAborted()
      if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK control operation closed or timed out.')
      return value
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', close)
      try { if (closing) await closing } finally { runtime.controlPending = false }
    }
  }
  function authorizationScope(start: NativeSessionStart): string {
    return createHash('sha256').update(JSON.stringify(['claude-mcp-authorization-v1', options.scope, start])).digest('hex')
  }
  function inspectionCredentials(runtime: Runtime): Pick<ClaudeMcpInspection, 'httpCredentialAcknowledgement' | 'currentAuthorizationScope'> {
    const acknowledgement = runtime.httpCredentialAcknowledgement
    if (runtime.closed || disposed || acknowledgement && (acknowledgement.generation !== runtime.generation
      || acknowledgement.authorizationScope !== runtime.currentAuthorizationScope)) delete runtime.httpCredentialAcknowledgement
    return { currentAuthorizationScope: runtime.currentAuthorizationScope,
      ...(runtime.httpCredentialAcknowledgement ? { httpCredentialAcknowledgement: { ...runtime.httpCredentialAcknowledgement } } : {}) }
  }
  function managedHttpCredential(start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, serverName: string): { endpoint: string } | undefined {
    const config = servers[serverName] as Record<string, unknown> | undefined
    if (config?.type !== 'http') return undefined
    const headers = config.headers && typeof config.headers === 'object' ? config.headers as Record<string, unknown> : {}
    const authorization = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'authorization')
    if (!authorization.length) return undefined
    const token = start.environment?.variables.GRAPHQL_MCP_TOKEN
    let endpoint: URL | undefined
    let expectedEndpoint: URL | undefined
    try {
      if (typeof config.url === 'string') endpoint = new URL(config.url)
      if (options.expectedMcp?.url) expectedEndpoint = new URL(options.expectedMcp.url)
    } catch { /* Invalid locators cannot establish credential scope. */ }
    if (!token || authorization.length !== 1 || authorization[0]![1] !== `Bearer ${token}` || !endpoint
      || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || options.expectedMcp?.url && endpoint.toString() !== expectedEndpoint?.toString()) {
      throw new HarnessExecutionError('CLAUDE_MCP_CREDENTIAL_SCOPE_CONFLICT', 'Managed HTTP credentials do not match the admitted authorization scope and endpoint.')
    }
    return { endpoint: endpoint.toString() }
  }
  async function deliverCredentials(runtime: Runtime, start: NativeSessionStart, servers: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ClaudeMcpInspection> {
    const managedName = options.expectedMcp?.serverName ?? 'graphql'
    const httpCredential = managedHttpCredential(start, servers, managedName)
    delete runtime.httpCredentialAcknowledgement
    delete runtime.credentialServers
    if (!runtime.sdk.setMcpServers) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK scoped MCP control update is unavailable.')
    return ownedControl(runtime, async () => {
      runtime.currentAuthorizationScope = authorizationScope(start)
      const raw = await runtime.sdk.setMcpServers!(servers).catch(() => {
        throw new HarnessExecutionError('CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK did not confirm its owned MCP control update.')
      })
      const response = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      if (!Array.isArray(response.added) || !Array.isArray(response.removed) || !response.errors || typeof response.errors !== 'object' || Object.keys(response.errors).length
        || httpCredential && !response.added.includes(managedName)) {
        throw new HarnessExecutionError('CLAUDE_MCP_CREDENTIAL_DELIVERY_UNCONFIRMED', 'The SDK did not confirm its owned MCP control update.')
      }
      signal?.throwIfAborted()
      if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query closed before credential acknowledgment.')
      if (httpCredential) runtime.httpCredentialAcknowledgement = { source: 'sdk_set_mcp_servers', serverName: managedName,
        endpoint: httpCredential.endpoint, generation: runtime.generation, authorizationScope: runtime.currentAuthorizationScope }
      if (!runtime.sdk.mcpServerStatus) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK MCP control status is unavailable')
      const rows = await runtime.sdk.mcpServerStatus!()
      signal?.throwIfAborted()
      runtime.credentialServers = { ...servers, ...(servers[managedName] ? { [managedName]: structuredClone(servers[managedName]) } : {}) }
      return decodeClaudeMcpControl(rows, runtime.generation, now(), inspectionCredentials(runtime))
    }, signal).catch((error: unknown) => { delete runtime.httpCredentialAcknowledgement; throw error })
  }
  function makeRuntime(start: NativeSessionStart): Runtime {
    let resolveInit!: Runtime['resolveInit']
    let rejectInit!: Runtime['rejectInit']
    const initialized = new Promise<NativeSessionReference>((resolve, reject) => { resolveInit = resolve; rejectInit = reject })
    // The rejection is observed even if native startup fails before await initialized.
    void initialized.catch(() => undefined)
    const runtime = { generation: randomUUID(), currentAuthorizationScope: authorizationScope(start), closed: false, events: [], nextSequence: 0, turns: new Map(), messageOwners: new Map(), toolOwners: new Map(), restoredReceipts: new Map(), initialized, resolveInit, rejectInit } as unknown as Runtime
    if (options.decodeFactory) runtime.decode = options.decodeFactory(start)
    all.add(runtime)
    return runtime
  }
  async function prepareRuntime(start: NativeSessionStart, signal?: AbortSignal): Promise<Runtime> {
    signal?.throwIfAborted()
    if (disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
    const cwd = start.kind === 'operator' ? start.workingDirectory : start.request.workingDirectory
    if (cwd !== options.scope.cwd) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'Inspection differs from the pinned working directory.')
    const identity = JSON.stringify(start)
    if (prepared) {
      if (prepared.identity !== identity) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'The owned SDK query already has another immutable inspection context.')
      return prepared.opening
    }
    const runtime = makeRuntime(start)
    const opening = (async () => {
      try {
        runtime.sdk = await options.runner.open({ scope: options.scope,
          options: { ...options.sdkOptions, env: { ...(options.sdkOptions.env as Record<string, string> | undefined), ...start.environment?.variables } },
          ...(signal ? { signal } : {}), onObservation: (observation) => observed(runtime, observation),
          ...(options.cancelPendingRequests ? { cancelPendingRequests: () => { if (!runtime.replacingForResume) options.cancelPendingRequests!() } } : {}) })
        runtime.pumping = pump(runtime)
        if (!runtime.sdk.initializationResult) throw new HarnessExecutionError('CLAUDE_INIT_INSPECTION_UNAVAILABLE', 'The SDK initialization control result is unavailable.')
        await ownedControl(runtime, () => runtime.sdk.initializationResult!(), signal)
        if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The inspected SDK query closed.')
        return runtime
      } catch (error) {
        runtime.rejectInit(error)
        runtime.closed = true
        delete runtime.httpCredentialAcknowledgement
        await runtime.sdk?.close()
        await runtime.pumping
        throw error
      }
    })()
    prepared = { identity, opening }
    return opening
  }
  async function open(start: NativeSessionStart, resume?: NativeSessionReference, signal?: AbortSignal, initial?: { turn: Turn; onSessionObserved(session: NativeSessionReference): Promise<void> }): Promise<NativeSessionReference> {
    if (disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
    qualified(resume ? 'resume' : 'basicTurns')
    const cwd = start.kind === 'operator' ? start.workingDirectory : start.request.workingDirectory
    if (cwd !== options.scope.cwd) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'Claude working directory differs from the pinned scope.')
    const identity = JSON.stringify(start)
    const inspected = prepared
    if (inspected && inspected.identity !== identity) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'Input differs from the exact inspected owner/configuration/environment.')
    const previous = inspected ? await inspected.opening : undefined
    if (previous?.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
    if (previous?.closed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned SDK query is closed.')
    if (resume && previous && (previous.session || previous.turns.size)) throw new HarnessExecutionError('CLAUDE_INSPECTION_ALREADY_STARTED', 'Resume cannot replace a query that already owns native input.')
    const credentialServers = resume ? previous?.credentialServers : undefined
    if (resume && previous) {
      // Session selection is immutable in the SDK. Retire only the unused
      // inspection query; it has no message callbacks to cancel in this owner.
      previous.replacingForResume = true
      previous.closed = true
      delete previous.httpCredentialAcknowledgement
      await previous.sdk.close()
      await previous.pumping
      all.delete(previous)
    }
    const runtime = !resume && previous ? previous : makeRuntime(start)
    if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
    if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned SDK query is closed.')
    if (initial) {
      runtime.onSessionObserved = initial.onSessionObserved
      runtime.turns.set(initial.turn.correlationId, initial.turn)
      runtime.active = initial.turn
    }
    all.add(runtime)
    try {
      if (!runtime.sdk) runtime.sdk = await options.runner.open({
        scope: options.scope, options: { ...options.sdkOptions, env: { ...(options.sdkOptions.env as Record<string, string> | undefined), ...start.environment?.variables } },
        ...(signal ? { signal } : {}),
        ...(resume ? { resume: { ...options.scope, nativeSessionId: resume.nativeSessionId } } : {}),
        onObservation: (observation) => observed(runtime, observation),
        ...(options.cancelPendingRequests ? { cancelPendingRequests: () => { if (!runtime.replacingForResume) options.cancelPendingRequests!() } } : {}),
      })
      runtime.pumping ??= pump(runtime)
      if (resume) {
        if (!runtime.sdk.initializationResult) throw new HarnessExecutionError('CLAUDE_INIT_INSPECTION_UNAVAILABLE', 'The pinned SDK must acknowledge exact-session resume initialization.')
        await ownedControl(runtime, () => runtime.sdk.initializationResult!(), signal)
        if (credentialServers) {
          const snapshot = await deliverCredentials(runtime, start, credentialServers, signal)
          const expected = options.expectedMcp ?? { serverName: 'graphql' }
          const detection = claudeMcpDetection(snapshot, { ...expected,
            ...(snapshot.httpCredentialAcknowledgement ? { url: snapshot.httpCredentialAcknowledgement.endpoint } : {}) })
          if (detection.state !== 'connected' || detection.endpointMatches === false
            || snapshot.httpCredentialAcknowledgement && detection.credentialArrangement?.kind !== 'scoped_http_header') {
            throw new HarnessExecutionError('CLAUDE_RESUME_MCP_UNAVAILABLE', 'The resumed SDK query did not establish its scoped MCP connection before input.')
          }
        }
        if (inspected) prepared = { identity, opening: Promise.resolve(runtime) }
        if (!runtime.session) {
          runtime.session = { ...resume }
          if (resident.has(resume.nativeSessionId)) throw new Error('Claude native session is already leased to another runtime')
          resident.set(resume.nativeSessionId, runtime)
          runtime.resolveInit(runtime.session)
        }
      }
      if (initial) await runtime.sdk.offer({ promptUuid: initial.turn.promptUuid, content: initial.turn.input.prompt }, signal)
      const timer = setTimeout(() => runtime.rejectInit(new HarnessExecutionError('CLAUDE_INIT_TIMEOUT', 'Claude initialization did not provide an exact native session.')), options.initializationTimeoutMs ?? 10_000)
      try { return await runtime.initialized } finally { clearTimeout(timer) }
    } catch (error) {
      runtime.rejectInit(error)
      await runtime.sdk?.close()
      await runtime.pumping
      if (runtime.session && resident.get(runtime.session.nativeSessionId) === runtime) resident.delete(runtime.session.nativeSessionId)
      all.delete(runtime)
      initial?.turn.events.close(error)
      throw error
    }
  }
  async function pump(runtime: Runtime): Promise<void> {
    try {
      for await (const output of runtime.sdk.output) {
        const frame = output.raw && typeof output.raw === 'object' ? output.raw as Record<string, unknown> : {}
        if (frame.type === 'system' && frame.subtype === 'init') {
          if (frame.claude_code_version !== options.qualification.cliVersion || frame.cwd !== options.scope.cwd) {
            throw new HarnessExecutionError('CLAUDE_NATIVE_INSTALLATION_CHANGED', 'Native initialization differs from the qualified CLI version or pinned working directory.')
          }
        }
        if (!runtime.session && frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string' && frame.session_id.length > 0) {
          runtime.session = { harness, providerVersion: options.qualification.cliVersion, nativeSessionId: frame.session_id }
          if (resident.has(frame.session_id)) throw new Error('Claude native session is already leased to another runtime')
          resident.set(frame.session_id, runtime)
          await runtime.onSessionObserved?.(runtime.session)
          record(runtime, 'session.idle', { nativeSessionId: frame.session_id })
          runtime.resolveInit(runtime.session)
        }
        const patch = frame.patch && typeof frame.patch === 'object' ? frame.patch as Record<string, unknown> : {}
        if (frame.type === 'system' && (frame.subtype === 'task_started' && frame.is_backgrounded === true
          || frame.subtype === 'task_updated' && patch.is_backgrounded === true
          || frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks) && frame.tasks.length > 0)
          || frame.type === 'result' && (frame.deferred_tool_use != null || ['tool_deferred', 'background_requested'].includes(String(frame.terminal_reason)))) {
          record(runtime, 'claude.background.unsupported', { nativeSessionId: frame.session_id,
            ...(typeof frame.task_id === 'string' ? { nativeTaskId: frame.task_id } : {}) })
          throw new HarnessExecutionError('CLAUDE_BACKGROUND_UNQUALIFIED', 'Native background work was observed despite the qualified disabled policy; parent results cannot settle this work.')
        }
        const active = runtime.active
        const matched = output.observation && [...runtime.turns.values()].find((turn) => output.observation!.promptUuids.includes(turn.promptUuid))
        const message = frame.message && typeof frame.message === 'object' ? frame.message as Record<string, unknown> : {}
        const streamEvent = frame.event && typeof frame.event === 'object' ? frame.event as Record<string, unknown> : {}
        const streamMessage = streamEvent.message && typeof streamEvent.message === 'object' ? streamEvent.message as Record<string, unknown> : {}
        const messageId = typeof message.id === 'string' ? message.id : typeof streamMessage.id === 'string' ? streamMessage.id : undefined
        if (matched?.submitted && frame.parent_tool_use_id == null) {
          if (messageId) rememberOwner(runtime.messageOwners, messageId, matched)
          if (typeof frame.uuid === 'string') rememberOwner(runtime.messageOwners, frame.uuid, matched)
        }
        // Root follow-up blocks need the same observed message identity, never the latest active turn.
        const rootOwner = frame.parent_tool_use_id == null ? matched
          ?? (messageId ? runtime.messageOwners.get(messageId) : undefined)
          ?? (typeof frame.uuid === 'string' ? runtime.messageOwners.get(frame.uuid) : undefined) : undefined
        if (rootOwner?.submitted && frame.type === 'assistant' && frame.parent_tool_use_id == null) {
          if (messageId) rootOwner.assistantMessageId = messageId
          else if (typeof frame.uuid === 'string') rootOwner.assistantMessageId = frame.uuid
        }
        const knownResult = typeof frame.is_error === 'boolean' && typeof frame.uuid === 'string' && frame.uuid.length > 0
          && ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(String(frame.subtype))
        const successfulResult = frame.subtype === 'success' && frame.is_error === false
        if (matched && frame.type === 'result' && successfulResult && !matched.replyObserved) matched.resultBeforeReply = true
        const terminalAdmissible = knownResult && matched?.submitted && (!successfulResult || matched.replyObserved && !matched.resultBeforeReply)
        const decoded = runtime.decode?.(output.raw) ?? []
        if (frame.type === 'result' && !terminalAdmissible) {
          // Native consumption is a receipt, not proof that a queued wake's result answers this request.
          record(runtime, 'claude.result.unattributed', { nativeSessionId: frame.session_id, nativeResult: output.raw }, matched)
        } else {
          for (const event of decoded) {
            const parentId = typeof event.payload.parentToolUseId === 'string' ? event.payload.parentToolUseId : undefined
            const toolId = typeof event.payload.toolUseId === 'string' ? event.payload.toolUseId : undefined
            const eventOwner = parentId ? runtime.toolOwners.get(parentId)
              : event.type === 'claude.task' ? toolId ? runtime.toolOwners.get(toolId) : undefined
                : rootOwner ?? (typeof event.payload.messageId === 'string' ? runtime.messageOwners.get(event.payload.messageId) : undefined)
                  ?? (toolId && event.type === 'claude.tool' ? runtime.toolOwners.get(toolId) : undefined)
            if (eventOwner && toolId && event.type === 'claude.tool' && !parentId) {
              rememberOwner(runtime.toolOwners, toolId, eventOwner)
              resolveCallbackWaiters()
            }
            record(runtime, event.type, event.payload, frame.type === 'result' ? matched : eventOwner?.submitted ? eventOwner : undefined)
          }
        }
        if (matched && !matched.terminal && terminalAdmissible && frame.type === 'result') {
          matched.terminal = successfulResult
            ? { outcome: 'succeeded', output: typeof frame.result === 'string' ? frame.result : '' }
            : { outcome: 'failed', error: { code: 'CLAUDE_NATIVE_RESULT_ERROR', message: Array.isArray(frame.errors) ? frame.errors.join('\n') : 'Claude returned an error result.', retryable: false } }
          record(runtime, 'turn.completed', { nativeSessionId: frame.session_id, nativeMessageId: matched.nativeMessageId, clientCorrelationId: matched.correlationId, result: matched.terminal,
            ...(typeof frame.uuid === 'string' ? { source: { eventId: frame.uuid } } : {}) }, matched)
          matched.events.close()
          matched.observing = false
          if (active === matched) delete runtime.active
        }
      }
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      if (!runtime.session) runtime.rejectInit(new Error('Claude stream ended before native initialization'))
      runtime.active?.events.close(new Error('Claude stream ended without an exact result; submission remains uncertain'))
    } catch (error) {
      runtime.failure = error
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      runtime.rejectInit(error)
      runtime.active?.events.close(error)
      await runtime.sdk.close()
    }
  }
  function findCallbackContext(toolUseId: string, nativeSessionId?: string): ClaudeNativeCallbackContext | undefined {
    const contexts: ClaudeNativeCallbackContext[] = []
    for (const runtime of resident.values()) {
      if (nativeSessionId && runtime.session?.nativeSessionId !== nativeSessionId) continue
      const turn = runtime.toolOwners.get(toolUseId)
      if (!runtime.closed && !runtime.failure && turn?.submitted && turn.nativeMessageId && !turn.terminal && runtime.session) {
        contexts.push({ nativeSessionId: runtime.session.nativeSessionId, nativeMessageId: turn.nativeMessageId,
          clientCorrelationId: turn.correlationId, generation: runtime.generation })
      }
    }
    return contexts.length === 1 ? contexts[0] : undefined
  }
  function resolveCallbackWaiters(): void {
    for (const waiter of callbackWaiters) {
      const context = findCallbackContext(waiter.toolUseId, waiter.nativeSessionId)
      if (!context) continue
      callbackWaiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.resolve(context)
    }
  }
  function rejectCallbackWaiters(): void {
    for (const waiter of callbackWaiters) {
      callbackWaiters.delete(waiter)
      waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new HarnessExecutionError('CLAUDE_CALLBACK_CONTEXT_CLOSED', 'The owned native callback context closed.'))
    }
  }
  function createTurn(input: ClaudeMessageTurnInput): Turn {
    return { correlationId: input.clientCorrelationId, promptUuid: claudePromptUuid(input.clientCorrelationId), input,
      submitted: false, observing: true, replyObserved: false, resultBeforeReply: false, events: new ClaudeBoundedQueue(256),
      ...(input.callbackAuthority ? { authority: { ...input.callbackAuthority } } : {}) }
  }
  function subscribe(turn: Turn, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    return {
        [Symbol.asyncIterator]() {
          const iterator = turn.events[Symbol.asyncIterator]()
          const detach = () => { turn.observing = false; void iterator.return?.() }
          const aborted = () => detach()
          signal?.addEventListener('abort', aborted, { once: true })
          const cleanup = () => { signal?.removeEventListener('abort', aborted); detach() }
          return {
            async next() {
              if (signal?.aborted) { cleanup(); throw signal.reason }
              const value = await iterator.next()
              if (signal?.aborted) { cleanup(); throw signal.reason }
              if (value.done) cleanup()
              return value
            },
            async return() { cleanup(); return { done: true as const, value: undefined } },
            async throw(error: unknown) { cleanup(); throw error },
          }
        },
      }
  }
  const manager: ClaudeNativeSessionManager = {
    harness,
    callbackAuthority(context) {
      const runtime = resident.get(context.nativeSessionId)
      const turn = runtime?.turns.get(context.clientCorrelationId)
      if (!runtime || runtime.closed || runtime.generation !== context.generation || !turn?.submitted
        || turn.nativeMessageId !== context.nativeMessageId || turn.terminal || !turn.authority) return undefined
      return { ...turn.authority }
    },
    notifyPendingChanged(notification) {
      const runtime = resident.get(notification.nativeSessionId)
      const turn = runtime?.turns.get(notification.clientCorrelationId)
      if (!runtime || runtime.closed || runtime.generation !== notification.generation || !turn?.submitted
        || turn.nativeMessageId !== notification.nativeMessageId || turn.terminal) return
      record(runtime, 'interaction.pending', { nativeSessionId: notification.nativeSessionId,
        nativeMessageId: notification.nativeMessageId, nativeRequestId: notification.nativeRequestId,
        nativeRequestType: notification.nativeRequestType, generation: notification.generation }, turn)
    },
    nativeCallbackContext(nativeSessionId, toolUseId) { return findCallbackContext(toolUseId, nativeSessionId) },
    async waitNativeCallbackContext(toolUseId, signal, nativeSessionId) {
      signal.throwIfAborted()
      if (disposed) throw new HarnessExecutionError('CLAUDE_CALLBACK_CONTEXT_CLOSED', 'Claude allocation is disposed.')
      const context = findCallbackContext(toolUseId, nativeSessionId)
      if (context) return context
      if (callbackWaiters.size >= 128) throw new HarnessExecutionError('CLAUDE_CALLBACK_CONTEXT_LIMIT', 'The bounded native callback context window is full.')
      return new Promise((resolve, reject) => {
        const waiter = { toolUseId, ...(nativeSessionId ? { nativeSessionId } : {}), signal, resolve, reject,
          abort() { callbackWaiters.delete(waiter); signal.removeEventListener('abort', waiter.abort); reject(signal.reason) } }
        callbackWaiters.add(waiter)
        signal.addEventListener('abort', waiter.abort, { once: true })
        if (signal.aborted) waiter.abort()
      })
    },
    async inspectResponseAvailability(session, query: ClaudeResponseAvailabilityQuery, signal): Promise<NativeResponseAvailability> {
      signal?.throwIfAborted()
      const runtime = resident.get(session.nativeSessionId)
      if (!runtime || runtime.closed || disposed) return unavailableNativeResponse(session, query, 'session_closed')
      if (session.harness !== harness || session.providerVersion !== options.qualification.cliVersion || query.expectedNativeTurnId !== undefined) {
        return unavailableNativeResponse(session, query, 'identity_mismatch')
      }
      if (!options.qualification.interactions) return unavailableNativeResponse(session, query, 'unqualified')
      if (!options.liveCallbacks) return unavailableNativeResponse(session, query, 'callback_lost')
      const turn = runtime.active
      if (!turn?.submitted || !turn.nativeMessageId || runtime.failure) return unavailableNativeResponse(session, query, 'callback_lost')
      if (query.expectedNativeMessageId !== undefined && query.expectedNativeMessageId !== turn.nativeMessageId
        || query.expectedGeneration !== undefined && query.expectedGeneration !== runtime.generation) {
        return unavailableNativeResponse(session, query, 'identity_mismatch')
      }
      const result = await options.liveCallbacks.inspectCallbackAvailability({ ...query, nativeSessionId: session.nativeSessionId,
        nativeMessageId: turn.nativeMessageId, generation: runtime.generation })
      signal?.throwIfAborted()
      if (runtime.closed || disposed || resident.get(session.nativeSessionId) !== runtime) return unavailableNativeResponse(session, query, 'session_closed')
      if (runtime.active !== turn || turn.terminal || result.nativeSessionId !== session.nativeSessionId
        || result.nativeRequestId !== query.nativeRequestId || result.nativeRequestType !== query.nativeRequestType
        || result.state === 'available' && (result.nativeMessageId !== turn.nativeMessageId || result.generation !== runtime.generation || !result.qualified || result.path !== 'live_callback' || result.reason !== 'live_callback' || result.nativeTurnId !== undefined)) {
        return unavailableNativeResponse(session, query, 'identity_mismatch')
      }
      return result
    },
    async capabilities() {
      const q = options.qualification
      return { provider: harness, providerVersion: q.cliVersion, persistentSessions: q.basicTurns, reconnect: q.resume,
        sameRequestResponses: Boolean(q.interactions && options.interactionPort), cancellation: false, history: q.history, configurationInspection: true,
        mcpDetection: true, supportedInteractionKinds: q.interactions && options.interactionPort ? [...(options.supportedInteractionKinds ?? ['permission'])] : [] }
    },
    async refreshInspectionCredentials(start, servers, signal) {
      signal?.throwIfAborted()
      if (options.appMcpAccess !== 'management') throw new HarnessExecutionError('CLAUDE_MANAGEMENT_MCP_FORBIDDEN', 'This owner has no management MCP credential authority.')
      if (!prepared) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_REQUIRED', 'Credential delivery requires the existing inspected SDK query.')
      const inspected = prepared
      const runtime = await inspected.opening
      if (runtime.active || runtime.session || runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_ALREADY_STARTED', 'Pre-input credential delivery cannot mutate an active/native session.')
      if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Credential refresh cannot overlap another owned SDK control operation.')
      delete runtime.httpCredentialAcknowledgement
      delete runtime.credentialServers
      const withoutCredentials = (value: NativeSessionStart): string => {
        const variables = { ...value.environment?.variables }
        for (const key of options.credentialEnvironmentVariables ?? ['GRAPHQL_MCP_TOKEN']) delete variables[key]
        const agentId = value.environment?.agentId ?? (value.kind === 'operator' ? value.configuration.operatorId : value.request.configuration.agentId)
        return JSON.stringify({ ...value, environment: { agentId, variables } })
      }
      const original = JSON.parse(inspected.identity) as NativeSessionStart
      if (withoutCredentials(original) !== withoutCredentials(start)) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'Credential delivery changed the accepted owner/configuration or noncredential environment.')
      const configured = options.sdkOptions.mcpServers && typeof options.sdkOptions.mcpServers === 'object' ? options.sdkOptions.mcpServers as Record<string, unknown> : {}
      const topology = (entries: Readonly<Record<string, unknown>>) => JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
        const config = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        const { headers: rawHeaders, env: rawEnv, ...scope } = config
        const headers = rawHeaders && typeof rawHeaders === 'object' ? Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => key.toLowerCase() !== 'authorization')) : {}
        const env = rawEnv && typeof rawEnv === 'object' ? { ...rawEnv as Record<string, unknown> } : {}
        for (const key of options.credentialEnvironmentVariables ?? ['GRAPHQL_MCP_TOKEN']) delete env[key]
        return [name, { ...scope, headers, env }]
      }))
      if (topology(configured) !== topology(servers)) throw new HarnessExecutionError('CLAUDE_MCP_SCOPE_CONFLICT', 'Credential delivery changed accepted SDK server names, endpoints, commands or arguments.')
      const managedName = options.expectedMcp?.serverName ?? 'graphql'
      for (const [name, config] of Object.entries(configured)) if (name !== managedName && JSON.stringify(config) !== JSON.stringify(servers[name])) {
        throw new HarnessExecutionError('CLAUDE_MCP_SCOPE_CONFLICT', 'Credential delivery cannot refresh unrelated native MCP servers.')
      }
      const snapshot = await deliverCredentials(runtime, start, servers, signal)
      inspected.identity = JSON.stringify(start) // Only after actual SDK update ACK, never by mutating spawned options/env.
      return snapshot
    },
    async prepareInspection(start, signal) {
      const runtime = await prepareRuntime(start, signal)
      signal?.throwIfAborted()
      if (!runtime.sdk.mcpServerStatus) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK MCP control status is unavailable.')
      const rows = await ownedControl(runtime, () => runtime.sdk.mcpServerStatus!(), signal)
      signal?.throwIfAborted()
      if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query closed during inspection.')
      return decodeClaudeMcpControl(rows, runtime.generation, now(), inspectionCredentials(runtime))
    },
    async inspectMcp(signal): Promise<McpDetection> {
      if (!prepared && !options.inspectionStart) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_REQUIRED', 'An admitted SDK inspection context must be supplied.')
      const start = !prepared && options.inspectionStart ? await options.inspectionStart() : undefined
      const runtime = start ? await prepareRuntime(start, signal) : await prepared!.opening
      if (!runtime.sdk.mcpServerStatus) throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The actual SDK MCP control status is unavailable.')
      const rows = await ownedControl(runtime, () => runtime.sdk.mcpServerStatus!(), signal)
      signal?.throwIfAborted()
      if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The owned SDK query closed during inspection.')
      return claudeMcpDetection(decodeClaudeMcpControl(rows, runtime.generation, now(), inspectionCredentials(runtime)), options.expectedMcp ?? { serverName: 'graphql' })
    },
    async createSession() {
      throw new HarnessExecutionError('CLAUDE_INITIAL_TURN_REQUIRED', 'Claude reports a native session only after first input; use the admitted atomic initial-turn lifecycle.')
    },
    startInitialTurn(start, input, signal) {
      signal?.throwIfAborted()
      qualified('basicTurns')
      if (disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
      if (start.correlationId && start.correlationId !== input.clientCorrelationId) throw new HarnessExecutionError('CLAUDE_INITIAL_CORRELATION_MISMATCH', 'Initial native input differs from the admitted session correlation.')
      if (input.onSubmitted && !input.onMessageSubmitted) throw new HarnessExecutionError('CLAUDE_MESSAGE_RECEIPT_REQUIRED', 'Initial Claude input requires a truthful native message receipt, not a native-turn alias.')
      const identity = JSON.stringify({ start, prompt: input.prompt, correlationId: input.clientCorrelationId })
      const previous = initialTurns.get(input.clientCorrelationId)
      if (previous) {
        if (previous.identity !== identity) throw new HarnessExecutionError('CLAUDE_CREATION_IDENTITY_CONFLICT', 'The initial input belongs to another accepted scope.')
        return subscribe(previous.turn, signal)
      }
      if (initialTurns.size >= 128) throw new HarnessExecutionError('CLAUDE_CREATION_LIMIT', 'Resolve existing initial turn attempts before allocating more.')
      const turn = createTurn(input)
      const opening = open(start, undefined, signal, { turn, onSessionObserved: input.onSessionObserved })
      initialTurns.set(input.clientCorrelationId, { identity, turn, opening })
      void opening.catch((error: unknown) => turn.events.close(error)) // An uncertain initial offer is never another create/replay.
      return subscribe(turn, signal)
    },
    async attachSession(session, start, signal) {
      signal?.throwIfAborted()
      if (session.harness !== harness || session.providerVersion !== options.qualification.cliVersion) throw new HarnessExecutionError('CLAUDE_SESSION_MISMATCH', 'Persisted Claude installation identity differs.')
      const existing = resident.get(session.nativeSessionId)
      return existing?.session ?? open(start, session, signal)
    },
    startTurn(session, rawInput, signal) {
      qualified('basicTurns')
      signal?.throwIfAborted()
      const runtime = runtimeFor(session)
      if (runtime.failure) throw runtime.failure
      if (runtime.closed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned native output stream is closed.')
      if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
      if (runtime.active) throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'A Claude message is still active or uncertain; no second prompt may be offered.')
      if (runtime.turns.has(rawInput.clientCorrelationId) || runtime.restoredReceipts.has(rawInput.clientCorrelationId)) throw new HarnessExecutionError('CLAUDE_PROMPT_REPLAY_FORBIDDEN', 'This correlation was already offered; use read-only reconciliation.')
      const input = rawInput as ClaudeMessageTurnInput
      if (input.onSubmitted && !input.onMessageSubmitted) throw new HarnessExecutionError('CLAUDE_MESSAGE_RECEIPT_REQUIRED', 'Claude has native message receipts; this caller requires a native-turn receipt.')
      const turn = createTurn(input)
      runtime.turns.set(turn.correlationId, turn)
      runtime.active = turn
      // Subscribe before offering. A returned iterable does not fabricate admission.
      void runtime.sdk.offer({ promptUuid: turn.promptUuid, content: input.prompt }, signal).catch((error: unknown) => {
        turn.events.close(error)
        runtime.failure = error
      })
      return subscribe(turn, signal)
    },
    async forkSession(source, start, signal) {
      qualified('fork')
      signal?.throwIfAborted()
      const cwd = start.kind === 'operator' ? start.workingDirectory : start.request.workingDirectory
      if (cwd !== options.scope.cwd || source.harness !== harness || source.providerVersion !== options.qualification.cliVersion) throw new HarnessExecutionError('CLAUDE_FORK_SCOPE_MISMATCH', 'Claude fork scope differs from the pinned source.')
      const key = start.kind === 'operator' ? start.correlationId : start.request.executionId
      const identity = JSON.stringify({ source, start })
      const previous = forks.get(key)
      if (previous) {
        if (previous.identity !== identity) throw new HarnessExecutionError('CLAUDE_FORK_IDENTITY_CONFLICT', 'The fork request belongs to another exact native source.')
        return previous.promise
      }
      if (forks.size >= 128) throw new HarnessExecutionError('CLAUDE_FORK_LIMIT', 'Resolve existing Claude fork attempts before allocating more.')
      const promise = (async () => {
        const fork = await options.runner.fork({ ...options.scope, nativeSessionId: source.nativeSessionId }, options.scope, signal)
        return open(start, { harness, providerVersion: options.qualification.cliVersion, nativeSessionId: fork.nativeSessionId }, signal)
      })()
      forks.set(key, { identity, promise })
      return promise
    },
    async pending(session, signal) {
      runtimeFor(session)
      return options.interactionPort?.pending(session, signal)
    },
    async respond(session, requestId, option, signal) {
      runtimeFor(session)
      if (!options.qualification.interactions || !options.interactionPort) throw new HarnessExecutionError('CLAUDE_RESPONSE_UNQUALIFIED', 'No live qualified native callback is bound to this response.')
      return options.interactionPort.respond(session, requestId, option, signal)
    },
    stopAutomaticResponses(session) { options.interactionPort?.stopAutomaticResponses?.(session); options.cancelPendingRequests?.() },
    async cancel() { return false },
    async history(session): Promise<NativeHistory> {
      const runtime = runtimeFor(session)
      return { events: [...runtime.events], pendingInteractions: [...(options.pendingInteractions?.(session) ?? [])], firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.nextSequence, nextSequence: runtime.nextSequence }
    },
    async reconcile(session, correlationId, signal): Promise<NativeHistory> {
      const runtime = runtimeFor(session)
      const turn = runtime.turns.get(correlationId)
      if (!turn && options.qualification.history) {
        const expectedUuid = claudePromptUuid(correlationId)
        let accepted = false
        for (let page = 0; page < 8; page += 1) {
          signal?.throwIfAborted()
          const rows = await options.runner.history({ ...options.scope, nativeSessionId: session.nativeSessionId }, options.scope, signal, { offset: page * 256, limit: 256 })
          if (resident.get(session.nativeSessionId) !== runtime || disposed) throw new HarnessExecutionError('CLAUDE_SESSION_UNAVAILABLE', 'The owned native history reader closed during reconciliation.')
          accepted = rows.some((value) => {
            const frame = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            return frame.type === 'user' && frame.uuid === expectedUuid && frame.session_id === session.nativeSessionId && frame.parent_tool_use_id == null
          })
          if (accepted || rows.length < 256) break
        }
        if (accepted) {
          if (!runtime.restoredReceipts.has(correlationId) && runtime.restoredReceipts.size >= 256) throw new HarnessExecutionError('CLAUDE_RECOVERY_WINDOW_EXHAUSTED', 'The bounded native receipt recovery window is full.')
          runtime.restoredReceipts.set(correlationId, { kind: 'message', nativeSessionId: session.nativeSessionId, nativeMessageId: expectedUuid, clientCorrelationId: correlationId })
        }
      }
      const restored = runtime.restoredReceipts.get(correlationId)
      return { ...(restored ? { correlationId, nativeSubmission: restored } : {}), events: [...runtime.events].filter((event) => event.payload.clientCorrelationId === correlationId), pendingInteractions: [...(options.pendingInteractions?.(session) ?? [])].filter((pending) => (pending.turn as typeof pending.turn & { nativeMessageId?: string }).nativeMessageId === (turn?.nativeMessageId ?? restored?.nativeMessageId)),
        ...(turn?.nativeMessageId ? { correlationId, nativeSubmission: { kind: 'message' as const, nativeSessionId: session.nativeSessionId, nativeMessageId: turn.nativeMessageId, clientCorrelationId: correlationId } } : {}),
        ...(turn?.assistantMessageId ? { nativeMessageId: turn.assistantMessageId } : {}),
        ...(turn?.terminal && turn.nativeMessageId ? { terminalResult: turn.terminal, terminalTurn: { correlationId, providerId: turn.nativeMessageId, result: turn.terminal } } : {}) }
    },
    async reconcileResponse(session, response, signal) { return options.interactionPort?.reconcileResponse?.(session, response, signal) ?? manager.history(session) },
    async close(session) {
      const runtime = resident.get(session.nativeSessionId)
      if (!runtime) return
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      if ([...resident.values()].every((entry) => entry.closed)) rejectCallbackWaiters()
      await runtime.sdk.close()
      await runtime.pumping
      resident.delete(session.nativeSessionId)
      all.delete(runtime)
    },
    async closeForRestart(session) { return runtimeFor(session).sdk.closeForRestart() },
    async dispose() {
      disposed = true
      rejectCallbackWaiters()
      for (const runtime of all) { runtime.closed = true; delete runtime.httpCredentialAcknowledgement }
      await options.runner.dispose()
      await Promise.all([...all].map((runtime) => runtime.pumping))
      resident.clear()
      all.clear()
    },
  }
  return manager
}
