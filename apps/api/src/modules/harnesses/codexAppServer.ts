import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import {
  ApprovalResponseOptionSchema,
  DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  McpDetectionSchema,
  NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema,
  NativeSessionReferenceSchema,
  PendingNativeInteractionSchema,
  type ApprovalResponseOption,
  type ExecutionResult,
  type McpDetection,
  type NativeHarnessCapabilities,
  type NativeHarnessEvent,
  type NativeSessionReference,
  type PendingNativeInteraction,
  type CodexAdvancedConfiguration,
  type CodexHarnessConfiguration,
} from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from './port.js'
import { runCommand } from './process.js'

export const QUALIFIED_CODEX_VERSION = 'codex-cli 0.154.0'
/** SHA-256 of the sorted relative-path/file-SHA manifest from 0.154.0 --experimental JSON schemas. */
export const QUALIFIED_CODEX_SCHEMA_SHA256 = 'b785f87f96c4747e9db6c0492cea2de68e99b48f3462908174a1e8122a620054'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_STDERR_LENGTH = 128_000

type JsonObject = Record<string, unknown>
type RequestId = string | number

interface RpcRequest {
  id: RequestId
  method: string
  params?: JsonObject
}

interface StoredResponse {
  option: ApprovalResponseOption
  nativeResponse: JsonObject
}

interface WaitingRequest {
  pending: PendingNativeInteraction
  requestId: RequestId
  responses: Map<string, StoredResponse>
  delivery: 'pending' | 'uncertain'
}

interface Runtime {
  input: NativeSessionStart
  workingDirectory: string
  configuration: CodexHarnessConfiguration
  scopedCredentialVariable: string | undefined
  transport: CodexStdioTransport
  session: NativeSessionReference
  events: NativeHarnessEvent[]
  waiting: WaitingRequest | undefined
  activeTurnId: string | undefined
  terminalResult: ExecutionResult | undefined
  finalAnswer: string | undefined
  lastAgentMessage: string | undefined
  seenNotifications: Set<string>
  wake: Set<() => void>
  closed: boolean
}

export interface CodexMcpConfigurationInspection {
  providerVersion: string
  binary: string
  cwd: string
  serverName: string
  inspectionScope: 'effective_config'
  configured: {
    enabled: boolean
    required: boolean
    transport: 'stdio' | 'streamable_http' | 'unknown'
    url: string | null
    bearerTokenEnvironmentVariable: string | null
    enabledTools: string[] | null
    disabledTools: string[]
    defaultToolsApprovalMode: string | null
    tools: JsonObject
  }
}

export interface CodexQualificationEvidence {
  providerVersion: string
  schemaManifestSha256: string
  authentication: 'chatgpt'
  productionSupported: false
  productionRestriction: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertObject(value: unknown, code: string): JsonObject {
  if (!isObject(value)) throw new HarnessExecutionError(code, 'Codex app-server returned an invalid response.')
  return value
}

function threadDiagnostics(response: JsonObject): JsonObject {
  return {
    model: response.model,
    modelProvider: response.modelProvider,
    serviceTier: response.serviceTier,
    cwd: response.cwd,
    runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
    instructionSources: response.instructionSources,
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
    sandbox: response.sandbox,
    activePermissionProfile: response.activePermissionProfile,
    reasoningEffort: response.reasoningEffort,
  }
}

function safeEnvironment(input?: NativeSessionStart['environment'], scopedNames: readonly string[] = []): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_')
      || key.startsWith('GRAPHQL_APP_') || scopedNames.includes(key)
      || key === 'DATABASE_URL' || key === 'TEST_DATABASE_URL' || key === 'PGPASSWORD') {
      delete environment[key]
    }
  }
  if (input) Object.assign(environment, input.variables)
  return environment
}

function configuration(input: NativeSessionStart): CodexHarnessConfiguration {
  const value = input.kind === 'operator' ? input.configuration.harness : input.request.configuration.harness
  if (value.harness !== 'codex') {
    throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'Codex received a non-Codex configuration.')
  }
  return value
}

function advanced(value: CodexHarnessConfiguration): CodexAdvancedConfiguration {
  return value.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION
}

function appServerConfig(configurationValue: CodexHarnessConfiguration): JsonObject {
  const value = advanced(configurationValue)
  const config: JsonObject = { model_reasoning_effort: configurationValue.reasoningEffort }
  if (configurationValue.serviceTier === 'priority') config.service_tier = 'fast'
  if (value.workspaceWrite) {
    config.sandbox_workspace_write = {
      writable_roots: value.additionalWritableDirectories ?? [],
      network_access: value.workspaceWrite.networkAccess ?? false,
      exclude_tmpdir_env_var: value.workspaceWrite.excludeTmpdirEnvVar ?? false,
      exclude_slash_tmp: value.workspaceWrite.excludeSlashTmp ?? false,
    }
  }
  if (value.shellEnvironment) {
    config.shell_environment_policy = {
      inherit: value.shellEnvironment.inherit ?? 'all',
      ignore_default_excludes: value.shellEnvironment.ignoreDefaultExcludes ?? false,
      filters: value.shellEnvironment.filters ?? {},
      set: value.shellEnvironment.set ?? {},
    }
  }
  if (value.webSearch) config.web_search = value.webSearch
  return config
}

function validateConfiguration(configurationValue: CodexHarnessConfiguration): void {
  const value = advanced(configurationValue)
  if ((value.additionalWritableDirectories.length || value.workspaceWrite) && configurationValue.sandbox !== 'workspace-write') {
    throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'Workspace-write controls require the workspace-write sandbox.')
  }
  for (const directory of value.additionalWritableDirectories) {
    if (!directory.startsWith('/')) {
      throw new HarnessExecutionError('CODEX_SETTING_INVALID', 'Additional writable directories must be absolute paths.')
    }
  }
}

function validateEnvironmentOwner(input: NativeSessionStart, requiredVariable?: string): void {
  const expectedOwner = input.kind === 'operator' ? input.configuration.operatorId : input.request.configuration.agentId
  if (input.environment && input.environment.agentId !== expectedOwner) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The scoped process environment belongs to another Agent.')
  }
  if (requiredVariable && (!input.environment || typeof input.environment.variables[requiredVariable] !== 'string')) {
    throw new HarnessExecutionError(
      'CODEX_SCOPED_ENVIRONMENT_REQUIRED',
      `The enabled App MCP server requires a scoped '${requiredVariable}' process credential.`,
    )
  }
}

class CodexStdioTransport {
  private child?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<RequestId, {
    resolve(value: unknown): void
    reject(error: Error): void
    timer: NodeJS.Timeout
    wrote: boolean
  }>()
  private nextId = 1
  private stderr = ''
  private stopped = false

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly onRequest: (request: RpcRequest) => Promise<void>,
    private readonly onNotification: (method: string, params: JsonObject) => Promise<void>,
    private readonly onDisconnect: (error: Error) => void,
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const child = spawn(this.binary, ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: this.environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string | Buffer) => {
      this.stderr = (this.stderr + String(chunk)).slice(-MAX_STDERR_LENGTH)
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => { void this.receive(line) })
    child.once('error', (error) => this.disconnect(error))
    child.once('close', (code, exitSignal) => {
      if (!this.stopped) {
        this.disconnect(new HarnessExecutionError(
          'CODEX_APP_SERVER_DISCONNECTED',
          `Codex app-server disconnected (${String(code ?? exitSignal ?? 'unknown')}).`,
        ))
      }
    })
    const abort = () => { void this.close() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      await this.request('initialize', {
        clientInfo: { name: 'graphql', title: 'GraphQL', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, signal)
      this.notify('initialized')
    } catch (error) {
      await this.close()
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async request(method: string, params?: JsonObject, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const child = this.child
    if (!child || this.stopped || child.stdin.destroyed) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Codex app-server is not connected.')
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HarnessExecutionError('CODEX_APP_SERVER_TIMEOUT', `Codex app-server did not answer ${method}.`))
      }, REQUEST_TIMEOUT_MS)
      const operation = { resolve, reject, timer, wrote: false }
      this.pending.set(id, operation)
      const abort = () => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      const payload = JSON.stringify({ method, id, params }) + '\n'
      child.stdin.write(payload, (error) => {
        operation.wrote = !error
        if (error && this.pending.delete(id)) {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  notify(method: string, params?: JsonObject): void {
    if (!this.child || this.stopped || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify({ method, ...(params ? { params } : {}) }) + '\n')
  }

  async respond(id: RequestId, result: JsonObject): Promise<void> {
    const child = this.child
    if (!child || this.stopped || child.stdin.destroyed) {
      throw new HarnessExecutionError('NATIVE_RESPONSE_DELIVERY_FAILED', 'The native request is no longer connected.')
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify({ id, result }) + '\n', (error) => error ? reject(error) : resolve())
    }).catch(() => {
      throw new HarnessExecutionError(
        'NATIVE_RESPONSE_DELIVERY_UNCERTAIN',
        'The native response may have been written before the transport disconnected; reconcile before retrying.',
      )
    })
  }

  async reject(id: RequestId, code: number, message: string): Promise<void> {
    const child = this.child
    if (!child || this.stopped || child.stdin.destroyed) return
    await new Promise<void>((resolve) => {
      child.stdin.write(JSON.stringify({ id, error: { code, message } }) + '\n', () => resolve())
    })
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const child = this.child
    if (!child) return
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve()
      else child.once('close', () => resolve())
    })
  }

  private async receive(line: string): Promise<void> {
    let message: unknown
    try { message = JSON.parse(line) } catch {
      await this.onNotification('protocol/malformed', { redacted: true })
      return
    }
    if (!isObject(message)) {
      await this.onNotification('protocol/malformed', { redacted: true })
      return
    }
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined
    const method = text(message.method)
    if (id !== undefined && method) {
      await this.onRequest({ id, method, ...(isObject(message.params) ? { params: message.params } : {}) })
      return
    }
    if (id !== undefined) {
      const operation = this.pending.get(id)
      if (!operation) return
      this.pending.delete(id)
      clearTimeout(operation.timer)
      if (isObject(message.error)) {
        operation.reject(new HarnessExecutionError(
          'CODEX_APP_SERVER_REQUEST_FAILED',
          text(message.error.message) ?? 'Codex app-server rejected a request.',
        ))
      } else operation.resolve(message.result)
      return
    }
    if (method) await this.onNotification(method, isObject(message.params) ? message.params : {})
    else await this.onNotification('protocol/unknown', { redacted: true })
  }

  private disconnect(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    for (const operation of this.pending.values()) {
      clearTimeout(operation.timer)
      operation.reject(new HarnessExecutionError(
        operation.wrote ? 'CODEX_APP_SERVER_REQUEST_UNCERTAIN' : 'CODEX_APP_SERVER_DISCONNECTED',
        operation.wrote
          ? 'Codex app-server disconnected after request delivery; reconcile before retrying.'
          : 'Codex app-server disconnected before request delivery.',
      ))
    }
    this.pending.clear()
    this.onDisconnect(error)
  }
}

export class CodexAppServerSessionManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  private readonly runtimes = new Map<string, Runtime>()
  private qualified?: NativeHarnessCapabilities

  constructor(
    private readonly binary: string,
    private readonly expectedVersion = QUALIFIED_CODEX_VERSION,
    private readonly appMcpServerName = 'graphql-app',
  ) {}

  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    if (this.qualified) return this.qualified
    const version = await runCommand(this.binary, ['--version'], process.cwd(), signal)
    const actual = (version.stdout || version.stderr).trim()
    if (version.exitCode !== 0 || actual !== this.expectedVersion) {
      throw new HarnessExecutionError(
        'CODEX_APP_SERVER_VERSION_UNQUALIFIED',
        `Codex app-server requires exact version '${this.expectedVersion}' (found '${actual || 'unavailable'}').`,
      )
    }
    const auth = await runCommand(this.binary, ['login', 'status'], process.cwd(), signal)
    if (auth.exitCode !== 0 || !`${auth.stdout}\n${auth.stderr}`.includes('Logged in using ChatGPT')) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_AUTH_UNQUALIFIED', 'Managed ChatGPT authentication is required.')
    }
    this.qualified = NativeHarnessCapabilitiesSchema.parse({
      provider: 'codex', providerVersion: actual, persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true, supportedInteractionKinds: [
        'command_approval', 'file_approval', 'permission_profile', 'tool_user_input', 'mcp_elicitation',
      ],
    })
    return this.qualified
  }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    await this.capabilities(signal)
    const result = await runCommand(this.binary, ['mcp', 'get', this.appMcpServerName, '--json'], process.cwd(), signal)
    const now = new Date().toISOString()
    if (result.exitCode !== 0) {
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName, state: 'not_detected', endpointMatches: null,
        credentialEnvironmentVariable: null, checkedAt: now,
      })
    }
    try {
      const config = assertObject(JSON.parse(result.stdout), 'CODEX_MCP_CONFIG_INVALID')
      const transport = isObject(config.transport) ? config.transport : {}
      const enabled = config.enabled !== false
      const credentialEnvironmentVariable = text(transport.bearer_token_env_var) ?? null
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName,
        state: enabled ? 'status_unavailable' : 'disabled', endpointMatches: null,
        credentialEnvironmentVariable, checkedAt: now,
        detail: 'CLI inspection proves configuration only; call inspectNativeMcp for runtime status.',
      })
    } catch {
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName, state: 'check_failed', endpointMatches: null,
        credentialEnvironmentVariable: null, checkedAt: now, detail: 'Codex returned invalid structured MCP configuration.',
      })
    }
  }

  async qualificationEvidence(signal?: AbortSignal): Promise<CodexQualificationEvidence> {
    const capability = await this.capabilities(signal)
    return {
      providerVersion: capability.providerVersion,
      schemaManifestSha256: QUALIFIED_CODEX_SCHEMA_SHA256,
      authentication: 'chatgpt',
      productionSupported: false,
      productionRestriction: 'Codex app-server remains experimental and unsupported for production workloads; codex exec stays enabled.',
    }
  }

  async inspectMcpConfiguration(cwd: string, signal?: AbortSignal): Promise<CodexMcpConfigurationInspection> {
    const capability = await this.capabilities(signal)
    const result = await runCommand(this.binary, ['mcp', 'get', this.appMcpServerName, '--json'], cwd, signal)
    if (result.exitCode !== 0) {
      throw new HarnessExecutionError('CODEX_MCP_NOT_CONFIGURED', `Codex MCP server '${this.appMcpServerName}' is not configured.`)
    }
    let parsed: JsonObject
    try { parsed = assertObject(JSON.parse(result.stdout), 'CODEX_MCP_CONFIG_INVALID') } catch {
      throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid structured MCP configuration.')
    }
    const enabledTools = Array.isArray(parsed.enabled_tools) ? parsed.enabled_tools.filter((value): value is string => typeof value === 'string') : null
    const disabledTools = Array.isArray(parsed.disabled_tools) ? parsed.disabled_tools.filter((value): value is string => typeof value === 'string') : []
    const transport = isObject(parsed.transport) ? parsed.transport : {}
    const url = text(transport.url) ?? null
    return {
      providerVersion: capability.providerVersion,
      binary: this.binary,
      cwd,
      serverName: this.appMcpServerName,
      inspectionScope: 'effective_config',
      configured: {
        enabled: parsed.enabled !== false,
        required: parsed.required === true,
        transport: transport.type === 'streamable_http' || transport.type === 'stdio'
          ? transport.type
          : url ? 'streamable_http' : text(transport.command) ? 'stdio' : 'unknown',
        url,
        bearerTokenEnvironmentVariable: text(transport.bearer_token_env_var) ?? null,
        enabledTools,
        disabledTools,
        defaultToolsApprovalMode: text(parsed.default_tools_approval_mode) ?? null,
        tools: isObject(parsed.tools) ? parsed.tools : {},
      },
    }
  }

  async createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    const { harnessConfiguration, workingDirectory, scopedCredentialVariable } = await this.prepareInput(input, signal)
    const holder: { runtime?: Runtime } = {}
    const transport = new CodexStdioTransport(
      this.binary,
      workingDirectory,
      safeEnvironment(input.environment, scopedCredentialVariable ? [scopedCredentialVariable] : []),
      async (request) => {
        if (holder.runtime) await this.handleRequest(holder.runtime, request)
        else await transport.reject(request.id, -32000, 'Native interaction arrived before session initialization completed.')
      },
      async (method, params) => { if (holder.runtime) this.handleNotification(holder.runtime, method, params) },
      () => { if (holder.runtime) this.handleDisconnect(holder.runtime) },
    )
    await transport.start(signal)
    let registeredSessionId: string | undefined
    try {
      const draft = advanced(harnessConfiguration)
      const response = assertObject(await transport.request('thread/start', {
        model: harnessConfiguration.model,
        serviceTier: harnessConfiguration.serviceTier === 'priority' ? 'fast' : null,
        cwd: workingDirectory,
        runtimeWorkspaceRoots: [workingDirectory, ...draft.additionalWritableDirectories],
        approvalPolicy: draft.approvalPolicy,
        approvalsReviewer: draft.approvalsReviewer,
        sandbox: harnessConfiguration.sandbox,
        config: appServerConfig(harnessConfiguration),
        ephemeral: draft.sessionPersistence === 'ephemeral',
      }, signal), 'CODEX_THREAD_START_INVALID')
      const thread = assertObject(response.thread, 'CODEX_THREAD_START_INVALID')
      const nativeSessionId = text(thread.id)
      if (!nativeSessionId) throw new HarnessExecutionError('CODEX_SESSION_ID_MISSING', 'Codex did not return a native thread ID.')
      const session = NativeSessionReferenceSchema.parse({ harness: 'codex', providerVersion: this.expectedVersion, nativeSessionId })
      const runtime: Runtime = {
        input, workingDirectory, configuration: harnessConfiguration,
        scopedCredentialVariable,
        transport, session, events: [], waiting: undefined, activeTurnId: undefined,
        terminalResult: undefined, finalAnswer: undefined, lastAgentMessage: undefined,
        seenNotifications: new Set(), wake: new Set(), closed: false,
      }
      holder.runtime = runtime
      this.runtimes.set(nativeSessionId, runtime)
      registeredSessionId = nativeSessionId
      this.record(runtime, 'thread.started', { threadId: nativeSessionId, thread, diagnostics: threadDiagnostics(response) })
      return session
    } catch (error) {
      if (registeredSessionId) this.runtimes.delete(registeredSessionId)
      await transport.close()
      throw error
    }
  }

  async attachSession(
    session: NativeSessionReference,
    input: NativeSessionStart,
    signal?: AbortSignal,
  ): Promise<NativeSessionReference> {
    if (session.harness !== 'codex' || session.providerVersion !== this.expectedVersion) {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The persisted session does not match the qualified Codex version.')
    }
    const prepared = await this.prepareInput(input, signal)
    const loaded = this.runtimes.get(session.nativeSessionId)
    if (loaded) {
      if (loaded.workingDirectory !== prepared.workingDirectory
        || loaded.configuration.model !== prepared.harnessConfiguration.model
        || loaded.configuration.reasoningEffort !== prepared.harnessConfiguration.reasoningEffort) {
        throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH', 'The loaded Codex session has a different accepted configuration.')
      }
      await loaded.transport.request('thread/read', { threadId: session.nativeSessionId, includeTurns: false }, signal)
      return loaded.session
    }
    const holder: { runtime?: Runtime } = {}
    const transport = new CodexStdioTransport(
      this.binary,
      prepared.workingDirectory,
      safeEnvironment(input.environment, prepared.scopedCredentialVariable ? [prepared.scopedCredentialVariable] : []),
      async (request) => { if (holder.runtime) await this.handleRequest(holder.runtime, request) },
      async (method, params) => { if (holder.runtime) this.handleNotification(holder.runtime, method, params) },
      () => { if (holder.runtime) this.handleDisconnect(holder.runtime) },
    )
    await transport.start(signal)
    const runtime: Runtime = {
      input,
      workingDirectory: prepared.workingDirectory,
      configuration: prepared.harnessConfiguration,
      scopedCredentialVariable: prepared.scopedCredentialVariable,
      transport,
      session,
      events: [],
      waiting: undefined,
      activeTurnId: undefined,
      terminalResult: undefined,
      finalAnswer: undefined,
      lastAgentMessage: undefined,
      seenNotifications: new Set(),
      wake: new Set(),
      closed: false,
    }
    holder.runtime = runtime
    try {
      const draft = advanced(prepared.harnessConfiguration)
      const response = assertObject(await transport.request('thread/resume', {
        threadId: session.nativeSessionId,
        model: prepared.harnessConfiguration.model,
        serviceTier: prepared.harnessConfiguration.serviceTier === 'priority' ? 'fast' : null,
        cwd: prepared.workingDirectory,
        runtimeWorkspaceRoots: [prepared.workingDirectory, ...draft.additionalWritableDirectories],
        approvalPolicy: draft.approvalPolicy,
        approvalsReviewer: draft.approvalsReviewer,
        sandbox: prepared.harnessConfiguration.sandbox,
        config: appServerConfig(prepared.harnessConfiguration),
        excludeTurns: false,
      }, signal), 'CODEX_THREAD_RESUME_INVALID')
      const thread = assertObject(response.thread, 'CODEX_THREAD_RESUME_INVALID')
      if (text(thread.id) !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex resumed a different native thread identity.')
      }
      this.hydrateThread(runtime, thread)
      this.runtimes.set(session.nativeSessionId, runtime)
      this.record(runtime, 'thread.attached', {
        threadId: session.nativeSessionId, thread, diagnostics: threadDiagnostics(response),
      })
      return session
    } catch (error) {
      runtime.closed = true
      this.runtimes.delete(session.nativeSessionId)
      await transport.close()
      throw error
    }
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const runtime = this.requireRuntime(session)
    if (runtime.activeTurnId && !runtime.terminalResult) {
      throw new HarnessExecutionError('CODEX_TURN_ACTIVE', 'This Codex thread already has an active turn.')
    }
    runtime.terminalResult = undefined
    runtime.finalAnswer = undefined
    runtime.lastAgentMessage = undefined
    const offset = runtime.events.length
    const response = assertObject(await runtime.transport.request('turn/start', {
      threadId: session.nativeSessionId,
      clientUserMessageId: input.clientCorrelationId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
    }, signal), 'CODEX_TURN_START_INVALID')
    const turn = assertObject(response.turn, 'CODEX_TURN_START_INVALID')
    const turnId = text(turn.id)
    if (!turnId) throw new HarnessExecutionError('CODEX_TURN_ID_MISSING', 'Codex did not return a native turn ID.')
    runtime.activeTurnId = turnId
    this.record(runtime, 'turn.started', { threadId: session.nativeSessionId, turnId, clientCorrelationId: input.clientCorrelationId })
    let index = offset
    while (!signal?.aborted) {
      while (index < runtime.events.length) yield runtime.events[index++]!
      if (runtime.terminalResult || runtime.closed) return
      await this.wait(runtime, signal)
    }
  }

  async pending(session: NativeSessionReference): Promise<PendingNativeInteraction | undefined> {
    return this.requireRuntime(session).waiting?.pending
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption): Promise<void> {
    const runtime = this.requireRuntime(session)
    const waiting = runtime.waiting
    if (!waiting || waiting.pending.turn.nativeRequestId !== nativeRequestId) {
      throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The addressed native request is not pending in this session.')
    }
    const stored = waiting.responses.get(option.optionId)
    if (!stored) throw new HarnessExecutionError('NATIVE_RESPONSE_OPTION_INVALID', 'The selected response was not offered for this native request.')
    try {
      await runtime.transport.respond(waiting.requestId, stored.nativeResponse)
      runtime.waiting = undefined
      this.record(runtime, 'interaction.responded', { nativeRequestId, optionId: option.optionId, semantic: stored.option.semantic })
    } catch (error) {
      waiting.delivery = error instanceof HarnessExecutionError && error.result.error?.code === 'NATIVE_RESPONSE_DELIVERY_UNCERTAIN'
        ? 'uncertain' : waiting.delivery
      throw error
    }
  }

  async cancel(session: NativeSessionReference, signal?: AbortSignal): Promise<boolean> {
    const runtime = this.requireRuntime(session)
    if (!runtime.activeTurnId || runtime.terminalResult) return false
    await runtime.transport.request('turn/interrupt', {
      threadId: session.nativeSessionId,
      turnId: runtime.activeTurnId,
    }, signal)
    return true
  }

  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const runtime = this.requireRuntime(session)
    return {
      events: [...runtime.events],
      pendingInteractions: runtime.waiting ? [runtime.waiting.pending] : [],
      ...(runtime.waiting ? { pendingInteraction: runtime.waiting.pending } : {}),
      ...(runtime.terminalResult ? { terminalResult: runtime.terminalResult } : {}),
    }
  }

  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
    const runtime = this.requireRuntime(session)
    try {
      const response = assertObject(await runtime.transport.request('thread/read', {
        threadId: session.nativeSessionId, includeTurns: true,
      }, signal), 'CODEX_THREAD_READ_INVALID')
      this.record(runtime, 'thread.reconciled', { correlationId, thread: response.thread })
    } catch (error) {
      if (!runtime.closed) throw error
      await this.restart(runtime, signal)
      const response = assertObject(await runtime.transport.request('thread/read', {
        threadId: session.nativeSessionId, includeTurns: true,
      }, signal), 'CODEX_THREAD_READ_INVALID')
      this.record(runtime, 'thread.reconciled', { correlationId, restarted: true, thread: response.thread })
    }
    return this.history(session)
  }

  async close(session: NativeSessionReference): Promise<void> {
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime) return
    runtime.closed = true
    this.wake(runtime)
    await runtime.transport.close()
    this.runtimes.delete(session.nativeSessionId)
  }

  async inspectConfiguration(session: NativeSessionReference, includeLayers = true, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return assertObject(await runtime.transport.request('config/read', {
      includeLayers, cwd: runtime.workingDirectory,
    }, signal), 'CODEX_CONFIG_READ_INVALID')
  }

  async inspectNativeMcp(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return assertObject(await runtime.transport.request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly', threadId: session.nativeSessionId,
    }, signal), 'CODEX_MCP_STATUS_INVALID')
  }

  async listNativeModels(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return assertObject(await runtime.transport.request('model/list', { includeHidden: false }, signal), 'CODEX_MODEL_CATALOG_INVALID')
  }

  async reloadNativeMcp(session: NativeSessionReference, signal?: AbortSignal): Promise<void> {
    const runtime = this.requireRuntime(session)
    await runtime.transport.request('config/mcpServer/reload', undefined, signal)
  }

  async refreshProcessEnvironment(
    session: NativeSessionReference,
    environment: NonNullable<NativeSessionStart['environment']>,
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = this.requireRuntime(session)
    const currentAgentId = runtime.input.environment?.agentId
    if (!currentAgentId || currentAgentId !== environment.agentId) {
      throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'A Codex session cannot inherit another Agent\'s environment.')
    }
    if (runtime.scopedCredentialVariable && typeof environment.variables[runtime.scopedCredentialVariable] !== 'string') {
      throw new HarnessExecutionError(
        'CODEX_SCOPED_ENVIRONMENT_REQUIRED',
        `The replacement environment must include '${runtime.scopedCredentialVariable}'.`,
      )
    }
    if (runtime.waiting || (runtime.activeTurnId && !runtime.terminalResult)) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'Refresh the Codex process environment only at an idle turn boundary.')
    }
    await runtime.transport.close()
    runtime.input = { ...runtime.input, environment }
    runtime.closed = true
    await this.restart(runtime, signal)
    this.record(runtime, 'transport.environment_refreshed', { agentId: environment.agentId })
  }

  async startDeviceCodeLogin(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return assertObject(await runtime.transport.request('account/login/start', { type: 'chatgptDeviceCode' }, signal), 'CODEX_LOGIN_START_INVALID')
  }

  async cancelLogin(session: NativeSessionReference, loginId: string, signal?: AbortSignal): Promise<void> {
    const runtime = this.requireRuntime(session)
    await runtime.transport.request('account/login/cancel', { loginId }, signal)
  }

  private requireRuntime(session: NativeSessionReference): Runtime {
    if (session.harness !== 'codex') throw new HarnessExecutionError('HARNESS_SESSION_MISMATCH', 'Codex requires a Codex session.')
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime) throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The Codex native session is not loaded.')
    return runtime
  }

  private async prepareInput(input: NativeSessionStart, signal?: AbortSignal): Promise<{
    harnessConfiguration: CodexHarnessConfiguration
    workingDirectory: string
    scopedCredentialVariable: string | undefined
  }> {
    await this.capabilities(signal)
    const harnessConfiguration = configuration(input)
    validateConfiguration(harnessConfiguration)
    const workingDirectory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
    await this.validateMcpPolicies(harnessConfiguration, workingDirectory, signal)
    let scopedCredentialVariable: string | undefined
    try {
      const mcp = await this.inspectMcpConfiguration(workingDirectory, signal)
      scopedCredentialVariable = mcp.configured.enabled ? mcp.configured.bearerTokenEnvironmentVariable ?? undefined : undefined
    } catch (error) {
      if (!(error instanceof HarnessExecutionError) || error.result.error?.code !== 'CODEX_MCP_NOT_CONFIGURED') throw error
    }
    validateEnvironmentOwner(input, scopedCredentialVariable)
    return { harnessConfiguration, workingDirectory, scopedCredentialVariable }
  }

  private async validateMcpPolicies(
    configurationValue: CodexHarnessConfiguration,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const [serverName, expected] of Object.entries(advanced(configurationValue).mcpServers)) {
      const result = await runCommand(this.binary, ['mcp', 'get', serverName, '--json'], cwd, signal)
      if (result.exitCode !== 0) {
        throw new HarnessExecutionError(
          expected.required ? 'CODEX_REQUIRED_MCP_UNAVAILABLE' : 'CODEX_MCP_POLICY_MISMATCH',
          `Codex MCP server '${serverName}' is not configured on this runner.`,
        )
      }
      let actual: JsonObject
      try { actual = assertObject(JSON.parse(result.stdout), 'CODEX_MCP_CONFIG_INVALID') } catch {
        throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', `Codex returned invalid configuration for MCP server '${serverName}'.`)
      }
      const actualEnabled = actual.enabled !== false
      const actualRequired = actual.required === true
      const actualEnabledTools = Array.isArray(actual.enabled_tools) ? actual.enabled_tools.filter((value): value is string => typeof value === 'string') : undefined
      const actualDisabledTools = Array.isArray(actual.disabled_tools) ? actual.disabled_tools.filter((value): value is string => typeof value === 'string') : undefined
      const actualTools = isObject(actual.tools) ? actual.tools : undefined
      const mismatch = actualEnabled !== expected.enabled
        || actualRequired !== expected.required
        || !sameStrings(actualEnabledTools, expected.enabledTools)
        || !sameStrings(actualDisabledTools, expected.disabledTools)
        || text(actual.default_tools_approval_mode) !== expected.defaultToolsApprovalMode
        || (expected.tools !== undefined && JSON.stringify(actualTools ?? {}) !== JSON.stringify(expected.tools))
      if (mismatch) {
        throw new HarnessExecutionError(
          expected.required && (!actualEnabled || !actualRequired) ? 'CODEX_REQUIRED_MCP_UNAVAILABLE' : 'CODEX_MCP_POLICY_MISMATCH',
          `Codex MCP server '${serverName}' does not match the accepted enabled/required/tool policy; no configuration was rewritten.`,
        )
      }
    }
  }

  private hydrateThread(runtime: Runtime, thread: JsonObject): void {
    if (!Array.isArray(thread.turns) || thread.turns.length === 0) return
    const last = [...thread.turns].reverse().find(isObject)
    if (!last) return
    runtime.activeTurnId = text(last.id)
    if (!Array.isArray(last.items)) return
    for (const value of last.items) {
      if (!isObject(value) || value.type !== 'agentMessage' || typeof value.text !== 'string') continue
      runtime.lastAgentMessage = value.text
      if (value.phase === 'final_answer') runtime.finalAnswer = value.text
    }
    const status = text(last.status)
    if (status === 'completed') runtime.terminalResult = { outcome: 'succeeded', output: { text: runtime.finalAnswer ?? runtime.lastAgentMessage ?? '' } }
    else if (status === 'interrupted') runtime.terminalResult = { outcome: 'canceled' }
    else if (status === 'failed') runtime.terminalResult = {
      outcome: 'failed', error: { code: 'CODEX_TURN_FAILED', message: this.turnError(last), retryable: false },
    }
  }

  private async restart(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    if (runtime.waiting) {
      runtime.waiting.delivery = 'uncertain'
      throw new HarnessExecutionError(
        'NATIVE_RESPONSE_DELIVERY_UNCERTAIN',
        'A pending native request cannot be replayed after app-server restart.',
      )
    }
    const transport = new CodexStdioTransport(
      this.binary,
      runtime.workingDirectory,
      safeEnvironment(runtime.input.environment, runtime.scopedCredentialVariable ? [runtime.scopedCredentialVariable] : []),
      async (request) => this.handleRequest(runtime, request),
      async (method, params) => this.handleNotification(runtime, method, params),
      () => this.handleDisconnect(runtime),
    )
    await transport.start(signal)
    await transport.request('thread/resume', { threadId: runtime.session.nativeSessionId, excludeTurns: true }, signal)
    runtime.transport = transport
    runtime.closed = false
  }

  private async handleRequest(runtime: Runtime, request: RpcRequest): Promise<void> {
    if (runtime.waiting) {
      await runtime.transport.reject(request.id, -32000, 'Another native interaction is already pending.')
      this.record(runtime, 'protocol.concurrent_request_rejected', { method: request.method })
      return
    }
    const translated = this.translateRequest(runtime, request)
    if (!translated) {
      await runtime.transport.reject(request.id, -32601, 'Unsupported native interaction request.')
      this.record(runtime, 'protocol.unsupported_request', { method: request.method })
      return
    }
    runtime.waiting = translated
    this.record(runtime, 'interaction.pending', {
      nativeRequestId: translated.pending.turn.nativeRequestId,
      nativeRequestType: request.method,
      turnId: translated.pending.turn.nativeTurnId,
    })
  }

  private translateRequest(runtime: Runtime, request: RpcRequest): WaitingRequest | undefined {
    const params = request.params ?? {}
    const threadId = text(params.threadId)
    const turnId = text(params.turnId) ?? runtime.activeTurnId
    if (!threadId || threadId !== runtime.session.nativeSessionId || !turnId) return undefined
    const callbackId = text(params.approvalId) ?? String(request.id)
    const nativeRequestId = `${threadId}:${turnId}:${request.method}:${callbackId}`
    const responses = new Map<string, StoredResponse>()
    const add = (suffix: string, option: Omit<ApprovalResponseOption, 'optionId'>, nativeResponse: JsonObject) => {
      const optionId = `codex-${createHash('sha256').update(`${nativeRequestId}:${suffix}`).digest('hex').slice(0, 24)}`
      const parsed = ApprovalResponseOptionSchema.parse({ optionId, ...option })
      responses.set(optionId, { option: parsed, nativeResponse })
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      const decisions = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : ['accept', 'acceptForSession', 'decline', 'cancel']
      for (const decision of decisions) this.addCommandDecision(add, decision)
    } else if (request.method === 'item/fileChange/requestApproval') {
      add('accept', simpleOption('approve_once', 'Approve once', 'request'), { decision: 'accept' })
      add('acceptForSession', simpleOption('allow_session', 'Allow for this session', 'session'), { decision: 'acceptForSession' })
      add('decline', simpleOption('reject', 'Reject', 'request'), { decision: 'decline' })
      add('cancel', simpleOption('cancel', 'Cancel turn', 'request', true), { decision: 'cancel' })
    } else if (request.method === 'item/permissions/requestApproval') {
      const permissions = isObject(params.permissions) ? params.permissions : {}
      add('turn', simpleOption('allow_turn', 'Allow for this turn', 'turn'), { permissions, scope: 'turn' })
      if (advanced(runtime.configuration).sessionPersistence !== 'ephemeral') {
        add('session', simpleOption('allow_session', 'Allow for this session', 'session'), { permissions, scope: 'session' })
      }
      add('reject', simpleOption('reject', 'Reject', 'request'), { permissions: {}, scope: 'turn' })
    } else if (request.method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params.questions) ? params.questions.filter(isObject) : []
      if (questions.length !== 1) return undefined
      const question = questions[0]!
      const questionId = text(question.id)
      const options = Array.isArray(question.options) ? question.options.filter(isObject) : []
      if (!questionId || options.length === 0) return undefined
      for (const [index, offered] of options.entries()) {
        const label = text(offered.label)
        if (!label) continue
        add(`input-${String(index)}`, {
          semantic: 'provider_scoped_allow', label, persistence: /session/i.test(label) ? 'session' : 'request',
          scopeSummary: text(offered.description), affectsOtherPendingRequests: false,
          interruptsCurrentTurn: /cancel/i.test(label), mutatesPersistentPolicy: /don.t ask|persistent/i.test(label),
        }, { answers: { [questionId]: { answers: [label] } } })
      }
    } else if (request.method === 'mcpServer/elicitation/request') {
      add('decline', simpleOption('reject', 'Decline', 'request'), { action: 'decline', content: null, _meta: null })
      add('cancel', simpleOption('cancel', 'Cancel', 'request'), { action: 'cancel', content: null, _meta: null })
    } else return undefined
    if (responses.size === 0) return undefined
    const pending = PendingNativeInteractionSchema.parse({
      session: runtime.session,
      turn: { nativeTurnId: turnId, nativeRequestId },
      nativeRequestType: request.method,
      request: params,
      responseOptions: [...responses.values()].map(({ option }) => option),
    })
    return { pending, requestId: request.id, responses, delivery: 'pending' }
  }

  private addCommandDecision(
    add: (suffix: string, option: Omit<ApprovalResponseOption, 'optionId'>, response: JsonObject) => void,
    decision: unknown,
  ): void {
    if (decision === 'accept') add('accept', simpleOption('approve_once', 'Approve once', 'request'), { decision })
    else if (decision === 'acceptForSession') add('acceptForSession', simpleOption('allow_session', 'Allow for this session', 'session'), { decision })
    else if (decision === 'decline') add('decline', simpleOption('reject', 'Reject', 'request'), { decision })
    else if (decision === 'cancel') add('cancel', simpleOption('cancel', 'Cancel turn', 'request', true), { decision })
    else if (isObject(decision) && isObject(decision.acceptWithExecpolicyAmendment)) {
      add('execpolicy', {
        ...simpleOption('persistent_policy_change', 'Allow and save command policy', 'persistent_config'),
        mutatesPersistentPolicy: true,
      }, { decision })
    } else if (isObject(decision) && isObject(decision.applyNetworkPolicyAmendment)) {
      add('network-policy', {
        ...simpleOption('persistent_policy_change', 'Apply network policy change', 'persistent_config'),
        mutatesPersistentPolicy: true,
      }, { decision })
    }
  }

  private handleNotification(runtime: Runtime, method: string, params: JsonObject): void {
    if (method === 'item/completed') {
      const item = isObject(params.item) ? params.item : undefined
      const fingerprint = `${method}:${text(params.turnId) ?? ''}:${text(item?.id) ?? ''}:${String(params.completedAtMs ?? '')}`
      if (runtime.seenNotifications.has(fingerprint)) return
      runtime.seenNotifications.add(fingerprint)
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        runtime.lastAgentMessage = item.text
        if (item.phase === 'final_answer') runtime.finalAnswer = item.text
      }
      this.record(runtime, 'item.completed', params)
      return
    }
    if (method === 'item/started') {
      this.record(runtime, 'item.started', params)
      return
    }
    if (method === 'turn/started') {
      const turn = isObject(params.turn) ? params.turn : undefined
      runtime.activeTurnId = text(turn?.id) ?? runtime.activeTurnId
      this.record(runtime, 'turn.started', params)
      return
    }
    if (method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : undefined
      const fingerprint = `${method}:${text(turn?.id) ?? ''}:${text(turn?.status) ?? ''}`
      if (runtime.seenNotifications.has(fingerprint)) return
      runtime.seenNotifications.add(fingerprint)
      if (!runtime.finalAnswer && Array.isArray(turn?.items)) {
        for (const value of turn.items) {
          if (!isObject(value) || value.type !== 'agentMessage' || typeof value.text !== 'string') continue
          runtime.lastAgentMessage = value.text
          if (value.phase === 'final_answer') runtime.finalAnswer = value.text
        }
      }
      const status = text(turn?.status)
      runtime.terminalResult = status === 'completed'
        ? { outcome: 'succeeded', output: { text: runtime.finalAnswer ?? runtime.lastAgentMessage ?? '' } }
        : status === 'interrupted'
          ? { outcome: 'canceled' }
          : { outcome: 'failed', error: { code: 'CODEX_TURN_FAILED', message: this.turnError(turn), retryable: false } }
      runtime.waiting = undefined
      this.record(runtime, 'turn.completed', params)
      return
    }
    if (method === 'thread/started') this.record(runtime, 'thread.started', params)
    else if (method === 'protocol/malformed') this.record(runtime, 'native.malformed', params)
    else this.record(runtime, 'native.notification', { nativeMethod: method, ...params })
  }

  private turnError(turn: JsonObject | undefined): string {
    const error = isObject(turn?.error) ? turn.error : undefined
    return text(error?.message) ?? 'Codex turn failed.'
  }

  private handleDisconnect(runtime: Runtime): void {
    runtime.closed = true
    if (runtime.waiting) runtime.waiting.delivery = 'uncertain'
    this.record(runtime, 'transport.disconnected', {
      pendingResponseDelivery: runtime.waiting?.delivery === 'uncertain',
    })
  }

  private record(runtime: Runtime, type: string, payload: JsonObject): void {
    runtime.events.push(NativeHarnessEventSchema.parse({
      sequence: runtime.events.length,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    }))
    this.wake(runtime)
  }

  private wake(runtime: Runtime): void {
    for (const resolve of runtime.wake) resolve()
    runtime.wake.clear()
  }

  private wait(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', aborted)
        resolve()
      }
      const aborted = () => {
        runtime.wake.delete(done)
        reject(signal?.reason)
      }
      runtime.wake.add(done)
      signal?.addEventListener('abort', aborted, { once: true })
    })
  }
}

function simpleOption(
  semantic: ApprovalResponseOption['semantic'],
  label: string,
  persistence: ApprovalResponseOption['persistence'],
  interruptsCurrentTurn = false,
): Omit<ApprovalResponseOption, 'optionId'> {
  return {
    semantic, label, persistence, affectsOtherPendingRequests: false,
    interruptsCurrentTurn, mutatesPersistentPolicy: false,
  }
}
