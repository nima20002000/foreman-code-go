import { isWorkflowStart, sessionStartDirectory, sessionStartOwner, sessionStartCorrelation, sessionStartConfiguration,
  sessionStartSystemPrompt } from '../sessionStart.js'
import { claudeCompactionResultMatches } from './compactionResults.js'
import { recoveredClaudeCompaction } from './compactionHistory.js'
import { z } from 'zod'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { claudeContextSnapshot, claudeSessionEnvironment, claudeContextProfiles, ClaudePreferenceError } from './sessionControls.js'
import type { CompactionState, ContextSnapshot, SessionPreferences } from '@foreman-code/contracts'
import { claudeNativeEvent } from './nativeEvents.js'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appMcpServerName } from '../appMcpLauncher.js'
import { appMcpTokenEnvironment, isDatabaseCredentialVariable } from '../secrets.js'
import { createClaudeEventNormalizer } from './normalization.js'
import { agentInstructionBundle } from '../../skills/instructions.js'
import { childHistoryCursor, childHistoryEvent, encodeChildHistoryCursor } from '../../subagents/nativeReadback.js'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AgentHarness, ExecutionResult, McpDetection, NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import type { NativeMcpHttpCredentialAcknowledgement } from '../mcpDetection.js'
import { unavailableNativeResponse, type NativeResponseAvailability, type ResponseAvailabilityInspector } from '../responseAvailability.js'
import { claudeMcpDetection, decodeClaudeMcpControl, type ClaudeMcpInspection } from './mcpInspection.js'
import type { ClaudeResponseAvailabilityQuery, ClaudeLiveCallbackReader, ClaudeNativeCallbackContext, ClaudeCallbackAuthority, ClaudePendingNotification } from './callbackAvailability.js'
import { ClaudeInputNotDeliveredError } from './port.js'
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
  observeSubagentHook?(sessionId: string, agentId: string, agentType: string, status: 'running' | 'unknown'): void
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
  observerLease?: symbol
  replyObserved: boolean
  resultBeforeReply: boolean
  events: ClaudeBoundedQueue<NativeHarnessEvent>
  terminal?: ExecutionResult
  nativeMessageId?: string
  assistantMessageId?: string
  authority?: ClaudeCallbackAuthority
  cancelRequested?: boolean
}
interface Runtime {
  startingTurn?: Turn | undefined
  start: NativeSessionStart
  models?: Array<{ value: string; resolvedModel?: string | undefined; displayName?: string | undefined }>
  defaultModelCapacity?: number
  modelCapacity?: number
  selectedModel?: string
  appliedPreferences?: SessionPreferences
  commands?: string[]
  context?: ContextSnapshot
  compaction?: { state: CompactionState; promptUuid: string; boundary: boolean;
    progress: import('../port.js').NativeCompactInput['onProgress']; finish(): void; fail(error: unknown): void } | undefined

  sdk: ClaudeSdkSession
  generation: string
  currentAuthorizationScope: string
  httpCredentialAcknowledgement?: NativeMcpHttpCredentialAcknowledgement
  credentialServers?: Readonly<Record<string, unknown>>
  replacingForResume?: boolean
  closed: boolean
  session?: NativeSessionReference
  nativeProviderVersion?: string
  events: NativeHarnessEvent[]
  nextSequence: number
  turns: Map<string, Turn>
  messageOwners: Map<string, Turn>
  toolOwners: Map<string, Turn>
  restoredReceipts: Map<string, ClaudeMessageSubmission>
  historyScanOffsets: Map<string, number>
  retiredTurns: boolean
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

/** A caller's signal bounds native startup only; it never owns the resident query afterwards. */
function startupSignal(signal?: AbortSignal): { signal?: AbortSignal; release(): void } {
  if (!signal) return { release() {} }
  const controller = new AbortController()
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward(); else signal.addEventListener('abort', forward, { once: true })
  return { signal: controller.signal, release: () => signal.removeEventListener('abort', forward) }
}

function sameJson(left: string, right: string): boolean {
  return isDeepStrictEqual(JSON.parse(left), JSON.parse(right))
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
  pendingInteractions?: (session: NativeSessionReference) => readonly import('@foreman-code/contracts').PendingNativeInteraction[]
  responseDeliveries?: (session: NativeSessionReference) => NonNullable<NativeHistory['responseDeliveries']>
    | Promise<NonNullable<NativeHistory['responseDeliveries']>>
  messageSubmitted?: (correlationId: string) => Promise<boolean>
}): ClaudeNativeSessionManager {
  const configuredServers = options.sdkOptions.mcpServers && typeof options.sdkOptions.mcpServers === 'object'
    ? options.sdkOptions.mcpServers as Record<string, unknown> : {}
  const expectedMcp = options.expectedMcp ?? { serverName: appMcpServerName(configuredServers) }
  // The provider enum addition is integrated by the designated shared-contract writer.
  const harness = 'claude' as AgentHarness
  const resident = new Map<string, Runtime>()
  const retired = new Map<string, Runtime>()
  const all = new Set<Runtime>()
  const callbackWaiters = new Set<{ toolUseId: string; nativeSessionId?: string; signal: AbortSignal; abort(): void; resolve(context: ClaudeNativeCallbackContext): void; reject(error: unknown): void }>()
  const forks = new Map<string, { identity: string; promise: Promise<NativeSessionReference> }>()
  const initialTurns = new Map<string, { identity: string; turn: Turn; opening: Promise<NativeSessionReference> }>()
  let prepared: { identity: string; opening: Promise<Runtime> } | undefined
  const rolloverSources = new Map<string, Runtime>()
  const rollovers = new Map<string, Promise<NativeSessionReference>>()
  let sessionPreferences: SessionPreferences | undefined
  let disposed = false
  const now = options.now ?? (() => new Date().toISOString())
  function queryOptions(start: NativeSessionStart, preferences = SessionPreferencesSchema.parse({})) {
    const environment = { ...(options.sdkOptions.env as Record<string, string> | undefined),
      ...start.environment?.variables }
    if (Object.keys(environment).some(isDatabaseCredentialVariable)) {
      throw new HarnessExecutionError('CLAUDE_ENVIRONMENT_INVALID',
        'The Claude environment cannot contain database credentials.')
    }
    const scoped = claudeSessionEnvironment(appMcpTokenEnvironment(environment), preferences)
    const instructions = agentInstructionBundle(sessionStartConfiguration(start))
    const systemPrompt = sessionStartSystemPrompt(start)?.value.text
    if (!instructions && !systemPrompt) return { ...options.sdkOptions, env: scoped }
    const base = options.sdkOptions.systemPrompt
    if (base !== undefined && typeof base !== 'string') {
      throw new HarnessExecutionError('CLAUDE_SYSTEM_PROMPT_UNSUPPORTED',
        'Persistent Agent instructions require a string SDK system prompt.')
    }
    return { ...options.sdkOptions, env: scoped,
      systemPrompt: [base, systemPrompt, instructions?.text].filter(Boolean).join('\n\n') }
  }
  function qualified(capability: 'basicTurns' | 'resume' | 'fork' | 'history') {
    if (!options.qualification[capability]) throw new HarnessExecutionError('CLAUDE_CAPABILITY_UNQUALIFIED', `Claude ${capability} has not been qualified on the selected installation.`)
  }
  function runtimeFor(session: NativeSessionReference, access: { readOnly?: boolean } = {}): Runtime {
    const runtime = resident.get(session.nativeSessionId)
      ?? (access.readOnly ? rolloverSources.get(session.nativeSessionId) ?? retired.get(session.nativeSessionId) : undefined)
    if (!runtime || session.harness !== harness || session.providerVersion !== runtime.session?.providerVersion) throw new HarnessExecutionError('CLAUDE_SESSION_UNAVAILABLE', 'The exact owned Claude session is not resident.')
    return runtime
  }
  async function record(runtime: Runtime, type: string, payload: Record<string, unknown>, turn?: Turn): Promise<NativeHarnessEvent> {
    const event = { type, payload: turn ? { ...payload, clientCorrelationId: turn.correlationId } : payload, sequence: runtime.nextSequence++, occurredAt: now() }
    runtime.events.push(event)
    if (runtime.events.length > 256) runtime.events.shift()
    if (turn?.observing) await turn.events.offer(event)
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
      await record(runtime, 'message.submitted', { nativeSessionId: observation.nativeSessionId, nativeMessageId: turn.promptUuid, clientCorrelationId: turn.correlationId,
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
  function canonicalStart(start: NativeSessionStart): NativeSessionStart {
    if (!start.environment) return start
    const variables = { ...start.environment.variables }
    const token = readProductEnvironment(variables, 'MCP_TOKEN')
    for (const name of APP_MCP_TOKEN_NAMES) delete variables[name]
    if (token !== undefined) variables.FOREMAN_CODE_MCP_TOKEN = token
    return { ...start, environment: { ...start.environment, variables } }
  }
  function authorizationScope(start: NativeSessionStart): string {
    const identity = ['claude-mcp-authorization-v1', options.scope, canonicalStart(start)]
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  }
  function sessionContext(start: NativeSessionStart) {
    start = canonicalStart(start)
    if (start.kind === 'agent-chat') return { kind: start.kind, configuration: start.configuration,
      conversationId: start.conversationId, workflowId: start.workflowId, workflowNodeId: start.workflowNodeId,
      cwd: start.workingDirectory, environment: start.environment, systemPrompt: start.systemPrompt }
    return start.kind === 'operator'
      ? { kind: start.kind, configuration: start.configuration,
        cwd: start.workingDirectory, environment: start.environment }
      : { kind: 'workflow', request: start.request, environment: start.environment }
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
    const token = readProductEnvironment(start.environment?.variables ?? {}, 'MCP_TOKEN')
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
    const managedName = expectedMcp.serverName
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
  async function inspectSettings(runtime: Runtime) {
    const initialization = await runtime.sdk.initializationResult!()
    const models = z.object({ models: z.array(z.object({ value: z.string(),
      resolvedModel: z.string().optional(), displayName: z.string().optional() }).passthrough()).optional() }).passthrough().parse(initialization)
    runtime.models = models.models ?? []
    if (!runtime.sdk.getContextUsage) return
    const usage = z.object({ rawMaxTokens: z.number().positive(), maxTokens: z.number().positive(),
      totalTokens: z.number().nonnegative(), model: z.string(), isAutoCompactEnabled: z.boolean() })
      .passthrough().parse(await runtime.sdk.getContextUsage({ detail: 'summary' }))
    runtime.defaultModelCapacity ??= usage.rawMaxTokens
    runtime.modelCapacity = usage.rawMaxTokens
    runtime.selectedModel = usage.model
    if (runtime.session) runtime.context = { nativeSessionId: runtime.session.nativeSessionId,
      model: String(options.sdkOptions.model ?? ''), sequence: runtime.nextSequence, generation: runtime.generation,
      observedAt: now(), source: 'claude', accuracy: 'native', usedTokens: usage.totalTokens,
      capacityTokens: usage.rawMaxTokens, lifetimeTokens: null, cost: null, stale: false }
    if (runtime.appliedPreferences?.autoCompact === 'off' && usage.isAutoCompactEnabled
      || runtime.appliedPreferences?.autoCompact === 'on' && !usage.isAutoCompactEnabled) {
      throw new HarnessExecutionError('CLAUDE_SETTINGS_NOT_APPLIED', 'Native automatic compaction differs from the requested setting.')
    }
  }
  async function applyPreferences(runtime: Runtime, preferences: SessionPreferences, signal?: AbortSignal) {
    if (JSON.stringify(runtime.appliedPreferences) === JSON.stringify(preferences)) return
    if (runtime.active || runtime.controlPending || runtime.compaction
      || runtime.session && options.pendingInteractions?.(runtime.session).length) {
      throw new HarnessExecutionError('CLAUDE_SETTINGS_BUSY', 'Wait for the turn and its approvals before resuming settings.')
    }
    if (preferences.autoCompactTokens !== null && runtime.modelCapacity === undefined) {
      throw new ClaudePreferenceError('CLAUDE_MODEL_CAPACITY_UNKNOWN', 'Native model capacity could not be inspected.')
    }
    const profiles = claudeContextProfiles(runtime.models ?? [], String(options.sdkOptions.model ?? ''),
      runtime.defaultModelCapacity ?? null)
    const profile = profiles.find(entry => entry.id === preferences.contextProfile)
    if (preferences.contextProfile !== null && !profile) {
      throw new ClaudePreferenceError('CLAUDE_CONTEXT_PROFILE_INVALID', 'Choose a context profile offered by this model and account.')
    }
    const capacity = profile?.capacity ?? runtime.defaultModelCapacity
    if (preferences.autoCompactTokens !== null && capacity !== undefined && preferences.autoCompactTokens > capacity) {
      throw new ClaudePreferenceError('CLAUDE_BUDGET_TOO_LARGE', `The automatic budget exceeds this model’s ${capacity.toLocaleString()}-token context capacity.`)
    }
    runtime.controlPending = true
    runtime.replacingForResume = true
    const startup = startupSignal(signal)
    try {
      await runtime.sdk.close()
      await runtime.pumping
      runtime.closed = false
      delete runtime.failure
      runtime.generation = randomUUID()
      const start = runtime.start
      runtime.sdk = await options.runner.open({ scope: options.scope,
        options: { ...queryOptions(start, preferences), model: profile?.id ?? options.sdkOptions.model,
          mcpServers: runtime.credentialServers ?? options.sdkOptions.mcpServers },
        ...(runtime.session ? { resume: { ...options.scope, nativeSessionId: runtime.session.nativeSessionId } } : {}),
        ...(startup.signal ? { signal: startup.signal } : {}), onObservation: observation => observed(runtime, observation),
        ...(options.cancelPendingRequests ? { cancelPendingRequests: () => {
          if (!runtime.replacingForResume) options.cancelPendingRequests!()
        } } : {}),
      })
      runtime.appliedPreferences = structuredClone(preferences)
      runtime.pumping = pump(runtime)
      await inspectSettings(runtime)
      if (profile) {
        const base = (model: string) => model.replace(/\[(?:1m|200k)\]$/, '')
        const selected = runtime.models?.find(model => model.value === profile.id)
        const family = base(selected?.resolvedModel ?? profile.id)
        const aliases = runtime.models?.filter(model => base(model.resolvedModel ?? model.value) === family)
          .flatMap(model => [model.value, model.resolvedModel ?? model.value, model.displayName ?? model.value]) ?? []
        const actualModel = runtime.selectedModel ? base(runtime.selectedModel) : undefined
        const matchesModel = actualModel !== undefined && aliases.some(alias => base(alias) === actualModel)
        if (runtime.modelCapacity !== profile.capacity || !matchesModel) {
          throw new HarnessExecutionError('CLAUDE_CONTEXT_PROFILE_NOT_APPLIED',
            'Native model or context capacity differs from the selected profile.')
        }
      }
      if (runtime.credentialServers) {
        runtime.controlPending = false
        await deliverCredentials(runtime, start, runtime.credentialServers, signal)
      }
      if (prepared) prepared = { identity: prepared.identity, opening: Promise.resolve(runtime) }
    } catch (error) {
      delete runtime.appliedPreferences
      throw error
    } finally {
      startup.release()
      runtime.replacingForResume = false
      runtime.controlPending = false
    }
  }
  function makeRuntime(start: NativeSessionStart): Runtime {
    let resolveInit!: Runtime['resolveInit']
    let rejectInit!: Runtime['rejectInit']
    const initialized = new Promise<NativeSessionReference>((resolve, reject) => { resolveInit = resolve; rejectInit = reject })
    // The rejection is observed even if native startup fails before await initialized.
    void initialized.catch(() => undefined)
    const runtime = {
      start: structuredClone(start),
      generation: randomUUID(),
      currentAuthorizationScope: authorizationScope(start),
      closed: false,
      events: [],
      nextSequence: 0,
      turns: new Map(),
      messageOwners: new Map(),
      toolOwners: new Map(),
      restoredReceipts: new Map(),
      historyScanOffsets: new Map(),
      retiredTurns: false,
      initialized,
      resolveInit,
      rejectInit,
    } as unknown as Runtime
    if (options.decodeFactory) runtime.decode = options.decodeFactory(start)
    all.add(runtime)
    return runtime
  }
  async function prepareRuntime(start: NativeSessionStart, signal?: AbortSignal): Promise<Runtime> {
    signal?.throwIfAborted()
    if (disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
    const cwd = sessionStartDirectory(start)
    if (cwd !== options.scope.cwd) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'Inspection differs from the pinned working directory.')
    const nativeOptions = queryOptions(start)
    const identity = JSON.stringify(canonicalStart(start))
    if (prepared) {
      if (!sameJson(prepared.identity, identity)) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'The owned SDK query already has another immutable inspection context.')
      return prepared.opening
    }
    const runtime = makeRuntime(start)
    const startup = startupSignal(signal)
    const opening = (async () => {
      try {
        runtime.sdk = await options.runner.open({ scope: options.scope,
          options: nativeOptions,
          ...(startup.signal ? { signal: startup.signal } : {}), onObservation: (observation) => observed(runtime, observation),
          ...(options.cancelPendingRequests ? { cancelPendingRequests: () => { if (!runtime.replacingForResume) options.cancelPendingRequests!() } } : {}) })
        runtime.appliedPreferences = SessionPreferencesSchema.parse({})
        runtime.pumping = pump(runtime)
        if (!runtime.sdk.initializationResult) throw new HarnessExecutionError('CLAUDE_INIT_INSPECTION_UNAVAILABLE', 'The SDK initialization control result is unavailable.')
        await ownedControl(runtime, () => inspectSettings(runtime), signal)
        if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The inspected SDK query closed.')
        startup.release()
        return runtime
      } catch (error) {
        startup.release()
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
    const cwd = sessionStartDirectory(start)
    if (cwd !== options.scope.cwd) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'Claude working directory differs from the pinned scope.')
    const nativeOptions = queryOptions(start)
    const identity = JSON.stringify(canonicalStart(start))
    const inspected = prepared
    if (inspected && !sameJson(inspected.identity, identity)) {
      const previous = JSON.parse(inspected.identity) as Record<string, unknown>
      const current = JSON.parse(identity) as Record<string, unknown>
      const changed = ['kind', 'correlationId', 'request', 'environment', 'nativeTurnId', 'instructionsDelivered']
        .filter(key => !isDeepStrictEqual(previous[key], current[key]))
      throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT',
        `Input differs from the exact inspected owner/configuration/environment (${changed.join(', ')}).`)
    }
    const previous = inspected ? await inspected.opening : undefined
    if (previous?.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
    if (previous?.closed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned SDK query is closed.')
    if (resume && previous && (previous.session || previous.turns.size)) throw new HarnessExecutionError('CLAUDE_INSPECTION_ALREADY_STARTED', 'Resume cannot replace a query that already owns native input.')
    const retained = resume ? rolloverSources.get(resume.nativeSessionId) : undefined
    const credentialServers = resume ? previous?.credentialServers ?? retained?.credentialServers : undefined
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
    if (retained) {
      runtime.replacingForResume = true
      runtime.turns = new Map(retained.turns)
      runtime.restoredReceipts = new Map(retained.restoredReceipts)
      runtime.historyScanOffsets = new Map(retained.historyScanOffsets)
      runtime.retiredTurns = retained.retiredTurns
      runtime.events = [...retained.events]
      runtime.nextSequence = retained.nextSequence
    }
    if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
    if (runtime.closed || disposed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned SDK query is closed.')
    if (initial) {
      runtime.onSessionObserved = initial.onSessionObserved
      runtime.turns.set(initial.turn.correlationId, initial.turn)
    }
    if (resume) runtime.session = structuredClone(resume)
    all.add(runtime)
    const startup = startupSignal(signal)
    let offerStarted = false
    try {
      if (!runtime.sdk) runtime.sdk = await options.runner.open({
        scope: options.scope, options: nativeOptions,
        ...(startup.signal ? { signal: startup.signal } : {}),
        ...(resume ? { resume: { ...options.scope, nativeSessionId: resume.nativeSessionId } } : {}),
        onObservation: (observation) => observed(runtime, observation),
        ...(options.cancelPendingRequests ? { cancelPendingRequests: () => { if (!runtime.replacingForResume) options.cancelPendingRequests!() } } : {}),
      })
      runtime.appliedPreferences ??= SessionPreferencesSchema.parse({})
      runtime.pumping ??= pump(runtime)
      if (resume) {
        if (!runtime.sdk.initializationResult) throw new HarnessExecutionError('CLAUDE_INIT_INSPECTION_UNAVAILABLE', 'The pinned SDK must acknowledge exact-session resume initialization.')
        await ownedControl(runtime, () => inspectSettings(runtime), signal)
        if (credentialServers) {
          const snapshot = await deliverCredentials(runtime, start, credentialServers, signal)
          const expected = expectedMcp
          const detection = claudeMcpDetection(snapshot, { ...expected,
            ...(snapshot.httpCredentialAcknowledgement ? { url: snapshot.httpCredentialAcknowledgement.endpoint } : {}) })
          if (detection.state !== 'connected' || detection.endpointMatches === false
            || snapshot.httpCredentialAcknowledgement && detection.credentialArrangement?.kind !== 'scoped_http_header') {
            throw new HarnessExecutionError('CLAUDE_RESUME_MCP_UNAVAILABLE', 'The resumed SDK query did not establish its scoped MCP connection before input.')
          }
        }
        if (inspected) prepared = { identity, opening: Promise.resolve(runtime) }
        if (resident.has(resume.nativeSessionId)) throw new Error('Claude native session is already leased to another runtime')
        resident.set(resume.nativeSessionId, runtime)
        runtime.resolveInit(runtime.session!)
      }
      if (!resume && !previous && runtime.sdk.initializationResult) await inspectSettings(runtime)
      if (runtime.failure) throw runtime.failure
      await applyPreferences(runtime, start.sessionPreferences ?? sessionPreferences ?? SessionPreferencesSchema.parse({}), signal)
      if (initial) {
        runtime.active = initial.turn
        if (initial.turn.input.sessionMode) {
          if (runtime.sdk.setPermissionMode) {
            await runtime.sdk.setPermissionMode(initial.turn.input.sessionMode === 'plan' ? 'plan' : 'default')
          } else if (initial.turn.input.sessionMode === 'plan') {
            throw new ClaudePreferenceError('CLAUDE_PLAN_UNAVAILABLE', 'The owned SDK mode control is unavailable.')
          }
          await initial.turn.input.onSettingsApplied?.()
        }
        offerStarted = true
        await runtime.sdk.offer({ promptUuid: initial.turn.promptUuid, content: initial.turn.input.prompt }, signal)
      }
      const timer = setTimeout(() => runtime.rejectInit(new HarnessExecutionError('CLAUDE_INIT_TIMEOUT', 'Claude initialization did not provide an exact native session.')), options.initializationTimeoutMs ?? 10_000)
      try {
        const session = await runtime.initialized
        if (retained) runtime.replacingForResume = false
        return session
      } finally {
        clearTimeout(timer)
        startup.release()
      }
    } catch (error) {
      startup.release()
      let failure = runtime.failure ?? error
      if (initial && (!offerStarted || error instanceof ClaudeInputNotDeliveredError)) {
        failure = Object.assign(failure instanceof Error ? failure : new Error('Claude input was not offered.'),
          { certainty: 'definite' as const, deliveryState: 'not-delivered' as const })
      }
      runtime.rejectInit(failure)
      await runtime.sdk?.close()
      await runtime.pumping
      if (runtime.session && resident.get(runtime.session.nativeSessionId) === runtime) resident.delete(runtime.session.nativeSessionId)
      all.delete(runtime)
      initial?.turn.events.close(failure)
      throw failure
    }
  }
  async function pump(runtime: Runtime): Promise<void> {
    try {
      for await (const output of runtime.sdk.output) {
        const frame = output.raw && typeof output.raw === 'object' ? output.raw as Record<string, unknown> : {}
        if (frame.type === 'system' && frame.subtype === 'init') {
          runtime.commands = Array.isArray(frame.slash_commands) ? frame.slash_commands.filter((value): value is string => typeof value === 'string') : []
          if (typeof frame.claude_code_version !== 'string' || !frame.claude_code_version || frame.cwd !== options.scope.cwd) {
            throw new HarnessExecutionError('CLAUDE_CONTRACT_UNSUPPORTED', `Claude Code ${String(frame.claude_code_version ?? options.qualification.cliVersion)} does not satisfy the init version/cwd contract.`)
          }
          runtime.nativeProviderVersion = frame.claude_code_version
        }
        if (!runtime.session && frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string' && frame.session_id.length > 0) {
          runtime.session = { harness, providerVersion: String(frame.claude_code_version), nativeSessionId: frame.session_id }
          if (resident.has(frame.session_id)) throw new Error('Claude native session is already leased to another runtime')
          resident.set(frame.session_id, runtime)
          await runtime.onSessionObserved?.(runtime.session)
          await record(runtime, 'session.idle', { nativeSessionId: frame.session_id })
          runtime.resolveInit(runtime.session)
        }
        if (runtime.session) {
          const context = claudeContextSnapshot(frame, runtime.session.nativeSessionId,
            String(options.sdkOptions.model ?? ''), runtime.nextSequence)
          if (context) runtime.context = { ...context, generation: runtime.generation,
            capacityTokens: runtime.modelCapacity ?? null }
        }
        if (frame.type === 'system' && frame.subtype === 'compact_boundary' && runtime.session
          && frame.session_id === runtime.session.nativeSessionId) {
          const metadata = frame.compact_metadata as { pre_tokens?: number; trigger?: string } | undefined
          if (runtime.context) runtime.context = { ...runtime.context, stale: true }
          await record(runtime, 'session.compaction', { nativeSessionId: runtime.session.nativeSessionId,
            nativeOperationId: typeof frame.uuid === 'string' ? frame.uuid : null,
            trigger: metadata?.trigger ?? 'unknown', beforeTokens: metadata?.pre_tokens ?? null }, runtime.active)
          if (runtime.compaction && metadata?.trigger === 'manual') {
            runtime.compaction.boundary = true
            runtime.compaction.state = { ...runtime.compaction.state,
              nativeOperationId: typeof frame.uuid === 'string' ? frame.uuid : null,
              message: 'Compaction boundary observed. Waiting for the command result.',
              beforeTokens: metadata?.pre_tokens ?? null }
            await runtime.compaction.progress(runtime.compaction.state)
          }
        }
        if (frame.type === 'result' && runtime.context && frame.session_id === runtime.session?.nativeSessionId) {
          const modelUsage = frame.modelUsage as Record<string, { contextWindow?: number; inputTokens?: number; outputTokens?: number }> | undefined
          const usage = modelUsage?.[String(options.sdkOptions.model ?? '')]
          if (usage?.contextWindow && usage.contextWindow > 0) runtime.context = { ...runtime.context,
            capacityTokens: usage.contextWindow }
        }
        if (runtime.compaction && runtime.session
          && claudeCompactionResultMatches(frame, runtime.session.nativeSessionId, runtime.compaction.promptUuid)) {
          const control = runtime.compaction
          if (frame.is_error === true) control.state = { ...control.state, status: 'failed', message: 'Claude rejected compaction.' }
          else if (control.boundary) control.state = { ...control.state, status: 'completed', message: 'Context compacted.' }
          else control.state = { ...control.state,
            status: 'no-op', message: 'Claude completed the command without a compaction boundary.' }
          control.finish()
          continue
        }
        const patch = frame.patch && typeof frame.patch === 'object' ? frame.patch as Record<string, unknown> : {}
        if (frame.type === 'system' && (frame.subtype === 'task_started' && frame.is_backgrounded === true
          || frame.subtype === 'task_updated' && patch.is_backgrounded === true
          || frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks) && frame.tasks.length > 0)
          || frame.type === 'result' && (frame.deferred_tool_use != null || ['tool_deferred', 'background_requested'].includes(String(frame.terminal_reason)))) {
          await record(runtime, 'claude.background.unsupported', { nativeSessionId: frame.session_id,
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
        if (rootOwner?.submitted && !rootOwner.terminal && frame.type === 'assistant' && frame.parent_tool_use_id == null) {
          if (messageId) rootOwner.assistantMessageId = messageId
          else if (typeof frame.uuid === 'string') rootOwner.assistantMessageId = frame.uuid
        }
        const knownResult = typeof frame.is_error === 'boolean' && typeof frame.uuid === 'string' && frame.uuid.length > 0
          && ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(String(frame.subtype))
        const successfulResult = frame.subtype === 'success' && frame.is_error === false
        const command = matched?.input.prompt.match(/^\/([a-z]+)(?:\s|$)/u)?.[1]
        const localCommandResult = command !== undefined && frame.local_command === command
          && options.sdkOptions.verbatimPrompts !== true
        if (matched && frame.type === 'result' && successfulResult && !matched.replyObserved && !localCommandResult) {
          matched.resultBeforeReply = true
        }
        const terminalAdmissible = knownResult && matched?.submitted
          && (!successfulResult || localCommandResult || matched.replyObserved && !matched.resultBeforeReply)
        const decoded = runtime.decode?.(output.raw) ?? []
        if (frame.type === 'result' && !terminalAdmissible) {
          // Native consumption is a receipt, not proof that a queued wake's result answers this request.
          await record(runtime, 'claude.result.unattributed', { nativeSessionId: frame.session_id, nativeResult: output.raw }, matched)
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
            const payload = frame.type === 'result' && event.type === 'claude.result'
              ? { ...event.payload, nativeResult: output.raw } : event.payload
            await record(runtime, event.type, payload, frame.type === 'result' ? matched : eventOwner?.submitted ? eventOwner : undefined)
          }
        }
        if (matched && !matched.terminal && terminalAdmissible && frame.type === 'result') {
          matched.terminal = successfulResult
            ? { outcome: 'succeeded', output: typeof frame.result === 'string' ? frame.result : '' }
            : matched.cancelRequested ? { outcome: 'canceled' }
            : { outcome: 'failed', error: { code: 'CLAUDE_NATIVE_RESULT_ERROR', message: Array.isArray(frame.errors) ? frame.errors.join('\n') : 'Claude returned an error result.', retryable: false } }
          let persistenceFailure: { error: unknown } | undefined
          try {
            await matched.input.onTerminal?.({
              submission: { kind: 'message', nativeSessionId: runtime.session!.nativeSessionId,
                nativeMessageId: matched.nativeMessageId!, clientCorrelationId: matched.correlationId },
              result: matched.terminal,
              ...(matched.assistantMessageId ? { nativeMessageId: matched.assistantMessageId } : {}),
              history: {
                correlationId: matched.correlationId,
                nativeSubmission: { kind: 'message', nativeSessionId: runtime.session!.nativeSessionId,
                  nativeMessageId: matched.nativeMessageId!, clientCorrelationId: matched.correlationId },
                ...(matched.assistantMessageId ? { nativeMessageId: matched.assistantMessageId } : {}),
                terminalResult: matched.terminal,
                terminalTurn: { correlationId: matched.correlationId, providerId: matched.nativeMessageId!,
                  result: matched.terminal },
                events: runtime.events.filter(event => event.payload.clientCorrelationId === matched.correlationId),
                pendingInteractions: [...(options.pendingInteractions?.(runtime.session!) ?? [])],
                responseDeliveries: [...(await options.responseDeliveries?.(runtime.session!) ?? [])],
              },
            })
          } catch (error) {
            // Keep the result resident so the caller can retry saving it before native disposal.
            persistenceFailure = { error }
            matched.observing = false
          }
          await record(runtime, 'turn.completed', { nativeSessionId: frame.session_id, nativeMessageId: matched.nativeMessageId, clientCorrelationId: matched.correlationId, result: matched.terminal,
            ...(typeof frame.uuid === 'string' ? { source: { eventId: frame.uuid } } : {}) }, matched)
          matched.events.close(persistenceFailure?.error)
          matched.observing = false
          if (active === matched) delete runtime.active
        }
      }
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      if (!runtime.session && !runtime.replacingForResume) runtime.rejectInit(new Error('Claude stream ended before native initialization'))
      runtime.compaction?.fail(new Error('Claude output closed before compaction completed'))
      runtime.active?.events.close(new Error('Claude stream ended without an exact result; submission remains uncertain'))
    } catch (error) {
      runtime.failure = error
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      await record(runtime, 'claude.session.failed', {
        nativeSessionId: runtime.session?.nativeSessionId,
        error: { code: 'CLAUDE_NATIVE_STREAM_ERROR',
          message: error instanceof Error ? error.message : 'The native Claude query failed.' },
      })
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
  function coalesceText(prior: NativeHarnessEvent, next: NativeHarnessEvent): NativeHarnessEvent | undefined {
    if (prior.type !== 'claude.text' || next.type !== 'claude.text'
      || prior.payload.itemId !== next.payload.itemId
      || prior.payload.clientCorrelationId !== next.payload.clientCorrelationId) return undefined
    if (next.payload.operation === 'replace') return next
    if (next.payload.operation !== 'append'
      || !['append', 'replace'].includes(String(prior.payload.operation))) return undefined
    if (typeof prior.payload.text !== 'string' || typeof next.payload.text !== 'string') return undefined
    return { ...next, payload: { ...next.payload, operation: prior.payload.operation,
      text: prior.payload.text + next.payload.text } }
  }
  function createTurn(input: ClaudeMessageTurnInput): Turn {
    return { correlationId: input.clientCorrelationId, promptUuid: claudePromptUuid(input.clientCorrelationId), input,
      submitted: false, observing: true, replyObserved: false, resultBeforeReply: false, events: new ClaudeBoundedQueue(256, coalesceText),
      ...(input.callbackAuthority ? { authority: { ...input.callbackAuthority } } : {}) }
  }
  function subscribe(turn: Turn, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    return {
        [Symbol.asyncIterator]() {
          if (turn.observerLease) {
            throw new HarnessExecutionError('CLAUDE_OBSERVER_CONFLICT', 'This Claude message already has an observer.')
          }
          const lease = Symbol('Claude message observer')
          turn.observerLease = lease
          turn.observing = !turn.terminal
          const iterator = turn.events[Symbol.asyncIterator]()
          const detach = () => {
            if (turn.observerLease !== lease) return
            delete turn.observerLease
            turn.observing = false
            turn.events.discard()
            void iterator.return?.()
          }
          const aborted = () => detach()
          signal?.addEventListener('abort', aborted, { once: true })
          const cleanup = () => { signal?.removeEventListener('abort', aborted); detach() }
          return {
            async next() {
              try {
                signal?.throwIfAborted()
                const value = await iterator.next()
                signal?.throwIfAborted()
                if (value.done) cleanup()
                return value
              } catch (error) {
                cleanup()
                throw error
              }
            },
            async return() { cleanup(); return { done: true as const, value: undefined } },
            async throw(error: unknown) { cleanup(); throw error },
          }
        },
      }
  }
  const manager: ClaudeNativeSessionManager = {
    harness,
    requiresRuntimeClosure: () => options.runner.requiresRuntimeClosure?.() ?? all.size > 0,
    callbackAuthority(context) {
      const runtime = resident.get(context.nativeSessionId)
      const turn = runtime?.turns.get(context.clientCorrelationId)
      if (!runtime || runtime.closed || runtime.generation !== context.generation || !turn?.submitted
        || turn.nativeMessageId !== context.nativeMessageId || turn.terminal || !turn.authority) return undefined
      return { ...turn.authority }
    },
    observeSubagentHook(sessionId, agentId, agentType, status) {
      const runtime = resident.get(sessionId)
      if (!runtime?.session || !agentId || agentId.length > 512 || runtime.closed || disposed) return
      void record(runtime, 'claude.subagent', { nativeSessionId: sessionId, agentId, agentType: agentType.slice(0, 512), status }, runtime.active)
    },
    notifyPendingChanged(notification) {
      const runtime = resident.get(notification.nativeSessionId)
      const turn = runtime?.turns.get(notification.clientCorrelationId)
      if (!runtime || runtime.closed || runtime.generation !== notification.generation || !turn?.submitted
        || turn.nativeMessageId !== notification.nativeMessageId || turn.terminal) return
      void record(runtime, 'interaction.pending', { nativeSessionId: notification.nativeSessionId,
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
      if (session.harness !== harness || query.expectedNativeTurnId !== undefined) {
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
      return { provider: harness, providerVersion: [...resident.values()].find(runtime => runtime.nativeProviderVersion)?.nativeProviderVersion
          ?? q.cliVersion, persistentSessions: q.basicTurns, reconnect: q.resume,
        sameRequestResponses: Boolean(q.interactions && options.interactionPort), cancellation: q.basicTurns, history: q.history, configurationInspection: true,
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
        for (const key of [...APP_MCP_TOKEN_NAMES, ...(options.credentialEnvironmentVariables ?? [])]) delete variables[key]
        const agentId = value.environment?.agentId ?? sessionStartOwner(value)
        return JSON.stringify({ ...value, environment: { agentId, variables } })
      }
      const original = JSON.parse(inspected.identity) as NativeSessionStart
      if (!sameJson(withoutCredentials(original), withoutCredentials(start))) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'Credential delivery changed the accepted owner/configuration or noncredential environment.')
      const configured = options.sdkOptions.mcpServers && typeof options.sdkOptions.mcpServers === 'object' ? options.sdkOptions.mcpServers as Record<string, unknown> : {}
      const topology = (entries: Readonly<Record<string, unknown>>) => JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
        const config = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        if (config.type === 'sdk') return [name, { type: 'sdk', name: config.name }]
        const { headers: rawHeaders, env: rawEnv, ...scope } = config
        const headers = rawHeaders && typeof rawHeaders === 'object' ? Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => key.toLowerCase() !== 'authorization')) : {}
        const env = rawEnv && typeof rawEnv === 'object' ? { ...rawEnv as Record<string, unknown> } : {}
        for (const key of [...APP_MCP_TOKEN_NAMES, ...(options.credentialEnvironmentVariables ?? [])]) delete env[key]
        return [name, { ...scope, headers, env }]
      }))
      if (topology(configured) !== topology(servers)) throw new HarnessExecutionError('CLAUDE_MCP_SCOPE_CONFLICT', 'Credential delivery changed accepted SDK server names, endpoints, commands or arguments.')
      const managedName = expectedMcp.serverName
      for (const [name, config] of Object.entries(configured)) {
        if (name === managedName) continue
        const sdkServer = config && typeof config === 'object' && Reflect.get(config, 'type') === 'sdk'
        const same = sdkServer ? config === servers[name] : JSON.stringify(config) === JSON.stringify(servers[name])
        if (!same) throw new HarnessExecutionError('CLAUDE_MCP_SCOPE_CONFLICT', 'Credential delivery cannot refresh unrelated native MCP servers.')
      }
      const snapshot = await deliverCredentials(runtime, start, servers, signal)
      // Record the inspected context after the SDK confirms its credential update.
      inspected.identity = JSON.stringify(canonicalStart(start))
      runtime.start = structuredClone(start)
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
      return claudeMcpDetection(decodeClaudeMcpControl(rows, runtime.generation, now(), inspectionCredentials(runtime)), expectedMcp)
    },
    async createSession(start, signal) {
      if (isWorkflowStart(start) && start.sessionContinuation) {
        const { sessionContinuation, ...acceptedStart } = start
        return manager.attachSession(sessionContinuation.session, acceptedStart, signal)
      }
      throw new HarnessExecutionError('CLAUDE_INITIAL_TURN_REQUIRED', 'Claude reports a native session only after first input; use the admitted atomic initial-turn lifecycle.')
    },
    startInitialTurn(start, input, signal) {
      signal?.throwIfAborted()
      qualified('basicTurns')
      if (disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
      if (start.correlationId && start.correlationId !== input.clientCorrelationId) throw new HarnessExecutionError('CLAUDE_INITIAL_CORRELATION_MISMATCH', 'Initial native input differs from the admitted session correlation.')
      if (input.onSubmitted && !input.onMessageSubmitted) throw new HarnessExecutionError('CLAUDE_MESSAGE_RECEIPT_REQUIRED', 'Initial Claude input requires a truthful native message receipt, not a native-turn alias.')
      const identity = JSON.stringify({ start: canonicalStart(start), prompt: input.prompt, correlationId: input.clientCorrelationId })
      const previous = initialTurns.get(input.clientCorrelationId)
      if (previous) {
        if (!sameJson(previous.identity, identity)) throw new HarnessExecutionError('CLAUDE_CREATION_IDENTITY_CONFLICT', 'The initial input belongs to another accepted scope.')
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
      if (session.harness !== harness) throw new HarnessExecutionError('CLAUDE_SESSION_MISMATCH', 'Persisted Claude installation identity differs.')
      if (disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
      const existing = resident.get(session.nativeSessionId) ?? rolloverSources.get(session.nativeSessionId)
        ?? retired.get(session.nativeSessionId)
      if (!existing) return open(start, session, signal)
      if (!isDeepStrictEqual(sessionContext(existing.start), sessionContext(start))) {
        throw new HarnessExecutionError('CLAUDE_SESSION_CONTEXT_CONFLICT',
          'The resident Claude session has another accepted configuration or environment.')
      }
      const pending = rollovers.get(session.nativeSessionId)
      if (pending) return pending
      const rolloverSource = rolloverSources.get(session.nativeSessionId) === existing
      if (!rolloverSource && all.has(existing) && !existing.closed && !existing.failure) {
        try {
          existing.sdk.assertInputCapacity()
          return existing.session!
        } catch (error) {
          if (!(error instanceof ClaudeInputNotDeliveredError)) throw error
        }
      }
      if (existing.active || existing.controlPending) {
        throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'Finish the owned input or control before resuming this session.')
      }
      qualified('resume')
      if (existing.failure || !retired.has(session.nativeSessionId)) retired.set(session.nativeSessionId, existing)
      rolloverSources.set(session.nativeSessionId, existing)
      const rollover = (async () => {
        // Completed inputs have no live callbacks; keep the owner bridge usable on resume.
        existing.replacingForResume = true
        await manager.close(session)
        if (prepared && (await prepared.opening) === existing) prepared = undefined
        const resumed = await open(start, session, signal)
        rolloverSources.delete(session.nativeSessionId)
        retired.delete(session.nativeSessionId)
        return resumed
      })()
      rollovers.set(session.nativeSessionId, rollover)
      try {
        return await rollover
      } finally {
        rollovers.delete(session.nativeSessionId)
      }
    },
    async configureSessionPreferences(preferences) {
      if ([...all].some(runtime => !runtime.closed)) throw new HarnessExecutionError('CLAUDE_SETTINGS_PENDING', 'These settings require a safe resume or a new session.')
      claudeSessionEnvironment({}, preferences)
      sessionPreferences = structuredClone(preferences)
    },
    async applySessionPreferences(session, preferences, signal) {
      const runtime = runtimeFor(session)
      if (runtime.startingTurn) throw new HarnessExecutionError('CLAUDE_SETTINGS_BUSY', 'A turn is starting.')
      await applyPreferences(runtime, SessionPreferencesSchema.parse(preferences), signal)
    },
    async sessionControlCapabilities(session) {
      const runtime = runtimeFor(session)
      const compact = runtime.commands?.includes('compact') === true
      const plan = !!runtime.sdk.setPermissionMode
      return { compact: { supported: compact, reason: compact ? null : 'Native initialization did not advertise compact.' },
        plan: { supported: plan, reason: plan ? null : 'The owned SDK query has no Plan control.' },
        autoCompact: { supported: true, reason: null }, autoCompactBudget: { supported: runtime.modelCapacity !== undefined, reason: runtime.modelCapacity !== undefined ? null : 'Native model capacity is not known yet.' },
        contextBudgets: [], contextProfiles: claudeContextProfiles(runtime.models ?? [],
          String(options.sdkOptions.model ?? ''), runtime.defaultModelCapacity ?? null), modelCapacity: runtime.modelCapacity ?? null,
        nativeDefaultCapacity: runtime.defaultModelCapacity ?? null,
        model: String(options.sdkOptions.model ?? ''), profileKey: JSON.stringify(options.scope) }
    },
    appliedSessionPreferences(session) { return runtimeFor(session).appliedPreferences ?? null },
    contextSnapshot(session) { return runtimeFor(session).context ?? null },
    async compactSession(session, input, signal) {
      const runtime = runtimeFor(session)
      if (runtime.active || runtime.startingTurn || runtime.controlPending || runtime.compaction
        || options.pendingInteractions?.(session).length) throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'Wait for the turn and its approvals to finish.')
      if (!runtime.commands?.includes('compact')) throw new HarnessExecutionError('CLAUDE_COMPACT_UNAVAILABLE', 'Native compact is unavailable.')
      const before = await options.runner.compactionHistory?.({ ...options.scope, nativeSessionId: session.nativeSessionId }, options.scope, undefined, signal)
      if (!before) throw new HarnessExecutionError('CLAUDE_COMPACTION_HISTORY_UNAVAILABLE', 'Native compaction requires its persisted session boundary reader.')
      runtime.controlPending = true
      let finish!: () => void
      let fail!: (error: unknown) => void
      const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
      const control = { state: { requestId: input.requestId, nativeSessionId: session.nativeSessionId,
        nativeOperationId: null, nativeRequestId: claudePromptUuid(input.clientCorrelationId),
        claudeSession: { ...options.scope }, claudeCursor: before.cursor, status: 'running' as CompactionState['status'], message: 'Compacting context.',
        beforeTokens: runtime.context?.usedTokens ?? null, observedAt: now() },
        promptUuid: claudePromptUuid(input.clientCorrelationId), boundary: false, progress: input.onProgress, finish, fail }
      runtime.compaction = control
      const waitSignal = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
      const abort = () => fail(waitSignal.reason)
      waitSignal.addEventListener('abort', abort, { once: true })
      let dispatched = false
      try {
        await input.onProgress(control.state)
        await input.onDispatch?.()
        dispatched = true
        await runtime.sdk.offer({ promptUuid: control.promptUuid, content: '/compact' }, signal)
        await input.onProgress(control.state)
        await completed
        return control.state
      } catch (error) {
        const definite = !dispatched || !!error && typeof error === 'object' && (
          'deliveryState' in error && error.deliveryState === 'not-delivered'
          || 'certainty' in error && error.certainty === 'definite')
        control.state = { ...control.state, status: definite ? 'failed' : 'uncertain',
          message: definite ? 'Claude rejected the command before delivery.' : 'Read to recover native compaction.' }
        throw error
      } finally {
        waitSignal.removeEventListener('abort', abort)
        if (control.state.status !== 'uncertain') runtime.compaction = undefined
        runtime.controlPending = control.state.status === 'uncertain'
      }
    },
    async reconcileCompaction(session, state, signal) {
      const runtime = runtimeFor(session)
      const control = runtime.compaction?.state.requestId === state.requestId ? runtime.compaction : undefined
      let recovered = control?.state ?? state
      if (['accepted', 'running', 'uncertain'].includes(recovered.status)) {
        const persisted = { ...options.scope, nativeSessionId: session.nativeSessionId }
        const outcome = recovered.nativeRequestId && options.runner.compactionOutcome
          ? await options.runner.compactionOutcome(persisted, options.scope, recovered.nativeRequestId) : null
        if (outcome) recovered = { ...recovered, ...outcome,
          message: outcome.status === 'failed' ? 'Claude rejected compaction.' : 'Native compaction completed.' }
        else if (recovered.claudeCursor && options.runner.compactionHistory) {
          const history = await options.runner.compactionHistory(persisted, options.scope, recovered.claudeCursor, signal)
          recovered = recoveredClaudeCompaction(recovered, history.boundaries)
        }
      }
      if (!['accepted', 'running', 'uncertain'].includes(recovered.status)) {
        if (control) { control.state = recovered; control.finish() }
        runtime.compaction = undefined
        runtime.controlPending = false
        if (recovered.status === 'completed' && runtime.context) runtime.context = { ...runtime.context, stale: true }
      } else {
        runtime.controlPending = true
      }
      return recovered
    },
    startTurn(session, rawInput, signal) {
      qualified('basicTurns')
      signal?.throwIfAborted()
      const runtime = runtimeFor(session)
      if (runtime.failure) throw runtime.failure
      if (runtime.closed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned native output stream is closed.')
      if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
      if (runtime.active || runtime.startingTurn) throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'A Claude message is still active or uncertain; no second prompt may be offered.')
      if (runtime.turns.has(rawInput.clientCorrelationId) || runtime.restoredReceipts.has(rawInput.clientCorrelationId)) throw new HarnessExecutionError('CLAUDE_PROMPT_REPLAY_FORBIDDEN', 'This correlation was already offered; use read-only reconciliation.')
      const input = rawInput as ClaudeMessageTurnInput
      if (input.onSubmitted && !input.onMessageSubmitted) throw new HarnessExecutionError('CLAUDE_MESSAGE_RECEIPT_REQUIRED', 'Claude has native message receipts; this caller requires a native-turn receipt.')
      runtime.sdk.assertInputCapacity()
      const turn = createTurn(input)
      runtime.turns.set(turn.correlationId, turn)
      runtime.startingTurn = turn
      runtime.controlPending = true
      let offerStarted = false
      // Subscribe before offering. A returned iterable does not fabricate admission.
      const offer = async () => {
        if (options.messageSubmitted && await options.messageSubmitted(turn.correlationId)) {
          throw new ClaudeInputNotDeliveredError('This correlation was already submitted; use read-only reconciliation.')
        }
        if (!options.messageSubmitted && runtime.retiredTurns) {
          for (let offset = 0; ; offset += 256) {
            const rows = await options.runner.history({ ...options.scope, nativeSessionId: session.nativeSessionId },
              options.scope, signal, { offset, limit: 256 })
            if (rows.some(row => row && typeof row === 'object' && (row as { uuid?: string }).uuid === turn.promptUuid
              && (row as { type?: string }).type === 'user')) {
              throw new ClaudeInputNotDeliveredError('This correlation was already submitted; use read-only reconciliation.')
            }
            if (rows.length < 256) break
          }
        }
        runtime.controlPending = false
        if (input.sessionPreferences) await applyPreferences(runtime, input.sessionPreferences, signal)
        runtime.active = turn
        runtime.startingTurn = undefined
        if (input.sessionMode && runtime.sdk.setPermissionMode) {
          await runtime.sdk.setPermissionMode(input.sessionMode === 'plan' ? 'plan' : 'default')
        } else if (input.sessionMode === 'plan') {
          throw new HarnessExecutionError('CLAUDE_PLAN_UNAVAILABLE', 'The owned SDK query cannot enter Plan mode.')
        }
        await input.onSettingsApplied?.()
        offerStarted = true
        await runtime.sdk.offer({ promptUuid: turn.promptUuid, content: input.prompt }, signal)
      }
      void offer().catch((error: unknown) => {
        runtime.controlPending = false
        runtime.startingTurn = undefined
        const notOffered = !offerStarted || error instanceof ClaudeInputNotDeliveredError || error && typeof error === 'object'
          && 'deliveryState' in error && error.deliveryState === 'not-delivered'
        if (notOffered) {
          if (runtime.active === turn) delete runtime.active
          runtime.turns.delete(turn.correlationId)
          const rejection = Object.assign(new Error(error instanceof Error ? error.message : 'Claude input was not offered.',
            { cause: error }), { certainty: 'definite' as const, deliveryState: 'not-delivered' as const })
          turn.events.close(rejection)
        } else {
          turn.events.close(error)
          runtime.failure = error
        }
      })
      return subscribe(turn, signal)
    },
    async forkSession(source, start, signal) {
      qualified('fork')
      signal?.throwIfAborted()
      const cwd = sessionStartDirectory(start)
      if (cwd !== options.scope.cwd || source.harness !== harness) throw new HarnessExecutionError('CLAUDE_FORK_SCOPE_MISMATCH', 'Claude fork scope differs from the pinned source.')
      const key = sessionStartCorrelation(start)
      if (!key) throw new HarnessExecutionError('CLAUDE_CORRELATION_REQUIRED', 'Native fork requires its admitted correlation.')
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
    /** Interrupts only the exact active turn, identified by its native message receipt. */
    async cancel(session, signal, nativeMessageId) {
      signal?.throwIfAborted()
      const runtime = runtimeFor(session)
      const turn = runtime.active
      if (runtime.closed || runtime.failure || !turn?.submitted || turn.terminal || !turn.nativeMessageId
        || nativeMessageId !== undefined && nativeMessageId !== turn.nativeMessageId) return false
      if (turn.cancelRequested) return true
      // Set before the await: the interrupted result can be pumped before interrupt() resolves.
      turn.cancelRequested = true
      try { await runtime.sdk.interrupt() } catch (error) { turn.cancelRequested = false; throw error }
      return true
    },
    async subagentHistory(session, cursor, signal) {
      const runtime = runtimeFor(session)
      qualified('history')
      if (!options.runner.subagentHistory) throw new HarnessExecutionError('SUBAGENT_HISTORY_UNAVAILABLE', 'The exact SDK child history port is unavailable.')
      const page = childHistoryCursor(session.nativeSessionId, cursor)
      const history = await options.runner.subagentHistory({ ...options.scope, nativeSessionId: session.nativeSessionId }, options.scope,
        page.target === session.nativeSessionId ? undefined : page.target, page.offset ?? 0, signal)
      if (runtimeFor(session) !== runtime || runtime.closed || disposed) throw new HarnessExecutionError('SUBAGENT_HISTORY_OWNER_STALE', 'The exact SDK child history owner changed.')
      if (!history.agentId) return { events: [], nextCursor: null }
      const frames = history.messages.map(value => value && typeof value === 'object' ? value as Record<string, unknown> : {})
      const spawn = frames.find(frame => typeof frame.parent_tool_use_id === 'string')?.parent_tool_use_id
      const parentAgentId = frames.find(frame => typeof frame.parent_agent_id === 'string')?.parent_agent_id
      if (frames.some(frame => frame.session_id !== session.nativeSessionId)) throw new HarnessExecutionError('SUBAGENT_ANCESTRY_INVALID', 'SDK child transcript returned another root session.')
      // The native transcript proves the Agent/tool join; task and agent IDs are never equated.
      const task = typeof spawn === 'string' ? runtime.events.find(event => event.type === 'claude.task' && event.payload.taskType === 'local_agent' && event.payload.toolUseId === spawn) : undefined
      const discovery = childHistoryEvent('claude.subagent', { nativeSessionId: session.nativeSessionId, agentId: history.agentId, ancestry: 'verified',
        ...(typeof parentAgentId === 'string' ? { parentAgentId } : {}), ...(typeof spawn === 'string' ? { spawnToolUseId: spawn } : {}),
        ...(typeof task?.payload.taskId === 'string' ? { taskId: task.payload.taskId } : {}), status: 'unknown' })
      const decoded = createClaudeEventNormalizer({ owner: { ownerId: options.scope.deviceId, attemptId: session.nativeSessionId, generation: runtime.generation }, observedAt: now })
      const events = [discovery, ...frames.flatMap(frame => decoded.ingest(frame).filter(event => ['text', 'tool'].includes(event.change.kind))
        .map(event => { const native = claudeNativeEvent(event, 0); return childHistoryEvent(native.type, { ...native.payload, agentId: history.agentId, subagentNativeId: history.agentId }, native.occurredAt) }))]
      const next = history.agentIds.find(id => id > history.agentId!)
      return { events, nextCursor: history.hasMore ? encodeChildHistoryCursor({ root: page.root, target: history.agentId, cursor: null, offset: (page.offset ?? 0) + 50 })
        : next ? encodeChildHistoryCursor({ root: page.root, target: next, cursor: null, offset: 0 }) : null }
    },
    async history(session): Promise<NativeHistory> {
      const runtime = runtimeFor(session, { readOnly: true })
      return { events: [...runtime.events], pendingInteractions: [...(options.pendingInteractions?.(session) ?? [])], firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.nextSequence, nextSequence: runtime.nextSequence }
    },
    async retireTurn(session, correlationId) {
      const runtime = runtimeFor(session, { readOnly: true })
      const turn = runtime.turns.get(correlationId)
      if (!turn?.terminal || !turn.nativeMessageId) return
      if (runtime.active === turn) delete runtime.active
      turn.observing = false
      turn.events.close(undefined, true)
      runtime.turns.delete(correlationId)
      initialTurns.delete(correlationId)
      for (const owners of [runtime.messageOwners, runtime.toolOwners]) {
        for (const [id, owner] of owners) if (owner === turn) owners.delete(id)
      }
      if (runtime.restoredReceipts.size >= 256) runtime.restoredReceipts.delete(runtime.restoredReceipts.keys().next().value!)
      runtime.restoredReceipts.set(correlationId, { kind: 'message', nativeSessionId: session.nativeSessionId,
        nativeMessageId: turn.nativeMessageId, clientCorrelationId: correlationId })
      runtime.retiredTurns = true
    },
    async reconcile(session, correlationId, signal): Promise<NativeHistory> {
      const runtime = runtimeFor(session, { readOnly: true })
      const turn = runtime.turns.get(correlationId)
      if (!turn && !runtime.restoredReceipts.has(correlationId) && options.qualification.history) {
        const expectedUuid = claudePromptUuid(correlationId)
        if (!runtime.historyScanOffsets.has(correlationId) && runtime.historyScanOffsets.size >= 256) {
          throw new HarnessExecutionError('CLAUDE_RECOVERY_WINDOW_EXHAUSTED', 'The native history recovery window is full.')
        }
        let accepted: boolean
        for (let offset = runtime.historyScanOffsets.get(correlationId) ?? 0; ; offset += 256) {
          signal?.throwIfAborted()
          const rows = await options.runner.history({ ...options.scope, nativeSessionId: session.nativeSessionId },
            options.scope, signal, { offset, limit: 256 })
          signal?.throwIfAborted()
          if (runtimeFor(session, { readOnly: true }) !== runtime || disposed) {
            throw new HarnessExecutionError('CLAUDE_SESSION_UNAVAILABLE',
              'The owned native history reader changed during reconciliation.')
          }
          accepted = rows.some((value) => {
            const frame = value && typeof value === 'object' ? value as Record<string, unknown> : {}
            return frame.type === 'user' && frame.uuid === expectedUuid && frame.session_id === session.nativeSessionId && frame.parent_tool_use_id == null
          })
          if (accepted || rows.length < 256) break
          // Interrupted reads resume after the last complete page, never report a partial scan as a miss.
          runtime.historyScanOffsets.set(correlationId, offset + 256)
        }
        if (accepted) {
          if (!runtime.restoredReceipts.has(correlationId) && runtime.restoredReceipts.size >= 256) {
            runtime.restoredReceipts.delete(runtime.restoredReceipts.keys().next().value!)
          }
          runtime.restoredReceipts.set(correlationId, { kind: 'message', nativeSessionId: session.nativeSessionId, nativeMessageId: expectedUuid, clientCorrelationId: correlationId })
        }
        runtime.historyScanOffsets.delete(correlationId)
      }
      const restored = runtime.restoredReceipts.get(correlationId)
      return {
        firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.nextSequence,
        nextSequence: runtime.nextSequence,
        ...(restored ? { correlationId, nativeSubmission: restored } : {}),
        events: runtime.events.filter(event => event.payload.clientCorrelationId === correlationId),
        pendingInteractions: (options.pendingInteractions?.(session) ?? []).filter(pending =>
          (pending.turn as typeof pending.turn & { nativeMessageId?: string }).nativeMessageId
            === (turn?.nativeMessageId ?? restored?.nativeMessageId)),
        ...(turn?.nativeMessageId ? { correlationId, nativeSubmission: { kind: 'message' as const,
          nativeSessionId: session.nativeSessionId, nativeMessageId: turn.nativeMessageId,
          clientCorrelationId: correlationId } } : {}),
        ...(turn?.assistantMessageId ? { nativeMessageId: turn.assistantMessageId } : {}),
        ...(turn?.terminal && turn.nativeMessageId ? { terminalResult: turn.terminal,
          terminalTurn: { correlationId, providerId: turn.nativeMessageId, result: turn.terminal } } : {}),
      }
    },
    async reconcileResponse(session, response, signal) { return options.interactionPort?.reconcileResponse?.(session, response, signal) ?? manager.history(session) },
    async close(session) {
      const runtime = resident.get(session.nativeSessionId)
      if (!runtime) return
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      if ([...resident.values()].every((entry) => entry.closed)) rejectCallbackWaiters()
      if (runtime.active) {
        runtime.active.observing = false
        runtime.active.events.close(undefined, true)
      }
      await runtime.sdk.close()
      await runtime.pumping
      resident.delete(session.nativeSessionId)
      all.delete(runtime)
    },
    async closeForRestart(session) { return runtimeFor(session).sdk.closeForRestart() },
    async dispose() {
      disposed = true
      rejectCallbackWaiters()
      for (const runtime of all) {
        runtime.closed = true
        delete runtime.httpCredentialAcknowledgement
        if (runtime.active) {
          runtime.active.observing = false
          runtime.active.events.close(undefined, true)
        }
      }
      await options.runner.dispose()
      await Promise.all([...all].map((runtime) => runtime.pumping))
      resident.clear()
      rolloverSources.clear()
      retired.clear()
      all.clear()
    },
  }
  return manager
}
