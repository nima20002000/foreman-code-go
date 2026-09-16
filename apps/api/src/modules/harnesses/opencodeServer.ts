import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

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
  type OpenCodeAdvancedConfiguration,
  type OpenCodeHarnessConfiguration,
  type PendingNativeInteraction,
} from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'
import type {
  ChildProcessEnvironment,
  NativeHarnessSessionManager,
  NativeHistory,
  NativeSessionStart,
  NativeTurnInput,
} from './port.js'
import { runCommand } from './process.js'

const QUALIFIED_VERSION = '1.18.31'
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_STDERR_LENGTH = 64_000
const APP_CREDENTIAL_ENV = 'GRAPHQL_APP_MCP_TOKEN'

type JsonObject = Record<string, unknown>

interface NativePermissionRequest extends JsonObject {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: JsonObject
  always: string[]
  tool?: { messageID: string; callID: string }
}

interface NativeEvent extends JsonObject {
  id?: string
  type: string
  properties?: JsonObject
}

interface NativeMessage extends JsonObject {
  info: JsonObject
  parts: JsonObject[]
}

interface SessionState {
  directory: string
  configuration: OpenCodeHarnessConfiguration
  events: NativeHarnessEvent[]
  seenEventIds: Set<string>
  seenPendingRequestIds: Set<string>
  correlationMessages: Map<string, string>
  sequence: number
}

export type NativeDeliveryCertainty = 'definite' | 'uncertain'

/** HAP-05 uses certainty to decide whether a native mutation may safely be retried. */
export class OpenCodeNativeDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly certainty: NativeDeliveryCertainty,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OpenCodeNativeDeliveryError'
  }
}

export interface OpenCodeServerController {
  readonly expectedVersion: string
  readonly advancedConfiguration?: OpenCodeAdvancedConfiguration | undefined
  ensure(signal?: AbortSignal): Promise<void>
  request(path: string, init?: RequestInit, signal?: AbortSignal): Promise<Response>
  dispose(): Promise<void>
  restart?(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void>
}

export interface ManagedOpenCodeServerOptions {
  binary: string
  workingDirectory: string
  ownerAgentId: string
  environment?: ChildProcessEnvironment
  pure?: boolean
  advancedConfiguration?: OpenCodeAdvancedConfiguration
}

/** One resident process is permanently scoped to one logical Agent credential context. */
export class ManagedOpenCodeServer implements OpenCodeServerController {
  readonly expectedVersion = QUALIFIED_VERSION
  readonly advancedConfiguration: OpenCodeAdvancedConfiguration | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private baseUrl: string | undefined
  private password: string | undefined
  private stderr = ''
  private starting: Promise<void> | undefined
  private environment: ChildProcessEnvironment | undefined

  constructor(private readonly options: ManagedOpenCodeServerOptions) {
    this.advancedConfiguration = options.advancedConfiguration
    this.environment = this.validateEnvironment(options.environment)
    const advancedPure = options.advancedConfiguration?.plugins.mode === 'pure'
    if (options.pure !== undefined && options.advancedConfiguration && options.pure !== advancedPure) {
      throw new HarnessExecutionError('OPENCODE_PLUGIN_MODE_CONFLICT', 'Managed server pure mode conflicts with the Advanced plugin setting.')
    }
  }

  private validateEnvironment(environment?: ChildProcessEnvironment): ChildProcessEnvironment | undefined {
    if (environment && environment.agentId !== this.options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The OpenCode server credential does not belong to its owning Agent.')
    }
    const unsupported = Object.keys(environment?.variables ?? {}).filter((key) => key !== APP_CREDENTIAL_ENV)
    if (unsupported.length > 0) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_ENV_UNSUPPORTED', 'The OpenCode server only accepts the scoped App credential environment variable.')
    }
    return environment ? { agentId: environment.agentId, variables: { ...environment.variables } } : undefined
  }

  async ensure(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.child && this.baseUrl && this.child.exitCode === null) {
      const health = await this.rawRequest('/global/health', { method: 'GET' }, signal)
      if (health.ok) return
    }
    if (!this.starting) {
      this.starting = this.start(signal).finally(() => { this.starting = undefined })
    }
    return this.starting
  }

  async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    await this.ensure(signal)
    return this.rawRequest(path, init, signal)
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.baseUrl = undefined
    this.password = undefined
    if (!child || child.exitCode !== null) return
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    } else {
      child.kill('SIGTERM')
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ])
    if (child.exitCode === null) {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      } else child.kill('SIGKILL')
    }
  }

  async restart(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void> {
    const next = this.validateEnvironment(environment)
    await this.dispose()
    this.environment = next
    await this.ensure(signal)
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const version = await runCommand(this.options.binary, ['--version'], this.options.workingDirectory, signal)
    const installed = (version.stdout || version.stderr).trim()
    if (version.exitCode !== 0 || installed !== this.expectedVersion) {
      throw new HarnessExecutionError(
        'OPENCODE_SERVER_VERSION_UNQUALIFIED',
        `OpenCode server mode is qualified only for ${this.expectedVersion}; found ${installed || 'unavailable'}.`,
      )
    }

    this.password = randomBytes(32).toString('hex')
    const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', OPENCODE_SERVER_PASSWORD: this.password }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_')
        || key === 'DATABASE_URL' || key === 'TEST_DATABASE_URL' || key === 'PGPASSWORD') delete environment[key]
    }
    Object.assign(environment, this.environment?.variables ?? {})
    if (this.options.advancedConfiguration) {
      environment.OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent(
        environment.OPENCODE_CONFIG_CONTENT,
        this.options.advancedConfiguration,
      )
    }
    const pure = this.options.advancedConfiguration?.plugins.mode === 'pure' || this.options.pure === true
    const args = ['serve', '--hostname', '127.0.0.1', '--port', '0', ...(pure ? ['--pure'] : [])]
    const child = spawn(this.options.binary, args, {
      cwd: this.options.workingDirectory,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdin.end()
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + String(chunk)).slice(-MAX_STDERR_LENGTH) })
    const baseUrl = await this.waitForUrl(child, signal)
    this.baseUrl = baseUrl
    const health = await this.rawRequest('/global/health', { method: 'GET' }, signal)
    if (!health.ok) {
      await this.dispose()
      throw new HarnessExecutionError('OPENCODE_SERVER_UNHEALTHY', `OpenCode health returned HTTP ${health.status}.`)
    }
  }

  private waitForUrl(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = ''
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        child.stdout.removeListener('data', data)
        child.removeListener('error', failed)
        child.removeListener('close', closed)
        if (error) reject(error)
        else resolve(url as string)
      }
      const data = (chunk: Buffer | string) => {
        text += String(chunk)
        const match = text.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match?.[1]) finish(undefined, match[1])
      }
      const failed = (error: Error) => finish(error)
      const closed = () => finish(new HarnessExecutionError('OPENCODE_SERVER_START_FAILED', this.stderr.trim() || 'OpenCode server exited during startup.'))
      const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('OpenCode server startup aborted.'))
      const timer = setTimeout(() => finish(new HarnessExecutionError('OPENCODE_SERVER_START_TIMEOUT', 'OpenCode server did not become ready in time.')), STARTUP_TIMEOUT_MS)
      child.stdout.on('data', data)
      child.once('error', failed)
      child.once('close', closed)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private rawRequest(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!this.baseUrl || !this.password) throw new HarnessExecutionError('OPENCODE_SERVER_NOT_STARTED', 'OpenCode server is not started.')
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const headers = new Headers(init.headers)
    headers.set('authorization', `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`)
    return fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: combined })
  }
}

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
  effectiveFilters: readonly { permission: string; pattern: string; effect: string }[]
  detail?: string
}

/** Native OpenCode V1 session transport. Legacy `OpenCodeAdapter` remains the explicit run fallback. */
export class OpenCodeNativeSessionManager implements NativeHarnessSessionManager {
  readonly harness = 'opencode' as const
  private readonly sessions = new Map<string, SessionState>()
  private readonly activeTurns = new Set<string>()

  constructor(private readonly options: OpenCodeNativeSessionManagerOptions) {}

  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    await this.qualifyServer(signal)
    return NativeHarnessCapabilitiesSchema.parse({
      provider: 'opencode', providerVersion: QUALIFIED_VERSION,
      persistentSessions: true, reconnect: true, sameRequestResponses: true,
      cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true, supportedInteractionKinds: ['approval'],
    })
  }

  async createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const workingDirectory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
    const title = input.kind === 'operator' ? `GraphQL Operator ${input.correlationId}` : `GraphQL ${input.request.executionId}`
    const configuration = this.configuration(input)
    if (input.environment && input.environment.agentId !== this.options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_SESSION_OWNER_MISMATCH', 'The session credential belongs to another Agent.')
    }
    await this.qualifyServer(signal)
    await this.qualifyConfiguration(configuration, workingDirectory, signal)
    await this.applyMcpControls(configuration, workingDirectory, signal)
    const [providerID, ...modelParts] = configuration.model.split('/')
    const permission = configuration.advanced?.permissionRules.map((rule) => ({
      permission: nativePermissionName(rule.permission), pattern: rule.pattern, action: rule.effect,
    }))
    const response = await this.json('/session', {
      method: 'POST', directory: workingDirectory,
      body: {
        title,
        agent: configuration.nativeAgent,
        model: { providerID, id: modelParts.join('/'), variant: configuration.variant },
        ...(permission ? { permission } : {}),
      },
    }, signal)
    const sessionId = stringField(response, 'id', 'OPENCODE_SESSION_ID_MISSING')
    const session = NativeSessionReferenceSchema.parse({ harness: 'opencode', providerVersion: QUALIFIED_VERSION, nativeSessionId: sessionId })
    this.sessions.set(sessionId, {
      directory: workingDirectory, configuration,
      events: [], seenEventIds: new Set(), seenPendingRequestIds: new Set(), correlationMessages: new Map(), sequence: 0,
    })
    return session
  }

  async attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    if (session.harness !== 'opencode' || session.providerVersion !== QUALIFIED_VERSION) {
      throw new HarnessExecutionError('OPENCODE_SESSION_UNQUALIFIED', 'The persisted session is not qualified for this OpenCode manager.')
    }
    if (input.environment && input.environment.agentId !== this.options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_SESSION_OWNER_MISMATCH', 'The session credential belongs to another Agent.')
    }
    const directory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
    const configuration = this.configuration(input)
    await this.qualifyServer(signal)
    await this.qualifyConfiguration(configuration, directory, signal)
    const response = await this.options.server.request(
      withDirectory(`/session/${encodeURIComponent(session.nativeSessionId)}`, directory),
      { method: 'GET' }, signal,
    )
    if (response.status === 404) {
      throw new HarnessExecutionError('OPENCODE_SESSION_NOT_FOUND', 'The persisted OpenCode session no longer exists; a replacement was not created.')
    }
    if (!response.ok) throw await responseError(response, 'OPENCODE_SESSION_ATTACH_FAILED', 'definite')
    const native = asObject(await response.json())
    this.verifyAttachedSession(native, session.nativeSessionId, directory, configuration)
    await this.applyMcpControls(configuration, directory, signal)
    this.sessions.set(session.nativeSessionId, {
      directory, configuration,
      events: [], seenEventIds: new Set(), seenPendingRequestIds: new Set(), correlationMessages: new Map(), sequence: 0,
    })
    return session
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const state = await this.requireSession(session, signal)
    if (this.activeTurns.has(session.nativeSessionId)) {
      throw new HarnessExecutionError('OPENCODE_SESSION_BUSY', 'This OpenCode session already has an active GraphQL-owned turn.')
    }
    this.activeTurns.add(session.nativeSessionId)
    const messageID = messageId(input.clientCorrelationId)
    state.correlationMessages.set(input.clientCorrelationId, messageID)
    let submitted = false
    try { while (true) {
      signal?.throwIfAborted()
      const response = await this.options.server.request(withDirectory('/event', state.directory), {
        method: 'GET', headers: { accept: 'text/event-stream' },
      }, signal)
      if (!response.ok || !response.body) throw await responseError(response, 'OPENCODE_SSE_UNAVAILABLE', 'definite')
      if (!submitted) {
        const [providerID, ...modelParts] = state.configuration.model.split('/')
        await this.mutate(withDirectory(`/session/${encodeURIComponent(session.nativeSessionId)}/prompt_async`, state.directory), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messageID,
            model: { providerID, modelID: modelParts.join('/') },
            variant: state.configuration.variant,
            agent: state.configuration.nativeAgent,
            parts: [{ type: 'text', text: input.prompt }],
          }),
        }, signal)
        submitted = true
      }

      let terminal = false
      try {
        for await (const native of parseSse(response.body, signal)) {
          if (!belongsToSession(native, session.nativeSessionId)) continue
          const event = this.record(state, native)
          if (!event) continue
          if (state.configuration.thinking || !isReasoningEvent(native.type)) yield event
          if (native.type === 'permission.asked' && typeof native.properties?.id === 'string'
            && !state.seenPendingRequestIds.has(native.properties.id)) {
            state.seenPendingRequestIds.add(native.properties.id)
            yield this.synthetic(state, 'interaction.pending', {
              nativeRequestId: native.properties.id,
              correlationId: input.clientCorrelationId,
            })
          }
          if (native.type === 'session.idle' || native.type === 'session.error') {
            terminal = true
            break
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error
      }
      const reconciled = await this.reconcile(session, input.clientCorrelationId, signal)
      if (terminal || reconciled.terminalResult) return
      if (reconciled.pendingInteraction) {
        const requestID = reconciled.pendingInteraction.turn.nativeRequestId
        if (requestID && !state.seenPendingRequestIds.has(requestID)) {
          state.seenPendingRequestIds.add(requestID)
          yield this.synthetic(state, 'interaction.pending', { nativeRequestId: requestID, correlationId: input.clientCorrelationId })
        }
      }
      await abortableDelay(50, signal)
    } } finally {
      this.activeTurns.delete(session.nativeSessionId)
    }
  }

  async pending(session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined> {
    return (await this.pendingAll(session, signal))[0]
  }

  /** Concrete OpenCode seam used to reconcile V1 reject cascades across one native session. */
  async pendingAll(session: NativeSessionReference, signal?: AbortSignal): Promise<readonly PendingNativeInteraction[]> {
    const state = await this.requireSession(session, signal)
    const pending = await this.pendingRequests(state.directory, signal)
    return pending.filter((item) => item.sessionID === session.nativeSessionId).map((item) => pendingInteraction(session, item))
  }

  async respond(
    session: NativeSessionReference,
    nativeRequestId: string,
    option: ApprovalResponseOption,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.requireSession(session, signal)
    const before = await this.pendingRequests(state.directory, signal)
    const request = before.find((item) => item.id === nativeRequestId && item.sessionID === session.nativeSessionId)
    if (!request) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_NOT_PENDING', 'The native permission request is no longer pending.', 'definite')
    const expected = optionsForRequest(request.id).find((item) => item.optionId === option.optionId)
    if (!expected || !sameApprovalOption(expected, option)) {
      throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_OPTION_INVALID', 'The response option is not valid for this native request.', 'definite')
    }
    const reply = option.semantic === 'approve_once' ? 'once'
      : option.semantic === 'provider_scoped_allow' ? 'always'
        : option.semantic === 'reject' ? 'reject' : undefined
    if (!reply) throw new OpenCodeNativeDeliveryError('OPENCODE_PERMISSION_SEMANTIC_UNSUPPORTED', 'OpenCode V1 cannot represent this response semantic.', 'definite')
    await this.mutate(withDirectory(`/permission/${encodeURIComponent(nativeRequestId)}/reply`, state.directory), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply }),
    }, signal)
  }

  async cancel(session: NativeSessionReference, signal?: AbortSignal): Promise<boolean> {
    const state = await this.requireSession(session, signal)
    const result = await this.mutate(withDirectory(`/session/${encodeURIComponent(session.nativeSessionId)}/abort`, state.directory), { method: 'POST' }, signal)
    if (result !== true) return false
    const pending = (await this.pendingRequests(state.directory, signal)).filter((item) => item.sessionID === session.nativeSessionId)
    if (pending[0]) {
      // V1 reject is the native operation that clears every pending ask in this target session.
      await this.mutate(withDirectory(`/permission/${encodeURIComponent(pending[0].id)}/reply`, state.directory), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'reject' }),
      }, signal)
    }
    return true
  }

  async history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory> {
    const state = await this.requireSession(session, signal)
    const messages = await this.messages(session.nativeSessionId, state.directory, signal)
    const terminalResult = finalResult(messages)
    const pendingInteractions = await this.pendingAll(session, signal)
    const pendingInteraction = pendingInteractions[0]
    return { events: [...state.events], pendingInteractions, ...(pendingInteraction ? { pendingInteraction } : {}), ...(terminalResult ? { terminalResult } : {}) }
  }

  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
    const state = await this.requireSession(session, signal)
    const messages = await this.messages(session.nativeSessionId, state.directory, signal)
    const parentID = state.correlationMessages.get(correlationId)
    const terminalResult = finalResult(messages, parentID)
    const pendingInteractions = await this.pendingAll(session, signal)
    const pendingInteraction = pendingInteractions[0]
    return { events: [...state.events], pendingInteractions, ...(pendingInteraction ? { pendingInteraction } : {}), ...(terminalResult ? { terminalResult } : {}) }
  }

  async close(session: NativeSessionReference): Promise<void> {
    this.sessions.delete(session.nativeSessionId)
  }

  async dispose(): Promise<void> {
    this.sessions.clear()
    await this.options.server.dispose()
  }

  /** Credential renewal is process replacement only; environment is never changed on a running server. */
  async restartForCredential(environment: ChildProcessEnvironment, signal?: AbortSignal): Promise<void> {
    if (environment.agentId !== this.options.ownerAgentId) {
      throw new HarnessExecutionError('OPENCODE_CREDENTIAL_OWNER_MISMATCH', 'The replacement credential belongs to another Agent.')
    }
    if (this.activeTurns.size > 0) {
      throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_BUSY', 'OpenCode credentials can only rotate while every owned native turn is idle.')
    }
    if (!this.options.server.restart) {
      throw new HarnessExecutionError('OPENCODE_SERVER_RESTART_UNSUPPORTED', 'This OpenCode server controller cannot replace its credential environment.')
    }
    await this.options.server.restart(environment, signal)
    await this.qualifyServer(signal)
  }

  async inspectNativeMcp(directory: string, signal?: AbortSignal): Promise<OpenCodeMcpInspection> {
    await this.qualifyServer(signal)
    const [configValue, statusesValue] = await Promise.all([
      this.json('/config', { method: 'GET', directory }, signal),
      this.json('/mcp', { method: 'GET', directory }, signal),
    ])
    const config = asObject(configValue)
    const statuses = asObject(statusesValue)
    const name = this.options.appMcpServerName ?? 'graphql-app'
    const configured = objectField(config, 'mcp')[name]
    const status = objectField(statuses, name)
    const nativeStatus = nativeMcpStatus(configured, status)
    const endpoint = configured && typeof configured === 'object' && !Array.isArray(configured)
      ? nullableString((configured as JsonObject).url) : null
    const environmentReference = configured && typeof configured === 'object' && !Array.isArray(configured)
      ? credentialEnvironmentReference(configured as JsonObject) : null
    const expected = this.options.expectedAppMcpEndpoint
    return {
      cwd: directory, providerVersion: QUALIFIED_VERSION, serverName: name,
      nativeStatus, endpoint, credentialEnvironmentVariable: environmentReference,
      endpointMatches: expected ? endpoint === expected : null,
      effectiveFilters: permissionRules(config),
      ...(typeof status.error === 'string' ? { detail: status.error } : {}),
    }
  }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    const first = this.sessions.values().next().value as SessionState | undefined
    if (!first) {
      return {
        harness: 'opencode', serverName: this.options.appMcpServerName ?? 'graphql-app', state: 'status_unavailable',
        endpointMatches: null, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString(),
        detail: 'A runner working directory is required for resolved OpenCode MCP inspection.',
      }
    }
    try {
      const native = await this.inspectNativeMcp(first.directory, signal)
      return {
        harness: 'opencode', serverName: native.serverName,
        state: detectionState(native.nativeStatus, native.endpointMatches),
        endpointMatches: native.endpointMatches,
        credentialEnvironmentVariable: native.credentialEnvironmentVariable,
        checkedAt: new Date().toISOString(), ...(native.detail ? { detail: native.detail } : {}),
      }
    } catch (error) {
      return {
        harness: 'opencode', serverName: this.options.appMcpServerName ?? 'graphql-app', state: 'check_failed',
        endpointMatches: null, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString(),
        detail: error instanceof Error ? error.message : 'OpenCode MCP inspection failed.',
      }
    }
  }

  private async qualifyServer(signal?: AbortSignal): Promise<void> {
    if (this.options.server.expectedVersion !== QUALIFIED_VERSION) {
      throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', `OpenCode server mode is qualified only for ${QUALIFIED_VERSION}.`)
    }
    await this.options.server.ensure(signal)
    const [healthValue, documentValue] = await Promise.all([
      this.json('/global/health', { method: 'GET' }, signal),
      this.json('/doc', { method: 'GET' }, signal),
    ])
    const health = asObject(healthValue)
    const document = asObject(documentValue)
    if (health.healthy !== true || health.version !== QUALIFIED_VERSION) {
      throw new HarnessExecutionError('OPENCODE_SERVER_VERSION_UNQUALIFIED', 'The live OpenCode health/version did not match 1.18.31.')
    }
    const paths = objectField(document, 'paths')
    for (const path of ['/session', '/session/{sessionID}/prompt_async', '/session/{sessionID}/abort', '/permission', '/permission/{requestID}/reply', '/event', '/config', '/mcp']) {
      if (!(path in paths)) throw new HarnessExecutionError('OPENCODE_SERVER_SCHEMA_UNQUALIFIED', `The live OpenCode schema is missing ${path}.`)
    }
  }

  private async qualifyConfiguration(configuration: OpenCodeHarnessConfiguration, directory: string, signal?: AbortSignal): Promise<void> {
    if (configuration.autoApprove || configuration.advanced?.permissionHandling === 'native_auto') {
      throw new HarnessExecutionError('OPENCODE_SERVER_AUTO_CONFLICT', 'Native automatic permission handling cannot run with GraphQL-routed review.')
    }
    if (this.options.server instanceof ManagedOpenCodeServer
      && JSON.stringify(configuration.advanced) !== JSON.stringify(this.options.server.advancedConfiguration)) {
      throw new HarnessExecutionError('OPENCODE_SERVER_CONFIGURATION_MISMATCH', 'OpenCode process-level Advanced settings differ from the session configuration.')
    }
    const [providerID, ...modelParts] = configuration.model.split('/')
    if (!providerID || modelParts.length === 0) throw new HarnessExecutionError('OPENCODE_MODEL_INVALID', 'OpenCode models require provider/model format.')
    const [providers, agents] = await Promise.all([
      this.json('/provider', { method: 'GET', directory }, signal),
      this.json('/agent', { method: 'GET', directory }, signal),
    ])
    if (!providerSupports(providers, providerID, modelParts.join('/'), configuration.variant)) {
      throw new HarnessExecutionError('OPENCODE_MODEL_UNAVAILABLE', `OpenCode model '${configuration.model}' or variant '${configuration.variant}' is unavailable.`)
    }
    if (!Array.isArray(agents) || !agents.some((agent) => valueField(agent, 'name') === configuration.nativeAgent)) {
      throw new HarnessExecutionError('OPENCODE_NATIVE_AGENT_UNAVAILABLE', `OpenCode native Agent '${configuration.nativeAgent}' is unavailable.`)
    }
  }

  private async applyMcpControls(configuration: OpenCodeHarnessConfiguration, directory: string, signal?: AbortSignal): Promise<void> {
    const controls = configuration.advanced?.mcp.serverEnabled
    if (!controls || Object.keys(controls).length === 0) return
    const config = asObject(await this.json('/config', { method: 'GET', directory }, signal))
    const configured = objectField(config, 'mcp')
    for (const [name, enabled] of Object.entries(controls)) {
      if (!(name in configured)) {
        throw new HarnessExecutionError('OPENCODE_MCP_SERVER_NOT_CONFIGURED', `OpenCode MCP server '${name}' is not present in resolved config.`)
      }
      await this.mutate(withDirectory(`/mcp/${encodeURIComponent(name)}/${enabled ? 'connect' : 'disconnect'}`, directory), { method: 'POST' }, signal)
    }
  }

  private verifyAttachedSession(
    native: JsonObject,
    sessionID: string,
    directory: string,
    configuration: OpenCodeHarnessConfiguration,
  ): void {
    if (native.id !== sessionID) {
      throw new HarnessExecutionError('OPENCODE_SESSION_ID_MISMATCH', 'OpenCode returned a different persisted session identity.')
    }
    if (native.directory !== directory) {
      throw new HarnessExecutionError('OPENCODE_SESSION_DIRECTORY_MISMATCH', 'The persisted OpenCode session belongs to a different working directory.')
    }
    if (typeof native.agent === 'string' && native.agent !== configuration.nativeAgent) {
      throw new HarnessExecutionError('OPENCODE_SESSION_CONFIGURATION_MISMATCH', 'The persisted OpenCode session native Agent differs from its pinned configuration.')
    }
    const model = objectField(native, 'model')
    if (Object.keys(model).length === 0) return
    const [providerID, ...modelParts] = configuration.model.split('/')
    if (model.providerID !== providerID || model.id !== modelParts.join('/')
      || (typeof model.variant === 'string' && model.variant !== configuration.variant)) {
      throw new HarnessExecutionError('OPENCODE_SESSION_CONFIGURATION_MISMATCH', 'The persisted OpenCode session model differs from its pinned configuration.')
    }
  }

  private configuration(input: NativeSessionStart): OpenCodeHarnessConfiguration {
    if (input.kind === 'operator') {
      const configuration = input.configuration.harness
      if (configuration.harness !== 'opencode') throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'OpenCode received a non-OpenCode configuration.')
      return configuration
    }
    const configuration = input.request.configuration.harness
    if (configuration.harness !== 'opencode') throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'OpenCode received a non-OpenCode configuration.')
    return configuration
  }

  private async requireSession(session: NativeSessionReference, signal?: AbortSignal): Promise<SessionState> {
    signal?.throwIfAborted()
    if (session.harness !== 'opencode' || session.providerVersion !== QUALIFIED_VERSION) {
      throw new HarnessExecutionError('OPENCODE_SESSION_UNQUALIFIED', 'The native session is not qualified for this OpenCode manager.')
    }
    const local = this.sessions.get(session.nativeSessionId)
    if (local) return local
    throw new HarnessExecutionError('OPENCODE_SESSION_CONTEXT_MISSING', 'The native session working-directory/configuration context is unavailable.')
  }

  private async pendingRequests(directory: string, signal?: AbortSignal): Promise<NativePermissionRequest[]> {
    const result = await this.json('/permission', { method: 'GET', directory }, signal)
    return Array.isArray(result) ? result.filter(isPermissionRequest) : []
  }

  private messages(sessionID: string, directory: string, signal?: AbortSignal): Promise<NativeMessage[]> {
    return this.json(`/session/${encodeURIComponent(sessionID)}/message`, { method: 'GET', directory }, signal)
      .then((value) => Array.isArray(value) ? value.filter(isNativeMessage) : [])
  }

  private record(state: SessionState, native: NativeEvent): NativeHarnessEvent | undefined {
    if (native.id && state.seenEventIds.has(native.id)) return undefined
    if (native.id) state.seenEventIds.add(native.id)
    const event = NativeHarnessEventSchema.parse({
      sequence: state.sequence++, type: native.type, occurredAt: new Date().toISOString(),
      payload: { ...(native.properties ?? {}), ...(native.id ? { nativeEventId: native.id } : {}) },
    })
    state.events.push(event)
    return event
  }

  private synthetic(state: SessionState, type: string, payload: JsonObject): NativeHarnessEvent {
    const event = NativeHarnessEventSchema.parse({ sequence: state.sequence++, type, occurredAt: new Date().toISOString(), payload })
    state.events.push(event)
    return event
  }

  private async json(path: string, input: { method: string; directory?: string; body?: unknown }, signal?: AbortSignal): Promise<unknown> {
    const target = input.directory ? withDirectory(path, input.directory) : path
    const response = await this.options.server.request(target, {
      method: input.method,
      ...(input.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.body) }),
    }, signal)
    if (!response.ok) throw await responseError(response, 'OPENCODE_SERVER_REQUEST_FAILED', 'definite')
    return response.status === 204 ? undefined : response.json()
  }

  private async mutate(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    let response: Response
    try {
      response = await this.options.server.request(path, init, signal)
    } catch (error) {
      throw new OpenCodeNativeDeliveryError('OPENCODE_NATIVE_DELIVERY_UNCERTAIN', 'The OpenCode mutation outcome is uncertain after a transport failure.', 'uncertain', { cause: error })
    }
    if (!response.ok) throw await responseError(response, 'OPENCODE_NATIVE_DELIVERY_REJECTED', response.status >= 500 ? 'uncertain' : 'definite')
    return response.status === 204 ? undefined : response.json()
  }
}

/** Merge only GraphQL-owned process settings while preserving every unrelated native config key. */
export function buildOpenCodeConfigContent(
  inherited: string | undefined,
  advanced: OpenCodeAdvancedConfiguration,
): string {
  let base: JsonObject = {}
  if (inherited) {
    try {
      const parsed: unknown = JSON.parse(inherited)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      base = parsed as JsonObject
    } catch {
      throw new HarnessExecutionError('OPENCODE_CONFIG_CONTENT_INVALID', 'Inherited OPENCODE_CONFIG_CONTENT is not a JSON object.')
    }
  }
  const compaction = {
    ...objectField(base, 'compaction'),
    auto: advanced.compaction.auto,
    prune: advanced.compaction.prune,
    ...(advanced.compaction.reservedTokens === undefined ? {} : { reserved: advanced.compaction.reservedTokens }),
    ...(advanced.compaction.tailTurns === undefined ? {} : { tail_turns: advanced.compaction.tailTurns }),
    ...(advanced.compaction.preserveRecentTokens === undefined ? {} : { preserve_recent_tokens: advanced.compaction.preserveRecentTokens }),
  }
  return JSON.stringify({
    ...base,
    compaction,
    ...(advanced.subagentDepth === undefined ? {} : { subagent_depth: advanced.subagentDepth }),
  })
}

function withDirectory(path: string, directory: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}directory=${encodeURIComponent(directory)}`
}

function nativePermissionName(permission: string): string {
  if (permission === 'shell') return 'bash'
  if (permission === 'subagent') return 'task'
  return permission
}

function isReasoningEvent(type: string): boolean {
  return type.includes('reasoning') || type.includes('thinking')
}

function messageId(correlationId: string): string {
  return `msg_${createHash('sha256').update(correlationId).digest('hex').slice(0, 24)}`
}

function optionsForRequest(requestID: string): ApprovalResponseOption[] {
  return OPENCODE_APPROVAL_OPTIONS_FIXTURE.map((option) => ({ ...option, optionId: `${requestID}:${option.semantic}` }))
}

function sameApprovalOption(left: ApprovalResponseOption, right: ApprovalResponseOption): boolean {
  return left.optionId === right.optionId && left.semantic === right.semantic && left.label === right.label
    && left.persistence === right.persistence && left.scopeSummary === right.scopeSummary
    && left.affectsOtherPendingRequests === right.affectsOtherPendingRequests
    && left.interruptsCurrentTurn === right.interruptsCurrentTurn
    && left.mutatesPersistentPolicy === right.mutatesPersistentPolicy
}

function pendingInteraction(session: NativeSessionReference, request: NativePermissionRequest): PendingNativeInteraction {
  return PendingNativeInteractionSchema.parse({
    session,
    turn: { nativeTurnId: request.tool?.messageID ?? request.id, nativeRequestId: request.id },
    nativeRequestType: 'permission.asked',
    request: {
      id: request.id, sessionID: request.sessionID, permission: request.permission,
      patterns: request.patterns, metadata: request.metadata, always: request.always,
      ...(request.tool ? { tool: request.tool } : {}),
    },
    responseOptions: optionsForRequest(request.id),
  })
}

function isPermissionRequest(value: unknown): value is NativePermissionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as JsonObject
  return typeof item.id === 'string' && typeof item.sessionID === 'string' && typeof item.permission === 'string'
    && Array.isArray(item.patterns) && Array.isArray(item.always) && !!item.metadata && typeof item.metadata === 'object'
}

function isNativeMessage(value: unknown): value is NativeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as JsonObject
  return !!item.info && typeof item.info === 'object' && Array.isArray(item.parts)
}

function finalResult(messages: NativeMessage[], parentID?: string): NativeHistory['terminalResult'] | undefined {
  const assistant = [...messages].reverse().find((message) => {
    const info = message.info
    return info.role === 'assistant' && typeof objectField(info, 'time').completed === 'number'
      && (!parentID || info.parentID === parentID)
  })
  if (!assistant) return undefined
  if (assistant.info.error) {
    const error = asObject(assistant.info.error)
    const data = objectField(error, 'data')
    return { outcome: 'failed', error: {
      code: typeof error.name === 'string' ? error.name : 'OPENCODE_TURN_FAILED',
      message: typeof data.message === 'string' ? data.message : typeof error.message === 'string' ? error.message : 'OpenCode turn failed.',
      retryable: data.isRetryable === true,
    } }
  }
  const text = assistant.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.ignored !== true)
    .map((part) => part.text as string).join('')
  if (!text) return undefined
  return { outcome: 'succeeded', output: { text } }
}

async function* parseSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<NativeEvent> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let pending = ''
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) return
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        try {
          const parsed: unknown = JSON.parse(data)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as JsonObject).type === 'string') yield parsed as NativeEvent
        } catch {
          // A malformed frame is ignored; authoritative endpoints drive reconciliation.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function belongsToSession(event: NativeEvent, sessionID: string): boolean {
  const properties = event.properties ?? {}
  if (typeof properties.sessionID === 'string') return properties.sessionID === sessionID
  const info = properties.info
  if (info && typeof info === 'object' && !Array.isArray(info) && typeof (info as JsonObject).sessionID === 'string') return (info as JsonObject).sessionID === sessionID
  const part = properties.part
  if (part && typeof part === 'object' && !Array.isArray(part) && typeof (part as JsonObject).sessionID === 'string') return (part as JsonObject).sessionID === sessionID
  return false
}

async function responseError(response: Response, code: string, certainty: NativeDeliveryCertainty): Promise<OpenCodeNativeDeliveryError> {
  const detail = (await response.text()).slice(0, 2_000)
  return new OpenCodeNativeDeliveryError(code, detail || `OpenCode returned HTTP ${response.status}.`, certainty)
}

function stringField(value: unknown, key: string, code: string): string {
  const result = valueField(value, key)
  if (typeof result !== 'string') throw new HarnessExecutionError(code, `OpenCode response did not include ${key}.`)
  return result
}

function valueField(value: unknown, key: string): unknown {
  return asObject(value)[key]
}

function objectField(value: unknown, key: string): JsonObject {
  return asObject(valueField(value, key))
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function nullableString(value: unknown): string | null { return typeof value === 'string' ? value : null }

function providerSupports(value: unknown, providerID: string, modelID: string, variant: string): boolean {
  const all = valueField(value, 'all')
  const providers = Array.isArray(value) ? value : Array.isArray(all) ? all : []
  const provider = providers.find((item: unknown) => valueField(item, 'id') === providerID)
  const models = objectField(provider, 'models')
  const model = objectField(models, modelID)
  const variants = objectField(model, 'variants')
  return !!provider && !!model && (Object.keys(variants).length === 0 || variant in variants)
}

function nativeMcpStatus(configured: unknown, status: JsonObject): OpenCodeMcpInspection['nativeStatus'] {
  if (!configured) return 'not_detected'
  const native = status.status
  return native === 'connected' || native === 'disabled' || native === 'failed' || native === 'needs_auth' || native === 'needs_client_registration'
    ? native : 'failed'
}

function credentialEnvironmentReference(config: JsonObject): string | null {
  const headers = objectField(config, 'headers')
  for (const value of Object.values(headers)) {
    if (typeof value !== 'string') continue
    const match = value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/) ?? value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
    if (match?.[1]) return match[1]
  }
  return null
}

function permissionRules(config: JsonObject): OpenCodeMcpInspection['effectiveFilters'] {
  const permission = valueField(config, 'permission')
  if (Array.isArray(permission)) {
    return permission.map((rule) => ({
      permission: String(valueField(rule, 'permission')), pattern: String(valueField(rule, 'pattern')),
      effect: String(valueField(rule, 'action') || valueField(rule, 'effect')),
    }))
  }
  return []
}

function detectionState(status: OpenCodeMcpInspection['nativeStatus'], endpointMatches: boolean | null): McpDetection['state'] {
  if (status === 'not_detected') return 'not_detected'
  if (endpointMatches === false) return 'misconfigured'
  if (status === 'connected') return 'connected'
  if (status === 'disabled') return 'disabled'
  if (status === 'needs_auth' || status === 'needs_client_registration') return 'authentication_required'
  return 'broken'
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
