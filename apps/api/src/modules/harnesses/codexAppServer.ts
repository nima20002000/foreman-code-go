import { isWorkerLauncher, WORKER_TOKEN } from './workerMcpLauncher.js'
import { isOperatorLauncher, OPERATOR_TOKEN } from './operatorMcpLauncher.js'
import { createHash, randomUUID } from 'node:crypto'
import { normalize } from 'node:path'

import {
  ApprovalResponseOptionSchema, CodexHarnessConfigurationSchema, CodexSessionCompatibilitySchema,
  DEFAULT_CODEX_ADVANCED_CONFIGURATION, McpDetectionSchema, NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema, NativeSessionReferenceSchema, PendingNativeInteractionSchema,
  type ApprovalResponseOption, type CodexAdvancedConfiguration, type CodexHarnessConfiguration,
  type ExecutionResult, type McpDetection, type NativeHarnessCapabilities, type NativeHarnessEvent,
  type NativeSessionReference, type PendingNativeInteraction,
} from '@graphql/contracts'

import { HarnessExecutionError } from './errors.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { nativeQualification } from './nativeQualification.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { codexModelOptions } from './operatorOptions.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from './port.js'
import { runCommand } from './process.js'
import {
  assertCodexUnchanged, canonical, isQualifiedCodexVersion, qualifyCodex, QUALIFIED_CODEX_VERSION,
  QUALIFIED_CODEX_SCHEMA_SHA256, type QualifiedCodex,
} from './codexProtocol.js'
import { CodexRpcError, CodexStdioTransport, isObject, object, text, type JsonObject, type RequestId, type RpcRequest } from './codexStdioTransport.js'

export { QUALIFIED_CODEX_VERSION, QUALIFIED_CODEX_SCHEMA_SHA256 }
const MAX_EVENTS = 1_024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MAX_STAGED = 256
const MAX_INTERACTIONS = 128
const RESPONSE_DEADLINE_MS = 30_000
const INTERRUPT_STARTUP_RETRIES = 20
const INTERRUPT_STARTUP_RETRY_MS = 25

type Delivery = 'pending' | 'submitting' | 'submitted' | 'uncertain'
interface WaitingRequest {
  pending: PendingNativeInteraction
  requestId: RequestId
  method: string
  generation: number
  signature: string
  responses: Map<string, { option: ApprovalResponseOption; nativeResponse: JsonObject }>
  delivery: Delivery
  selectedOptionId?: string
  resolution: Promise<'resolved' | 'cleared'>
  resolve(value: 'resolved' | 'cleared'): void
}
interface TurnSnapshot {
  activeTurnId: string | undefined
  activeCorrelationId: string | undefined
  terminalResult: ExecutionResult | undefined
  finalAnswer: string | undefined
  lastAgentMessage: string | undefined
  finalAnswerId: string | undefined
  lastAgentMessageId: string | undefined
}
interface StartingTurn {
  correlationId: string
  previous: TurnSnapshot
  cancelRequested: boolean
  nativeIdentity: Promise<string | undefined>
  resolveIdentity(id: string | undefined): void
  staged: Array<{ method: string; params: JsonObject } | { request: RpcRequest }>
  stagedBytes: number
}
interface Runtime extends TurnSnapshot {
  readonly connectionId: string
  readonly attached: boolean
  readonly binding: string
  readonly ownerId: string
  readonly configurationIdentity: string
  input: NativeSessionStart
  workingDirectory: string
  configuration: CodexHarnessConfiguration
  scopedCredentialVariable: string | undefined
  transport: CodexStdioTransport
  session: NativeSessionReference
  generation: number
  phase: 'idle' | 'starting' | 'active' | 'uncertain'
  streamActive: boolean
  starting: StartingTurn | undefined
  cancellation: { turnId: string; promise: Promise<boolean> } | undefined
  interactions: Map<string, WaitingRequest>
  resolvedRequests: Map<string, string>
  events: NativeHarnessEvent[]
  eventSizes: number[]
  eventBytes: number
  sequence: number
  seenNotifications: Set<string>
  wake: Set<() => void>
  closed: boolean
  disposed: boolean
}
interface Prepared {
  input: NativeSessionStart
  harnessConfiguration: CodexHarnessConfiguration
  workingDirectory: string
  scopedCredentialVariable: string | undefined
  environment: NodeJS.ProcessEnv
  qualified: QualifiedCodex
}
interface Creation {
  identity: string
  status: 'creating' | 'uncertain' | 'ready'
  promise?: Promise<NativeSessionReference>
  session?: NativeSessionReference
  transport?: CodexStdioTransport
  timer?: NodeJS.Timeout
}

export interface CodexMcpConfigurationInspection {
  providerVersion: string
  binary: string
  cwd: string
  serverName: string
  inspectionScope: 'effective_config'
  configured: {
    enabled: boolean; required: boolean; transport: 'stdio' | 'streamable_http' | 'unknown'
    url: string | null; bearerTokenEnvironmentVariable: string | null
    automaticWorkerEndpoint?: boolean
    automaticOperatorEndpoint?: boolean
    enabledTools: string[] | null; disabledTools: string[]
    defaultToolsApprovalMode: string | null; tools: JsonObject
  }
}
export interface CodexQualificationEvidence {
  providerVersion: string
  schemaManifestSha256: string
  referenceSchemaManifestSha256: string
  stableSchemaGitBlob: string
  schemaVerification: 'upstream-stable-pin-and-generated-experimental-validation'
  authentication: 'chatgpt'
  productionSupported: false
  productionRestriction: string
}

function advanced(value: CodexHarnessConfiguration): CodexAdvancedConfiguration {
  return value.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION
}
function accepted(input: NativeSessionStart) {
  return input.kind === 'operator' ? input.configuration : input.request.configuration
}
function ownerId(input: NativeSessionStart): string {
  return input.kind === 'operator' ? input.configuration.operatorId : input.request.configuration.agentId
}
function binding(input: NativeSessionStart): string {
  return input.kind === 'operator'
    ? canonical({ kind: 'operator', ownerId: ownerId(input), cwd: input.workingDirectory })
    : canonical({ kind: 'workflow', ownerId: ownerId(input), workspaceId: input.request.workspaceId,
      runId: input.request.runId, workflowNodeId: input.request.workflowNodeId, cwd: input.request.workingDirectory })
}
function instructions(input: NativeSessionStart): string | null {
  return input.kind === 'operator' ? null : input.request.configuration.prompt.system ?? null
}
function credentialIdentity(input: NativeSessionStart): string {
  return canonical(input.environment ?? null)
}
function safeEnvironment(input?: NativeSessionStart['environment'], scopedNames: readonly string[] = [], operator = false): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_') || key.startsWith('GRAPHQL_APP_')
      || scopedNames.includes(key) || ['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD'].includes(key)) delete environment[key]
  }
  if (input) {
    for (const [key, value] of Object.entries(input.variables)) {
      const ownedOperatorCredential = operator && key === 'GRAPHQL_OPERATOR_MCP_TOKEN'
      if (!ownedOperatorCredential && (key.startsWith('OPERATOR_') || key.startsWith('GRAPHQL_OPERATOR_')
        || ['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD'].includes(key))) {
        throw new HarnessExecutionError('CODEX_ENVIRONMENT_INVALID', 'An Agent environment cannot contain application-global secrets.')
      }
      environment[key] = value
    }
  }
  return environment
}
function validateEnvironmentOwner(input: NativeSessionStart, requiredVariable?: string): void {
  if (input.environment && input.environment.agentId !== ownerId(input)) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The scoped process environment belongs to another Agent.')
  }
  if (input.kind !== 'operator' && input.request.workspaceId !== input.request.configuration.workspaceId) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The accepted configuration belongs to another workspace.')
  }
  if (requiredVariable && !input.environment?.variables[requiredVariable]) {
    throw new HarnessExecutionError('CODEX_SCOPED_ENVIRONMENT_REQUIRED', `The enabled App MCP server requires scoped '${requiredVariable}' credentials.`)
  }
}
function configuration(input: NativeSessionStart): CodexHarnessConfiguration {
  const value = accepted(input).harness
  if (value.harness !== 'codex') throw new HarnessExecutionError('HARNESS_CONFIGURATION_MISMATCH', 'Codex received a non-Codex configuration.')
  const parsed = CodexHarnessConfigurationSchema.safeParse(value)
  if (!parsed.success) throw new HarnessExecutionError('CODEX_SETTING_INVALID', 'The accepted Codex configuration is invalid.')
  return parsed.data
}
function configOverrides(value: CodexHarnessConfiguration): JsonObject {
  const draft = advanced(value)
  const config: JsonObject = {
    model_reasoning_effort: value.reasoningEffort,
    web_search: draft.webSearch,
    shell_environment_policy: {
      inherit: draft.shellEnvironment.inherit,
      ignore_default_excludes: draft.shellEnvironment.ignoreDefaultExcludes,
      filters: draft.shellEnvironment.filters, set: draft.shellEnvironment.set,
    },
  }
  if (value.sandbox === 'workspace-write') config.sandbox_workspace_write = {
    writable_roots: draft.additionalWritableDirectories,
    network_access: draft.workspaceWrite?.networkAccess ?? false,
    exclude_tmpdir_env_var: draft.workspaceWrite?.excludeTmpdirEnvVar ?? false,
    exclude_slash_tmp: draft.workspaceWrite?.excludeSlashTmp ?? false,
  }
  return config
}
function threadParameters(prepared: Pick<Prepared, 'harnessConfiguration' | 'workingDirectory' | 'input'>): JsonObject {
  const value = prepared.harnessConfiguration
  const draft = advanced(value)
  return {
    model: value.model,
    // Explicit default, rather than null/inherit, clears a prior native Fast tier.
    serviceTier: value.serviceTier === 'priority' ? 'fast' : 'default',
    cwd: prepared.workingDirectory,
    runtimeWorkspaceRoots: [prepared.workingDirectory, ...draft.additionalWritableDirectories],
    approvalPolicy: draft.approvalPolicy, approvalsReviewer: draft.approvalsReviewer,
    sandbox: value.sandbox, config: { ...configOverrides(value),
      ...(prepared.input.kind === 'operator' ? { model_reasoning_summary: prepared.input.configuration.showThinking ? 'auto' : 'none' } : {}),
    }, developerInstructions: instructions(prepared.input),
  }
}
function sameSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right
  return canonical([...new Set(left)].sort()) === canonical([...new Set(right)].sort())
}
function stringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error('Invalid native string list.')
  return value as string[]
}
function requestKey(generation: number, id: RequestId): string { return `${generation}:${typeof id}:${String(id)}` }
function snapshot(runtime: Runtime): TurnSnapshot {
  return {
    activeTurnId: runtime.activeTurnId, activeCorrelationId: runtime.activeCorrelationId,
    terminalResult: runtime.terminalResult, finalAnswer: runtime.finalAnswer, lastAgentMessage: runtime.lastAgentMessage,
    finalAnswerId: runtime.finalAnswerId, lastAgentMessageId: runtime.lastAgentMessageId,
  }
}
function isUncertain(error: unknown): boolean { return error instanceof CodexRpcError && error.uncertain }
function deadline<T>(promise: Promise<T>, signal?: AbortSignal, milliseconds = RESPONSE_DEADLINE_MS): Promise<T> {
  signal?.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const abort = () => finish(signal?.reason ?? new Error('Aborted'))
    const timer = setTimeout(() => finish(new HarnessExecutionError('NATIVE_RECONCILIATION_REQUIRED', 'Native confirmation has not arrived; reconcile before retrying.')), milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    void promise.then((value) => finish(undefined, value), (error: unknown) => finish(error))
  })
}

export class CodexAppServerSessionManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  private readonly runtimes = new Map<string, Runtime>()
  private readonly locks = new Set<string>()
  private readonly creations = new Map<string, Creation>()
  private loginControl: { transport: CodexStdioTransport; loginId?: string; timer?: NodeJS.Timeout } | undefined
  private loginStarting = false
  private disposal: Promise<void> | undefined
  private readonly shutdownController = new AbortController()
  private readonly transports = new Set<CodexStdioTransport>()

  constructor(
    private readonly binary: string,
    private readonly expectedVersion?: string,
    private readonly appMcpServerName = 'graphql-app',
    private readonly processRecovery?: NativeProcessRecovery,
  ) {}

  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    const result = await qualifyCodex(this.binary, this.expectedVersion, process.cwd(), safeEnvironment(), true, signal)
    return NativeHarnessCapabilitiesSchema.parse({
      provider: 'codex', providerVersion: result.providerVersion, persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true,
      // Generic question choices have no approval semantics in the shared contract.
      supportedInteractionKinds: ['command_approval', 'file_approval', 'permission_profile', 'tool_user_input', 'mcp_elicitation'],
    })
  }

  /** Qualify the same native transport/settings without creating a thread or issuing an App credential. */
  async qualifyConfiguration(value: CodexHarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const parsed = CodexHarnessConfigurationSchema.safeParse(value)
    if (!parsed.success) throw new HarnessExecutionError('CODEX_SETTING_INVALID', 'The accepted Codex configuration is invalid.')
    const environment = safeEnvironment()
    const qualified = await qualifyCodex(this.binary, this.expectedVersion, workingDirectory, environment, true, signal)
    await this.validateMcpPolicies(parsed.data, qualified.binary, workingDirectory, environment, signal)
    await qualifyNativeCodexModel(parsed.data, qualified.binary, workingDirectory, environment, signal)
    return nativeQualification(parsed.data, qualified.providerVersion)
  }

  async discoverModels(workingDirectory: string, signal?: AbortSignal) {
    const qualified = await qualifyCodex(this.binary, this.expectedVersion, workingDirectory, safeEnvironment(), true, signal)
    await assertCodexUnchanged(qualified)
    const result = await runCommand(qualified.binary, ['debug', 'models'], workingDirectory, signal, safeEnvironment())
    if (result.exitCode !== 0) throw new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE', 'Native model discovery failed.')
    return { providerVersion: qualified.providerVersion, models: codexModelOptions(JSON.parse(result.stdout)) }
  }

  async qualificationEvidence(signal?: AbortSignal): Promise<CodexQualificationEvidence> {
    const result = await qualifyCodex(this.binary, this.expectedVersion, process.cwd(), safeEnvironment(), true, signal)
    return {
      providerVersion: result.providerVersion, schemaManifestSha256: result.schemaManifestSha256,
      referenceSchemaManifestSha256: result.referenceSchemaManifestSha256, stableSchemaGitBlob: result.stableSchemaGitBlob,
      schemaVerification: 'upstream-stable-pin-and-generated-experimental-validation',
      authentication: 'chatgpt', productionSupported: false,
      productionRestriction: 'Codex app-server remains experimental upstream. It is the only application execution transport; native qualification failure refuses execution.',
    }
  }

  async createSession(source: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    this.shutdownController.signal.throwIfAborted()
    const input = structuredClone(source)
    const key = this.creationKey(input)
    const identity = canonical({ binding: binding(input), configuration: accepted(input), environment: input.environment ?? null })
    const existing = this.creations.get(key)
    if (existing) {
      if (existing.identity !== identity) throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH', 'The creation correlation belongs to a different accepted session.')
      if (existing.session) return structuredClone(existing.session)
      if (existing.status === 'uncertain') throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'A native thread may already exist for this creation correlation; do not create another one.')
      return structuredClone(await existing.promise!)
    }
    if (this.creations.size >= 128) throw new HarnessExecutionError('CODEX_CREATION_LIMIT', 'Resolve or close existing sessions before creating more.')
    const creation: Creation = { identity, status: 'creating' }
    this.creations.set(key, creation)
    creation.promise = this.create(input, creation, key, signal)
    return structuredClone(await creation.promise)
  }

  /** Retrieve an identity learned from a late thread/start response without replaying it. */
  async reconcileSessionCreation(input: NativeSessionStart): Promise<NativeSessionReference> {
    const creation = this.creations.get(this.creationKey(input))
    const identity = canonical({ binding: binding(input), configuration: accepted(input), environment: input.environment ?? null })
    if (!creation || creation.identity !== identity || !creation.session) {
      throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'Native creation identity is not established; no replacement thread was created.')
    }
    return structuredClone(creation.session)
  }

  private creationKey(input: NativeSessionStart): string {
    const correlation = input.correlationId ?? (input.kind === 'operator' ? undefined : input.request.executionId)
    if (!correlation) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Session creation requires a stable correlation ID.')
    return canonical([binding(input), correlation])
  }

  private async create(input: NativeSessionStart, creation: Creation, key: string, signal?: AbortSignal): Promise<NativeSessionReference> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    let candidate: Awaited<ReturnType<CodexAppServerSessionManager['transport']>> | undefined
    let expiration: NodeJS.Timeout | undefined
    try {
      const prepared = await this.prepareInput(input, signal)
      candidate = await this.transport(prepared, 0, signal)
      creation.transport = candidate.transport
      const publish = async (value: unknown): Promise<NativeSessionReference> => {
        this.shutdownController.signal.throwIfAborted()
        const response = object(value, 'CODEX_THREAD_START_INVALID')
        const thread = this.validateThreadResponse(prepared, response)
        const session = NativeSessionReferenceSchema.parse({ harness: 'codex', providerVersion: prepared.qualified.providerVersion, nativeSessionId: thread.id })
        if (this.runtimes.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_COLLISION', 'Codex returned an already-owned native session identity.')
        const runtime = this.runtime(prepared, session, candidate!.transport)
        this.runtimes.set(session.nativeSessionId, runtime)
        try { await candidate!.activate(runtime); this.shutdownController.signal.throwIfAborted() } catch (error) {
          if (this.runtimes.get(session.nativeSessionId) === runtime) this.runtimes.delete(session.nativeSessionId)
          throw error
        }
        creation.status = 'ready'
        creation.session = session
        clearTimeout(expiration)
        this.record(runtime, 'thread.started', { threadId: session.nativeSessionId })
        return session
      }
      const result = await candidate.transport.request('thread/start', {
        ...threadParameters(prepared), ephemeral: advanced(prepared.harnessConfiguration).sessionPersistence === 'ephemeral',
      }, signal, (value, error) => {
        void (async () => {
          if (error) {
            clearTimeout(expiration)
            this.creations.delete(key)
            await candidate!.transport.close()
          } else await publish(value)
        })().catch(() => { void candidate!.transport.close().catch(() => undefined) })
      })
      return await publish(result)
    } catch (error) {
      if (isUncertain(error) && candidate && !this.shutdownController.signal.aborted) {
        creation.status = 'uncertain'
        // Keep a bounded late-response window. Expiry never authorizes a retry.
        expiration = setTimeout(() => { void candidate!.transport.close().catch(() => undefined) }, 300_000)
        creation.timer = expiration
        expiration.unref()
      } else {
        try { await candidate?.transport.close() }
        catch (cleanupError) {
          creation.status = 'uncertain'
          throw new AggregateError([error, cleanupError], 'Native setup failed and transport closure is unconfirmed.', { cause: cleanupError })
        }
        this.creations.delete(key)
      }
      throw error
    }
  }

  async attachSession(session: NativeSessionReference, source: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    this.assertSessionVersion(session)
    return this.exclusive(session.nativeSessionId, async () => {
      const input = structuredClone(source)
      const loaded = this.runtimes.get(session.nativeSessionId)
      if (loaded) {
        if (loaded.disposed) throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'Session closure is still unconfirmed; retry cleanup before attaching.')
        if (loaded.session.providerVersion !== session.providerVersion) throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
        this.assertBinding(loaded, input)
        if (credentialIdentity(loaded.input) !== credentialIdentity(input)) {
          throw new HarnessExecutionError('CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED', 'Use explicit idle-boundary credential refresh instead of attaching with a different environment.')
        }
        if (loaded.closed) await this.restart(loaded, signal)
        const response = object(await loaded.transport.request('thread/read', { threadId: session.nativeSessionId, includeTurns: false }, signal))
        if (object(response.thread).id !== session.nativeSessionId) throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex read a different native thread.')
        return structuredClone(loaded.session)
      }
      const prepared = await this.prepareInput(input, signal)
      if (prepared.qualified.providerVersion !== session.providerVersion) {
        throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The saved session belongs to another Codex release.')
      }
      if (advanced(prepared.harnessConfiguration).sessionPersistence === 'ephemeral') {
        throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'Ephemeral sessions cannot be resumed after their process exits.')
      }
      const candidate = await this.transport(prepared, 0, signal)
      try {
        const response = object(await candidate.transport.request('thread/resume', {
          ...threadParameters(prepared), threadId: session.nativeSessionId, excludeTurns: true,
        }, signal), 'CODEX_THREAD_RESUME_INVALID')
        this.validateThreadResponse(prepared, response, session.nativeSessionId)
        const runtime = this.runtime(prepared, structuredClone(session), candidate.transport, true)
        await this.synchronize(runtime, undefined, signal)
        await candidate.activate(runtime)
        this.runtimes.set(session.nativeSessionId, runtime)
        this.record(runtime, 'thread.attached', { threadId: session.nativeSessionId })
        return structuredClone(session)
      } catch (error) {
        await candidate.transport.close().catch(() => undefined)
        throw error
      }
    })
  }

  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const runtime = this.requireRuntime(session)
    signal?.throwIfAborted()
    if (this.locks.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
    if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconcile the disconnected session before starting another turn.')
    if (runtime.phase !== 'idle' || runtime.streamActive || runtime.interactions.size > 0) {
      throw new HarnessExecutionError('CODEX_TURN_ACTIVE', 'This session has an active or uncertain turn or interaction.')
    }
    if (!input.clientCorrelationId.trim()) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Turn startup requires a stable correlation ID.')
    let resolveIdentity!: StartingTurn['resolveIdentity']
    const nativeIdentity = new Promise<string | undefined>((resolve) => { resolveIdentity = resolve })
    const starting: StartingTurn = {
      correlationId: input.clientCorrelationId, previous: snapshot(runtime), cancelRequested: false,
      nativeIdentity, resolveIdentity, staged: [], stagedBytes: 0,
    }
    runtime.streamActive = true
    runtime.starting = starting
    runtime.phase = 'starting'
    runtime.activeTurnId = undefined
    runtime.activeCorrelationId = input.clientCorrelationId
    runtime.terminalResult = undefined
    runtime.finalAnswer = undefined
    runtime.lastAgentMessage = undefined
    runtime.finalAnswerId = undefined
    runtime.lastAgentMessageId = undefined
    runtime.cancellation = undefined
    runtime.seenNotifications.clear()
    const abort = () => {
      starting.cancelRequested = true
      if (runtime.activeTurnId && !runtime.terminalResult) void this.interrupt(runtime).catch(() => undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    let cursor = runtime.sequence
    try {
      const result = await runtime.transport.request('turn/start', {
        threadId: session.nativeSessionId, clientUserMessageId: input.clientCorrelationId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        serviceTierForTurn: runtime.configuration.serviceTier === 'priority' ? 'fast' : 'default',
      }, signal, (value, error) => {
        if (runtime.starting !== starting || runtime.disposed) return
        if (error) this.restoreRejectedStart(runtime, starting)
        else void this.acceptStartedTurn(runtime, starting, value).catch(() => {
          runtime.phase = 'uncertain'
          this.record(runtime, 'turn.start_uncertain', { correlationId: starting.correlationId })
        })
      }).catch((error: unknown) => {
        if (runtime.starting === starting) {
          if (isUncertain(error)) {
            runtime.phase = 'uncertain'
            this.record(runtime, 'turn.start_uncertain', { correlationId: starting.correlationId })
          } else this.restoreRejectedStart(runtime, starting)
        }
        throw error
      })
      await this.acceptStartedTurn(runtime, starting, result)
      if (runtime.activeTurnId) await input.onSubmitted?.(runtime.activeTurnId)
      while (!signal?.aborted) {
        const firstSequence = runtime.events[0]?.sequence ?? runtime.sequence
        if (cursor < firstSequence) throw new HarnessExecutionError('NATIVE_HISTORY_GAP', 'The in-memory event window was exceeded; reload durable history.')
        const available = runtime.events.filter((event) => event.sequence >= cursor)
        for (const event of available) { cursor = event.sequence + 1; yield structuredClone(event) }
        // The consumer can suspend at yield while more events (including terminal
        // events) arrive. Drain them before returning or registering a waiter.
        if (runtime.events.some((event) => event.sequence >= cursor)) continue
        if (runtime.terminalResult || runtime.closed) return
        await this.wait(runtime, signal)
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      runtime.streamActive = false
    }
  }

  async pending(session: NativeSessionReference): Promise<PendingNativeInteraction | undefined> {
    const first = [...this.requireRuntime(session).interactions.values()].find((entry) => entry.delivery === 'pending')
    return first ? structuredClone(first.pending) : undefined
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    const runtime = this.requireRuntime(session)
    if (this.locks.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
    const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === nativeRequestId)
    if (!waiting) throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The addressed native request is not pending in this session.')
    const stored = waiting.responses.get(option.optionId)
    if (!stored) throw new HarnessExecutionError('NATIVE_RESPONSE_OPTION_INVALID', 'The selected response was not offered for this native request.')
    if (waiting.delivery !== 'pending' || waiting.generation !== runtime.generation || runtime.closed) {
      throw new HarnessExecutionError('NATIVE_RESPONSE_RECONCILIATION_REQUIRED', 'A submitted, disconnected, or uncertain native response cannot be retransmitted.')
    }
    signal?.throwIfAborted()
    // Synchronous reservation prevents two competing responses from both writing.
    waiting.delivery = 'submitting'
    waiting.selectedOptionId = stored.option.optionId
    try {
      await runtime.transport.respond(waiting.requestId, waiting.method, stored.nativeResponse)
      if (runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) === waiting) {
        waiting.delivery = 'submitted'
        this.record(runtime, 'interaction.submitted', { nativeRequestId, optionId: stored.option.optionId, semantic: stored.option.semantic })
      }
      const resolved = await deadline(waiting.resolution, signal)
      if (resolved === 'cleared') throw new HarnessExecutionError('NATIVE_RESPONSE_CLEARED', 'The native request was cleared; acceptance of the selected response was not confirmed.')
    } catch (error) {
      if (runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) === waiting) {
        const code = error instanceof HarnessExecutionError ? error.result.error?.code : undefined
        waiting.delivery = ['NATIVE_RESPONSE_DELIVERY_FAILED', 'NATIVE_RESPONSE_INVALID'].includes(code ?? '') ? 'pending' : 'uncertain'
        this.record(runtime, 'interaction.delivery_state', { nativeRequestId, delivery: waiting.delivery })
      }
      throw error
    }
  }

  async cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string): Promise<boolean> {
    const runtime = this.requireRuntime(session)
    if (runtime.starting) {
      runtime.starting.cancelRequested = true
      const id = await deadline(runtime.starting.nativeIdentity, signal)
      if (!id) return false
    }
    if (!runtime.activeTurnId || runtime.terminalResult || (nativeTurnId && nativeTurnId !== runtime.activeTurnId)) return false
    return deadline(this.interrupt(runtime), signal)
  }

  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const runtime = this.requireRuntime(session)
    const all = [...runtime.interactions.values()]
    const first = all.find((entry) => entry.delivery === 'pending')
    return structuredClone({
      events: runtime.events,
      pendingInteractions: all.map((entry) => entry.pending),
      ...(first?.delivery === 'pending' ? { pendingInteraction: first.pending } : {}),
      ...(runtime.terminalResult ? { terminalResult: runtime.terminalResult } : {}),
      ...((runtime.finalAnswer !== undefined ? runtime.finalAnswerId : runtime.lastAgentMessageId)
        ? { nativeMessageId: runtime.finalAnswer !== undefined ? runtime.finalAnswerId! : runtime.lastAgentMessageId! } : {}),
      firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.sequence,
      nextSequence: runtime.sequence,
      interactionDeliveries: all.map((entry) => ({
        nativeRequestId: entry.pending.turn.nativeRequestId!, state: entry.delivery,
        ...(entry.selectedOptionId ? { selectedOptionId: entry.selectedOptionId } : {}),
      })),
    })
  }

  async reconcileResponse(
    session: NativeSessionReference,
    response: import('./port.js').NativeResponseIdentity,
    signal?: AbortSignal,
  ): Promise<NativeHistory> {
    signal?.throwIfAborted()
    const history = await this.history(session)
    // The pinned Codex protocol's serverRequest/resolved also covers cleared
    // requests. It is NOT an acknowledgement of an exact permission choice.
    // Keep that uncertainty visible; do not synthesize a receipt or replay.
    this.record(this.requireRuntime(session), 'interaction.reconciliation_unconfirmed', {
      nativeRequestId: response.nativeRequestId, nativeRequestType: response.nativeRequestType,
      detail: 'The provider has not supplied an exact response-delivery receipt.',
    })
    return history
  }

  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
    return this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      const restarted = runtime.closed
      if (runtime.closed) await this.restart(runtime, signal)
      const locallyIdle = !runtime.attached && runtime.phase === 'idle' && runtime.activeCorrelationId === undefined
        && runtime.activeTurnId === undefined && runtime.interactions.size === 0
      const observedTerminal = runtime.activeCorrelationId === correlationId
        && runtime.activeTurnId !== undefined && runtime.terminalResult !== undefined
      if (!locallyIdle && !observedTerminal) await this.synchronize(runtime, correlationId, signal)
      this.record(runtime, 'thread.reconciled', {
        correlationId, restarted, threadId: session.nativeSessionId,
        turnId: runtime.activeTurnId, terminal: runtime.terminalResult?.outcome ?? null,
      })
      const history = await this.history(session)
      return runtime.activeCorrelationId === correlationId && runtime.activeTurnId
        ? {
            ...history,
            correlationId,
            nativeTurnId: runtime.activeTurnId,
            ...(runtime.terminalResult ? {
              terminalTurn: {
                correlationId,
                providerId: runtime.activeTurnId,
                result: runtime.terminalResult,
              },
            } : {}),
          }
        : history
    })
  }

  async close(session: NativeSessionReference): Promise<void> {
    this.assertSessionVersion(session)
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.runtimes.get(session.nativeSessionId)
      if (!runtime) return
      if (runtime.session.providerVersion !== session.providerVersion) throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
      runtime.closed = true
      runtime.disposed = true
      runtime.starting?.resolveIdentity(undefined)
      for (const waiting of runtime.interactions.values()) waiting.resolve('cleared')
      this.wake(runtime)
      // Retain ownership when closure fails so Stop/disposal can retry it.
      await runtime.transport.close()
      if (this.runtimes.get(session.nativeSessionId) === runtime) this.runtimes.delete(session.nativeSessionId)
      for (const [key, creation] of this.creations) if (creation.session?.nativeSessionId === session.nativeSessionId) this.creations.delete(key)
    })
  }

  closeForRestart(session: NativeSessionReference): Promise<void> { return this.close(session) }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    const checkedAt = new Date().toISOString()
    try {
      const value = await this.inspectMcpConfiguration(process.cwd(), signal)
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName,
        state: value.configured.enabled ? 'status_unavailable' : 'disabled', endpointMatches: null,
        credentialEnvironmentVariable: value.configured.bearerTokenEnvironmentVariable === 'GRAPHQL_APP_MCP_TOKEN'
          ? 'GRAPHQL_APP_MCP_TOKEN' : null,
        checkedAt,
        detail: 'CLI inspection proves configuration only; inspectNativeMcp reports runtime status.',
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const notConfigured = error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_MCP_NOT_CONFIGURED'
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName, state: notConfigured ? 'not_detected' : 'check_failed',
        endpointMatches: null, credentialEnvironmentVariable: null, checkedAt,
      })
    }
  }

  async inspectMcpConfiguration(cwd: string, signal?: AbortSignal): Promise<CodexMcpConfigurationInspection> {
    const environment = safeEnvironment()
    const qualified = await qualifyCodex(this.binary, this.expectedVersion, cwd, environment, true, signal)
    return this.mcpConfiguration(qualified.binary, cwd, environment, qualified.providerVersion, signal)
  }

  async inspectConfiguration(session: NativeSessionReference, includeLayers = true, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return object(await runtime.transport.request('config/read', { includeLayers, cwd: runtime.workingDirectory }, signal), 'CODEX_CONFIG_READ_INVALID')
  }

  async inspectNativeMcp(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return object(await runtime.transport.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId: session.nativeSessionId }, signal), 'CODEX_MCP_STATUS_INVALID')
  }

  async listNativeModels(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    return object(await this.requireRuntime(session).transport.request('model/list', { includeHidden: false }, signal), 'CODEX_MODEL_CATALOG_INVALID')
  }

  async reloadNativeMcp(session: NativeSessionReference, signal?: AbortSignal): Promise<void> {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      // Revalidate policy/credentials before allowing a newly enabled MCP entry.
      const prepared = await this.prepareInput(runtime.input, signal)
      if (prepared.scopedCredentialVariable !== runtime.scopedCredentialVariable) {
        throw new HarnessExecutionError('CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED', 'MCP credential requirements changed; refresh the process environment first.')
      }
      await runtime.transport.request('config/mcpServer/reload', undefined, signal)
    })
  }

  async refreshProcessEnvironment(
    session: NativeSessionReference,
    environment: NonNullable<NativeSessionStart['environment']>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      if (runtime.ownerId !== environment.agentId) throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The replacement environment belongs to another Agent.')
      this.assertIdle(runtime)
      const nextInput = { ...structuredClone(runtime.input), environment: structuredClone(environment) }
      // This also checks newly required MCP variables before stopping a usable process.
      const prepared = await this.prepareInput(nextInput, signal)
      if (advanced(runtime.configuration).sessionPersistence === 'ephemeral') {
        throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'Refreshing an ephemeral process would discard its native session.')
      }
      runtime.closed = true
      await runtime.transport.close()
      await this.restart(runtime, signal, prepared)
      this.record(runtime, 'transport.environment_refreshed', { agentId: runtime.ownerId })
    })
  }

  /** A control-only transport makes fresh login possible without creating a thread. */
  async startDeviceCodeLogin(session?: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    if (session) {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      return object(await runtime.transport.request('account/login/start', { type: 'chatgptDeviceCode' }, signal), 'CODEX_LOGIN_START_INVALID')
    }
    if (this.loginStarting || this.loginControl) throw new HarnessExecutionError('CODEX_LOGIN_ACTIVE', 'A device-code login is already in progress.')
    this.shutdownController.signal.throwIfAborted()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    this.loginStarting = true
    try {
      const environment = safeEnvironment()
      const qualified = await qualifyCodex(this.binary, this.expectedVersion, process.cwd(), environment, false, signal)
      await assertCodexUnchanged(qualified)
      const transport = new CodexStdioTransport(
        qualified.binary, process.cwd(), environment, qualified.protocol,
        async (request) => { await transport.reject(request.id, -32601, 'Execution requests are not supported by the login transport.') },
        (method) => { if (method === 'account/login/completed') void this.closeLoginControl().catch(() => undefined) },
        () => { void this.closeLoginControl().catch(() => undefined) },
      )
      this.loginControl = { transport }
      try {
        await transport.start(signal)
        const response = object(await transport.request('account/login/start', { type: 'chatgptDeviceCode' }, signal), 'CODEX_LOGIN_START_INVALID')
        const loginId = text(response.loginId)
        if (!loginId) throw new HarnessExecutionError('CODEX_LOGIN_START_INVALID', 'Codex did not return a login identity.')
        if (!this.loginControl) throw new HarnessExecutionError('CODEX_LOGIN_DISCONNECTED', 'The login transport disconnected.')
        this.loginControl.loginId = loginId
        this.loginControl.timer = setTimeout(() => { void this.closeLoginControl().catch(() => undefined) }, 15 * 60_000)
        this.loginControl.timer.unref()
        return response
      } catch (error) { await this.closeLoginControl().catch(() => undefined); throw error }
    } finally { this.loginStarting = false }
  }

  async cancelLogin(session: NativeSessionReference | undefined, loginId: string, signal?: AbortSignal): Promise<void> {
    if (session) { await this.requireRuntime(session).transport.request('account/login/cancel', { loginId }, signal); return }
    const control = this.loginControl
    if (!control || control.loginId !== loginId) throw new HarnessExecutionError('CODEX_LOGIN_UNKNOWN', 'This login identity is not active on the control transport.')
    try { await control.transport.request('account/login/cancel', { loginId }, signal) } finally { await this.closeLoginControl() }
  }

  dispose(): Promise<void> { return this.shutdown() }

  /** Both disposal entry points share one cleanup attempt, including on retries. */
  shutdown(): Promise<void> {
    this.disposal ??= this.shutdownOwned().catch((error: unknown) => {
      this.disposal = undefined
      throw error
    })
    return this.disposal
  }

  /** Application shutdown also owns control and uncertain-creation transports. */
  private async shutdownOwned(): Promise<void> {
    this.shutdownController.abort(new Error('Codex session manager is shutting down.'))
    const cleanups: Promise<unknown>[] = [...this.transports].map((transport) => transport.close())
    for (const runtime of this.runtimes.values()) cleanups.push(this.close(runtime.session))
    for (const creation of this.creations.values()) {
      clearTimeout(creation.timer)
      if (creation.transport) cleanups.push(creation.transport.close())
      if (creation.promise) cleanups.push(creation.promise.catch(() => undefined).then(async () => {
        await creation.transport?.close()
      }))
    }
    cleanups.push(this.closeLoginControl())
    const results = await Promise.allSettled(cleanups)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    this.creations.clear()
  }

  async closeLoginControl(): Promise<void> {
    const control = this.loginControl
    if (!control) return
    clearTimeout(control.timer)
    await control.transport.close()
    if (this.loginControl === control) this.loginControl = undefined
  }

  private assertSessionVersion(session: NativeSessionReference): void {
    if (session.harness !== 'codex' || !isQualifiedCodexVersion(session.providerVersion)
      || (this.expectedVersion !== undefined && session.providerVersion !== this.expectedVersion)) {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The session does not match this qualified Codex provider.')
    }
  }
  private requireRuntime(session: NativeSessionReference): Runtime {
    this.assertSessionVersion(session)
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime || runtime.disposed) throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The Codex native session is not loaded.')
    if (runtime.session.providerVersion !== session.providerVersion) throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
    return runtime
  }
  private assertBinding(runtime: Runtime, input: NativeSessionStart): void {
    validateEnvironmentOwner(input)
    if (runtime.binding !== binding(input) || runtime.ownerId !== ownerId(input)) {
      throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The loaded session belongs to a different owner or scope.')
    }
    if (runtime.configurationIdentity !== canonical(accepted(input))) {
      throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH', 'The loaded session has a different accepted configuration snapshot.')
    }
  }
  private assertIdle(runtime: Runtime): void {
    if (runtime.phase !== 'idle' || runtime.streamActive || runtime.interactions.size > 0) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'This operation requires an idle, fully reconciled session.')
    }
  }
  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.locks.has(key)) throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'Another session lifecycle operation is in progress.')
    this.locks.add(key)
    try { return await operation() } finally { this.locks.delete(key) }
  }

  private async prepareInput(source: NativeSessionStart, signal?: AbortSignal): Promise<Prepared> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const input = structuredClone(source)
    validateEnvironmentOwner(input)
    const harnessConfiguration = configuration(input)
    const workingDirectory = input.kind === 'operator' ? input.workingDirectory : input.request.workingDirectory
    const environment = safeEnvironment(input.environment, [], input.kind === 'operator')
    const qualified = await qualifyCodex(this.binary, this.expectedVersion, workingDirectory, environment, true, signal)
    await this.validateMcpPolicies(harnessConfiguration, qualified.binary, workingDirectory, environment, signal)
    let scopedCredentialVariable: string | undefined
    try {
      const mcp = await this.mcpConfiguration(qualified.binary, workingDirectory, environment, qualified.providerVersion, signal)
      if (mcp.configured.enabled) scopedCredentialVariable = mcp.configured.bearerTokenEnvironmentVariable ?? undefined
    } catch (error) {
      if (!(error instanceof HarnessExecutionError) || error.result.error?.code !== 'CODEX_MCP_NOT_CONFIGURED') throw error
    }
    validateEnvironmentOwner(input, scopedCredentialVariable)
    const scopedEnvironment = safeEnvironment(input.environment, scopedCredentialVariable ? [scopedCredentialVariable] : [], input.kind === 'operator')
    await qualifyNativeCodexModel(harnessConfiguration, qualified.binary, workingDirectory, scopedEnvironment, signal)
    return { input, harnessConfiguration, workingDirectory, scopedCredentialVariable, environment: scopedEnvironment, qualified }
  }

  private async mcpConfiguration(binary: string, cwd: string, environment: NodeJS.ProcessEnv,
    providerVersion: string, signal?: AbortSignal): Promise<CodexMcpConfigurationInspection> {
    const result = await runCommand(binary, ['mcp', 'get', this.appMcpServerName, '--json'], cwd, signal, environment)
    if (result.exitCode !== 0) {
      const listed = await runCommand(binary, ['mcp', 'list', '--json'], cwd, signal, environment)
      let entries: unknown
      try { entries = JSON.parse(listed.stdout) } catch { entries = undefined }
      if (listed.exitCode === 0 && Array.isArray(entries)
        && entries.every((entry: unknown) => isObject(entry) && typeof entry.name === 'string')
        && !entries.some((entry: unknown) => isObject(entry) && entry.name === this.appMcpServerName)) {
        throw new HarnessExecutionError('CODEX_MCP_NOT_CONFIGURED', 'The named native MCP entry is absent.')
      }
      throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED', 'Codex MCP configuration inspection failed; absence was not established.')
    }
    try {
      const parsed = object(JSON.parse(result.stdout))
      const transport = isObject(parsed.transport) ? parsed.transport : {}
      const url = text(transport.url) ?? null
      return {
        providerVersion, binary, cwd, serverName: this.appMcpServerName, inspectionScope: 'effective_config',
        configured: {
          enabled: parsed.enabled !== false, required: parsed.required === true,
          transport: transport.type === 'streamable_http' || transport.type === 'stdio'
            ? transport.type : url ? 'streamable_http' : text(transport.command) ? 'stdio' : 'unknown',
          url, bearerTokenEnvironmentVariable: isOperatorLauncher('codex', transport) ? OPERATOR_TOKEN : isWorkerLauncher('codex', transport) ? WORKER_TOKEN : text(transport.bearer_token_env_var) ?? null,
          automaticOperatorEndpoint: isOperatorLauncher('codex', transport),
          automaticWorkerEndpoint: this.appMcpServerName === 'graphql-app' && isWorkerLauncher('codex', transport),
          enabledTools: stringArray(parsed.enabled_tools) ?? null, disabledTools: stringArray(parsed.disabled_tools) ?? [],
          defaultToolsApprovalMode: text(parsed.default_tools_approval_mode) ?? null,
          tools: isObject(parsed.tools) ? parsed.tools : {},
        },
      }
    } catch { throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid structured MCP configuration.') }
  }

  private async validateMcpPolicies(
    value: CodexHarnessConfiguration, binary: string, cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal,
  ): Promise<void> {
    for (const [serverName, expected] of Object.entries(advanced(value).mcpServers)) {
      const result = await runCommand(binary, ['mcp', 'get', serverName, '--json'], cwd, signal, environment)
      if (result.exitCode !== 0) throw new HarnessExecutionError(expected.required ? 'CODEX_REQUIRED_MCP_UNAVAILABLE' : 'CODEX_MCP_POLICY_MISMATCH', 'An accepted MCP server is not configured.')
      let actual: JsonObject
      try { actual = object(JSON.parse(result.stdout)) } catch { throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid MCP policy data.') }
      const actualTools = isObject(actual.tools) ? actual.tools : {}
      const normalizedTools: JsonObject = {}
      for (const [name, policy] of Object.entries(actualTools)) {
        if (!isObject(policy)) throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid MCP tool policy.')
        const unknown = Object.keys(policy).filter((key) => !['enabled', 'approval_mode'].includes(key))
        if (unknown.length > 0) throw new HarnessExecutionError('CODEX_MCP_POLICY_UNSUPPORTED', 'The installed MCP tool policy contains unqualified fields.')
        normalizedTools[name] = {
          enabled: policy.enabled ?? true,
          ...(policy.approval_mode == null ? {} : { approvalMode: policy.approval_mode }),
        }
      }
      const expectedTools = Object.fromEntries(Object.entries(expected.tools ?? {}).map(([name, policy]) => [
        name, { ...policy, enabled: policy.enabled ?? true },
      ]))
      const mismatch = (actual.enabled !== false) !== expected.enabled || (actual.required === true) !== expected.required
        || !sameSet(stringArray(actual.enabled_tools), expected.enabledTools)
        || !sameSet(stringArray(actual.disabled_tools) ?? [], expected.disabledTools ?? [])
        || (text(actual.default_tools_approval_mode) !== expected.defaultToolsApprovalMode)
        || canonical(normalizedTools) !== canonical(expectedTools)
      if (mismatch) throw new HarnessExecutionError(
        expected.required && (actual.enabled === false || actual.required !== true) ? 'CODEX_REQUIRED_MCP_UNAVAILABLE' : 'CODEX_MCP_POLICY_MISMATCH',
        'Native MCP enabled/required/tool policies differ from the accepted configuration; no native configuration was rewritten.',
      )
    }
  }

  private validateThreadResponse(prepared: Pick<Prepared, 'harnessConfiguration' | 'workingDirectory'>, response: JsonObject, expectedId?: string): JsonObject {
    const thread = object(response.thread, 'CODEX_THREAD_INVALID')
    if (!text(thread.id) || String(thread.id).length > 1_024 || (expectedId !== undefined && thread.id !== expectedId)) {
      throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex returned a different or missing thread identity.')
    }
    const value = prepared.harnessConfiguration
    const draft = advanced(value)
    const sandbox = object(response.sandbox, 'CODEX_EFFECTIVE_SETTINGS_MISMATCH')
    const sandboxType = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[value.sandbox]
    let mismatch = response.model !== value.model || response.reasoningEffort !== value.reasoningEffort
      || normalize(String(response.cwd)) !== normalize(prepared.workingDirectory)
      || canonical(response.approvalPolicy) !== canonical(draft.approvalPolicy)
      || response.approvalsReviewer !== draft.approvalsReviewer || sandbox.type !== sandboxType
      || (value.serviceTier === 'priority' ? !['fast', 'priority'].includes(String(response.serviceTier)) : ![null, 'default'].includes(response.serviceTier as string | null))
    if (value.sandbox === 'workspace-write') {
      const roots = stringArray(sandbox.writableRoots) ?? []
      const requested = draft.additionalWritableDirectories.map((path) => normalize(path))
      const allowed = new Set([normalize(prepared.workingDirectory), ...requested])
      mismatch ||= roots.some((path) => !allowed.has(normalize(path))) || requested.some((path) => !roots.some((root) => normalize(root) === path))
        || sandbox.networkAccess !== (draft.workspaceWrite?.networkAccess ?? false)
        || sandbox.excludeTmpdirEnvVar !== (draft.workspaceWrite?.excludeTmpdirEnvVar ?? false)
        || sandbox.excludeSlashTmp !== (draft.workspaceWrite?.excludeSlashTmp ?? false)
    }
    if (thread.ephemeral !== undefined && thread.ephemeral !== (draft.sessionPersistence === 'ephemeral')) mismatch = true
    if (mismatch) throw new HarnessExecutionError('CODEX_EFFECTIVE_SETTINGS_MISMATCH', 'Codex did not retain the accepted thread settings; execution is refused.')
    return thread
  }

  private runtime(prepared: Prepared, session: NativeSessionReference, transport: CodexStdioTransport, attached = false): Runtime {
    return {
      connectionId: randomUUID(), attached,
      binding: binding(prepared.input), ownerId: ownerId(prepared.input), configurationIdentity: canonical(accepted(prepared.input)),
      input: prepared.input, workingDirectory: prepared.workingDirectory, configuration: prepared.harnessConfiguration,
      scopedCredentialVariable: prepared.scopedCredentialVariable, transport, session, generation: 0,
      phase: 'idle', streamActive: false, starting: undefined, cancellation: undefined,
      activeTurnId: undefined, activeCorrelationId: undefined, terminalResult: undefined, finalAnswer: undefined, lastAgentMessage: undefined,
      finalAnswerId: undefined, lastAgentMessageId: undefined,
      interactions: new Map(), resolvedRequests: new Map(), events: [], eventSizes: [], eventBytes: 0, sequence: 0,
      seenNotifications: new Set(), wake: new Set(), closed: false, disposed: false,
    }
  }

  private async transport(prepared: Prepared, generation: number, signal?: AbortSignal): Promise<{
    transport: CodexStdioTransport
    activate(runtime: Runtime): Promise<void>
  }> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    let runtime: Runtime | undefined
    let disconnected = false
    let activating = false
    let bufferedBytes = 0
    const buffered: Array<{ request: RpcRequest } | { method: string; params: JsonObject }> = []
    const enqueue = (event: typeof buffered[number]) => {
      bufferedBytes += Buffer.byteLength(JSON.stringify(event))
      if (buffered.length >= MAX_STAGED || bufferedBytes > MAX_EVENT_BYTES) throw new Error('Provider initialization buffer exceeded its limit.')
      buffered.push(event)
    }
    await assertCodexUnchanged(prepared.qualified)
    signal.throwIfAborted()
    const transport = new CodexStdioTransport(
      prepared.qualified.binary, prepared.workingDirectory, prepared.environment, prepared.qualified.protocol,
      async (request) => {
        if (!runtime || activating) { enqueue({ request }); return }
        if (runtime.generation === generation && runtime.transport === transport && !runtime.disposed) await this.handleRequest(runtime, request)
      },
      (method, params) => {
        if (!runtime || activating) { enqueue({ method, params }); return }
        if (runtime.generation === generation && runtime.transport === transport && !runtime.disposed) this.handleNotification(runtime, method, params)
      },
      () => {
        disconnected = true
        if (runtime?.generation === generation && runtime.transport === transport && !runtime.disposed) this.handleDisconnect(runtime)
      },
      undefined, this.processRecovery,
    )
    // Also own cold-attachment candidates before a Runtime has been published.
    this.transports.add(transport)
    const close = transport.close.bind(transport)
    transport.close = async () => { await close(); this.transports.delete(transport) }
    await transport.start(signal)
    return {
      transport,
      activate: async (value) => {
        if (disconnected) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The candidate provider disconnected before attachment completed.')
        runtime = value
        activating = true
        try {
          while (buffered.length > 0) {
            const event = buffered.shift()!
            if ('request' in event) await this.handleRequest(runtime, event.request)
            else this.handleNotification(runtime, event.method, event.params)
          }
        } finally { activating = false; bufferedBytes = 0 }
      },
    }
  }

  private async restart(runtime: Runtime, signal?: AbortSignal, supplied?: Prepared): Promise<void> {
    if (advanced(runtime.configuration).sessionPersistence === 'ephemeral') {
      throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'An ephemeral native session cannot survive a process restart.')
    }
    const prepared = supplied ?? await this.prepareInput(runtime.input, signal)
    this.assertBinding(runtime, prepared.input)
    if (prepared.qualified.providerVersion !== runtime.session.providerVersion) {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The saved session belongs to another Codex release.')
    }
    const generation = runtime.generation + 1
    // The old transport remains owned until its entire process tree is stopped.
    await runtime.transport.close()
    const candidate = await this.transport(prepared, generation, signal)
    try {
      const response = object(await candidate.transport.request('thread/resume', {
        ...threadParameters(prepared), threadId: runtime.session.nativeSessionId, excludeTurns: true,
      }, signal), 'CODEX_THREAD_RESUME_INVALID')
      this.validateThreadResponse(prepared, response, runtime.session.nativeSessionId)
      runtime.transport = candidate.transport
      runtime.generation = generation
      runtime.input = prepared.input
      runtime.scopedCredentialVariable = prepared.scopedCredentialVariable
      runtime.closed = false
      for (const waiting of runtime.interactions.values()) waiting.delivery = 'uncertain'
      await candidate.activate(runtime)
    } catch (error) {
      runtime.closed = true
      await candidate.transport.close().catch(() => undefined)
      throw error
    }
  }

  private restoreRejectedStart(runtime: Runtime, starting: StartingTurn): void {
    if (runtime.starting !== starting) return
    Object.assign(runtime, starting.previous)
    runtime.phase = 'idle'
    runtime.starting = undefined
    starting.resolveIdentity(undefined)
    starting.staged.length = 0
    this.record(runtime, 'turn.start_rejected', { correlationId: starting.correlationId })
  }

  private async acceptStartedTurn(runtime: Runtime, starting: StartingTurn, value: unknown): Promise<void> {
    if (runtime.disposed || runtime.starting !== starting) return
    const turn = object(object(value, 'CODEX_TURN_START_INVALID').turn, 'CODEX_TURN_START_INVALID')
    const turnId = text(turn.id)
    if (!turnId || turnId.length > 1_024 || turnId === starting.previous.activeTurnId) {
      runtime.phase = 'uncertain'
      throw new HarnessExecutionError('CODEX_TURN_START_INVALID', 'Codex did not establish a new turn identity.')
    }
    runtime.activeTurnId = turnId
    runtime.activeCorrelationId = starting.correlationId
    runtime.phase = 'active'
    runtime.starting = undefined
    starting.resolveIdentity(turnId)
    this.record(runtime, 'turn.started', { threadId: runtime.session.nativeSessionId, turnId, clientCorrelationId: starting.correlationId })
    this.applyTurn(runtime, turn)
    for (const event of starting.staged) {
      if ('request' in event) await this.handleRequest(runtime, event.request)
      else this.handleNotification(runtime, event.method, event.params)
    }
    starting.staged.length = 0
    if (starting.cancelRequested && !runtime.terminalResult) await this.interrupt(runtime)
  }

  private interrupt(runtime: Runtime): Promise<boolean> {
    const turnId = runtime.activeTurnId
    if (!turnId || runtime.terminalResult) return Promise.resolve(false)
    if (runtime.cancellation?.turnId === turnId) return runtime.cancellation.promise
    const promise = (async () => {
      for (let attempt = 0; attempt <= INTERRUPT_STARTUP_RETRIES; attempt += 1) {
        if (runtime.terminalResult) return false
        try {
          await runtime.transport.request('turn/interrupt', { threadId: runtime.session.nativeSessionId, turnId })
          this.record(runtime, 'turn.cancel_submitted', { turnId })
          return true
        } catch (error) {
          const startupRace = error instanceof CodexRpcError
            && !error.uncertain
            && error.nativeMessage?.startsWith('no active turn to interrupt')
          if (!startupRace || attempt === INTERRUPT_STARTUP_RETRIES) throw error
          await new Promise((resolve) => setTimeout(resolve, INTERRUPT_STARTUP_RETRY_MS))
        }
      }
      return false
    })()
    runtime.cancellation = { turnId, promise }
    void promise.catch(() => {
      if (runtime.cancellation?.promise === promise) runtime.cancellation = undefined
    })
    return promise
  }

  private stage(runtime: Runtime, event: StartingTurn['staged'][number]): boolean {
    const starting = runtime.starting
    if (!starting || runtime.activeTurnId) return false
    starting.stagedBytes += Buffer.byteLength(JSON.stringify(event))
    if (starting.staged.length >= MAX_STAGED || starting.stagedBytes > MAX_EVENT_BYTES) {
      runtime.phase = 'uncertain'
      throw new Error('The turn-start notification buffer exceeded its limit.')
    }
    starting.staged.push(event)
    return true
  }

  private async synchronize(runtime: Runtime, correlationId?: string, signal?: AbortSignal): Promise<void> {
    const response = object(await runtime.transport.request('thread/read', { threadId: runtime.session.nativeSessionId, includeTurns: false }, signal), 'CODEX_THREAD_READ_INVALID')
    const thread = object(response.thread, 'CODEX_THREAD_READ_INVALID')
    if (thread.id !== runtime.session.nativeSessionId) throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Reconciliation returned another thread.')
    const starting = runtime.starting
    if (starting && correlationId !== starting.correlationId) {
      throw new HarnessExecutionError('CODEX_CORRELATION_MISMATCH', 'Reconcile the correlation of the uncertain turn/start operation.')
    }
    const wantedCorrelation = starting?.correlationId ?? correlationId
    const wantedId = starting ? undefined : wantedCorrelation
      ? runtime.activeCorrelationId === wantedCorrelation ? runtime.activeTurnId
        : runtime.input.correlationId === wantedCorrelation ? runtime.input.nativeTurnId : undefined
      : runtime.input.nativeTurnId ?? runtime.activeTurnId
    const matches = (turn: JsonObject) => wantedId ? turn.id === wantedId
      : wantedCorrelation ? Array.isArray(turn.items) && turn.items.some((item) => isObject(item) && item.type === 'userMessage' && item.id === wantedCorrelation)
        : true
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : []
    let selected = [...turns].reverse().find(matches)
    if (!selected || selected.itemsView !== 'full') {
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      selected = undefined
      for (let page = 0; page < 20; page += 1) {
        const result = object(await runtime.transport.request('thread/turns/list', {
          threadId: runtime.session.nativeSessionId, limit: 50, sortDirection: 'desc', itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        }, signal), 'CODEX_THREAD_READ_INVALID')
        const candidates = Array.isArray(result.data) ? result.data.filter(isObject).filter(matches) : []
        if (wantedCorrelation && candidates.length > 1) throw new HarnessExecutionError('CODEX_CORRELATION_AMBIGUOUS', 'More than one native turn has this correlation.')
        if (candidates[0]) { selected = candidates[0]; break }
        cursor = text(result.nextCursor)
        if (!cursor) break
        if (seenCursors.has(cursor)) throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'Codex repeated a history cursor.')
        seenCursors.add(cursor)
      }
    }
    if (!selected) {
      if (wantedId || wantedCorrelation) {
        runtime.phase = 'uncertain'
        throw new HarnessExecutionError('CODEX_RECONCILIATION_UNCERTAIN', 'The submitted native turn was not found; absence of history does not authorize replay.')
      }
      runtime.phase = 'idle'
      return
    }
    if (!text(selected.id) || !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(selected.status))) {
      throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'The reconciled native turn is malformed.')
    }
    if (selected.itemsView !== 'full') throw new HarnessExecutionError('CODEX_HISTORY_INCOMPLETE', 'Native reconciliation did not return full turn items.')
    if (runtime.phase === 'active' && runtime.activeTurnId && runtime.activeTurnId !== selected.id) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A different native turn is still active; an older result cannot replace its ownership.')
    }
    if (starting) await this.acceptStartedTurn(runtime, starting, { turn: selected })
    else {
      runtime.activeCorrelationId = wantedCorrelation
        ?? (runtime.input.nativeTurnId === selected.id ? runtime.input.correlationId : undefined)
      if (runtime.activeTurnId !== selected.id) {
        runtime.activeTurnId = String(selected.id)
        runtime.finalAnswer = undefined
        runtime.lastAgentMessage = undefined
        runtime.finalAnswerId = undefined
        runtime.lastAgentMessageId = undefined
        runtime.terminalResult = undefined
        runtime.seenNotifications.clear()
      }
      this.applyTurn(runtime, selected)
    }
  }

  private applyTurn(runtime: Runtime, turn: JsonObject): void {
    if (turn.id !== runtime.activeTurnId || !Array.isArray(turn.items)) return
    if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))) return
    for (const value of turn.items) {
      if (isObject(value) && text(value.id) && !['userMessage', 'agentMessage'].includes(String(value.type))) {
        const fingerprint = createHash('sha256').update(canonical(['snapshot', turn.id, value])).digest('hex')
        if (!runtime.seenNotifications.has(fingerprint)) {
          runtime.seenNotifications.add(fingerprint)
          if (runtime.seenNotifications.size > MAX_EVENTS) runtime.seenNotifications.delete(runtime.seenNotifications.values().next().value!)
          this.record(runtime, 'item.snapshot', { threadId: runtime.session.nativeSessionId, turnId: turn.id, nativeTurnStatus: turn.status, item: value })
        }
      }
      if (!isObject(value) || value.type !== 'agentMessage' || typeof value.text !== 'string') continue
      runtime.lastAgentMessage = value.text
      runtime.lastAgentMessageId = text(value.id)
      if (value.phase === 'final_answer') {
        runtime.finalAnswer = value.text
        runtime.finalAnswerId = text(value.id)
      }
    }
    if (turn.status === 'inProgress') {
      if (!runtime.terminalResult) runtime.phase = 'active'
      return
    }
    runtime.terminalResult = turn.status === 'completed'
      ? { outcome: 'succeeded', output: { text: runtime.finalAnswer ?? runtime.lastAgentMessage ?? '' } }
      : turn.status === 'interrupted' ? { outcome: 'canceled' }
        : { outcome: 'failed', error: { code: 'CODEX_TURN_FAILED', message: text(isObject(turn.error) ? turn.error.message : undefined) ?? 'Codex turn failed.', retryable: false } }
    runtime.phase = 'idle'
    for (const [key, waiting] of runtime.interactions) {
      if (waiting.pending.turn.nativeTurnId === turn.id) this.resolveInteraction(runtime, key, waiting, 'cleared')
    }
    this.wake(runtime)
  }

  private async handleRequest(runtime: Runtime, request: RpcRequest): Promise<void> {
    const params = request.params ?? {}
    if (params.threadId !== runtime.session.nativeSessionId) {
      await runtime.transport.reject(request.id, -32602, 'This request belongs to another thread.'); return
    }
    if (this.stage(runtime, { request })) return
    const key = requestKey(runtime.generation, request.id)
    const signature = createHash('sha256').update(canonical([request.method, params])).digest('hex')
    const existing = runtime.interactions.get(key)
    const resolved = runtime.resolvedRequests.get(key)
    if (existing || resolved) {
      // Do not send an error using a still-live original request ID.
      if ((existing?.signature ?? resolved) !== signature) this.record(runtime, 'protocol.conflicting_request_identity', { nativeRequestKey: key })
      return
    }
    if (runtime.interactions.size >= MAX_INTERACTIONS) {
      await runtime.transport.reject(request.id, -32000, 'Native pending-interaction limit exceeded.'); return
    }
    if (request.method === 'mcpServer/elicitation/request' && params.turnId === null) {
      await runtime.transport.reject(request.id, -32601, 'CODEX_STANDALONE_ELICITATION_UNSUPPORTED: the shared approval boundary requires a real native turn.');
      this.record(runtime, 'interaction.unsupported', { nativeMethod: request.method, reason: 'standalone_elicitation' })
      return
    }
    if (!text(params.turnId) || params.turnId !== runtime.activeTurnId || runtime.terminalResult) {
      await runtime.transport.reject(request.id, -32602, 'The request does not belong to the active turn.'); return
    }
    const translated = this.translateRequest(runtime, request, signature)
    if (!translated) {
      await runtime.transport.reject(request.id, -32601, 'The request has no qualified approval mapping; generic questions and nonempty elicitation forms are not approval grants.')
      this.record(runtime, 'interaction.unsupported', { nativeMethod: request.method, reason: 'unqualified_approval_shape' })
      return
    }
    const retainedBytes = [...runtime.interactions.values()].reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.pending)), 0)
    if (retainedBytes + Buffer.byteLength(JSON.stringify(translated.pending)) > MAX_EVENT_BYTES) {
      await runtime.transport.reject(request.id, -32000, 'Native pending-interaction memory limit exceeded.')
      this.record(runtime, 'interaction.capacity_exceeded', { nativeMethod: request.method })
      return
    }
    runtime.interactions.set(key, translated)
    this.record(runtime, 'interaction.pending', {
      nativeRequestId: translated.pending.turn.nativeRequestId, nativeRequestType: request.method,
      turnId: translated.pending.turn.nativeTurnId,
    })
  }

  private translateRequest(runtime: Runtime, request: RpcRequest, signature: string): WaitingRequest | undefined {
    const params = request.params ?? {}
    const turnId = text(params.turnId)
    if (!turnId) return undefined
    const nativeRequestId = `${runtime.session.nativeSessionId}:${turnId}:${request.method}:${requestKey(runtime.generation, request.id)}`
    const responses: WaitingRequest['responses'] = new Map()
    const add = (option: Omit<ApprovalResponseOption, 'optionId'>, nativeResponse: JsonObject) => {
      if (advanced(runtime.configuration).sessionPersistence === 'ephemeral' && option.semantic === 'allow_session') return
      const optionId = `codex-${createHash('sha256').update(canonical([nativeRequestId, nativeResponse])).digest('hex').slice(0, 24)}`
      // Empty optional descriptions are omitted rather than violating the shared schema.
      const { scopeSummary, ...rest } = option
      const parsed = ApprovalResponseOptionSchema.parse({ optionId, ...rest, ...(scopeSummary?.trim() ? { scopeSummary } : {}) })
      responses.set(optionId, { option: parsed, nativeResponse })
    }
    if (request.method === 'item/commandExecution/requestApproval') {
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel']
      for (const decision of decisions) this.addCommandDecision(add, decision)
    } else if (request.method === 'item/fileChange/requestApproval') {
      add(simpleOption('approve_once', 'Approve once', 'request'), { decision: 'accept' })
      add(simpleOption('allow_session', 'Allow for this session', 'session'), { decision: 'acceptForSession' })
      add(simpleOption('reject', 'Reject', 'request'), { decision: 'decline' })
      add(simpleOption('cancel', 'Cancel turn', 'request', true), { decision: 'cancel' })
    } else if (request.method === 'item/permissions/requestApproval') {
      if (!isObject(params.permissions)) return undefined
      add(simpleOption('allow_turn', 'Allow for this turn', 'turn'), { permissions: params.permissions, scope: 'turn' })
      add(simpleOption('allow_session', 'Allow for this session', 'session'), { permissions: params.permissions, scope: 'session' })
      add(simpleOption('reject', 'Reject', 'request'), { permissions: {}, scope: 'turn' })
    } else if (request.method === 'item/tool/requestUserInput') {
      // Exact 0.154.0 MCP approval question, not arbitrary user-input prose.
      const questions = Array.isArray(params.questions) ? params.questions : []
      const question = questions.length === 1 && isObject(questions[0]) ? questions[0] : undefined
      if (!question || !text(question.id)?.startsWith('mcp_tool_call_approval_')
        || question.header !== 'Approve app tool call?' || question.isOther !== false || question.isSecret !== false
        || params.isBlocking !== true || !Array.isArray(question.options)) return undefined
      const choices = question.options.filter(isObject)
      const qualifiedChoices: Record<string, Omit<ApprovalResponseOption, 'optionId'>> = {
        Allow: simpleOption('approve_once', 'Allow', 'request'),
        'Allow for this session': simpleOption('allow_session', 'Allow for this session', 'session'),
        "Allow and don't ask me again": {
          ...simpleOption('persistent_policy_change', "Allow and don't ask me again", 'persistent_config'),
          mutatesPersistentPolicy: true,
        },
        Cancel: simpleOption('cancel', 'Cancel this tool call', 'request'),
      }
      if (choices.length !== question.options.length || !choices.some((choice) => choice.label === 'Allow')
        || !choices.some((choice) => choice.label === 'Cancel')
        || choices.some((choice) => typeof choice.label !== 'string' || !Object.hasOwn(qualifiedChoices, choice.label))) return undefined
      for (const choice of choices) {
        const label = String(choice.label)
        add({ ...qualifiedChoices[label]!, ...(typeof choice.description === 'string' ? { scopeSummary: choice.description } : {}) },
          { answers: { [String(question.id)]: { answers: [label] } } })
      }
    } else if (request.method === 'mcpServer/elicitation/request') {
      let content: JsonObject | null
      if (params.mode === 'url' && text(params.url) && text(params.elicitationId)) content = null
      else if (['form', 'openai/form', 'openaiForm'].includes(String(params.mode)) && isObject(params.requestedSchema)) {
        const schema = params.requestedSchema
        // Only a no-data confirmation is representable by the current choice UI.
        if (schema.type !== 'object'
          || (schema.properties !== undefined && (!isObject(schema.properties) || Object.keys(schema.properties).length > 0))
          || (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 0))
          || Object.keys(schema).some((field) => !['type', 'properties', 'required', 'additionalProperties', 'title', 'description', '$schema'].includes(field))
          || (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')) return undefined
        content = {}
      } else return undefined
      add({ ...simpleOption('approve_once', params.mode === 'url' ? 'Confirm authorization completed' : 'Accept', 'request'),
        ...(typeof params.url === 'string' && params.url.trim() ? { scopeSummary: params.url } : {}) }, { action: 'accept', content, _meta: null })
      // Pinned native MCP approval metadata explicitly advertises persistence.
      if (content !== null && isObject(params._meta) && params._meta.codex_approval_kind === 'mcp_tool_call') {
        const offered = Array.isArray(params._meta.persist) ? params._meta.persist : [params._meta.persist]
        if (offered.includes('session')) add(simpleOption('allow_session', 'Allow for this session', 'session'),
          { action: 'accept', content: {}, _meta: { persist: 'session' } })
        if (offered.includes('always')) add({
          ...simpleOption('persistent_policy_change', "Allow and don't ask me again", 'persistent_config'),
          mutatesPersistentPolicy: true,
        }, { action: 'accept', content: {}, _meta: { persist: 'always' } })
      }
      add(simpleOption('reject', 'Decline', 'request'), { action: 'decline', content: null, _meta: null })
      add(simpleOption('cancel', 'Cancel request', 'request'), { action: 'cancel', content: null, _meta: null })
    } else return undefined
    if (responses.size === 0) return undefined
    const options = [...responses.values()].map((value) => value.option)
    CodexSessionCompatibilitySchema.parse({ configuration: runtime.configuration, responseOptions: options })
    const pending = PendingNativeInteractionSchema.parse({
      session: runtime.session, turn: { nativeTurnId: turnId, nativeRequestId },
      nativeRequestType: request.method, request: params, responseOptions: options,
    })
    let resolve!: WaitingRequest['resolve']
    const resolution = new Promise<'resolved' | 'cleared'>((complete) => { resolve = complete })
    return { pending, requestId: request.id, method: request.method, generation: runtime.generation,
      signature, responses, delivery: 'pending', resolution, resolve }
  }

  private addCommandDecision(
    add: (option: Omit<ApprovalResponseOption, 'optionId'>, response: JsonObject) => void, decision: unknown,
  ): void {
    if (decision === 'accept') add(simpleOption('approve_once', 'Approve once', 'request'), { decision })
    else if (decision === 'acceptForSession') add(simpleOption('allow_session', 'Allow for this session', 'session'), { decision })
    else if (decision === 'decline') add(simpleOption('reject', 'Reject', 'request'), { decision })
    else if (decision === 'cancel') add(simpleOption('cancel', 'Cancel turn', 'request', true), { decision })
    else if (isObject(decision) && isObject(decision.acceptWithExecpolicyAmendment)) {
      add({ ...simpleOption('persistent_policy_change', 'Allow and save command policy', 'persistent_config'),
        scopeSummary: canonical(decision.acceptWithExecpolicyAmendment), mutatesPersistentPolicy: true }, { decision })
    } else if (isObject(decision) && isObject(decision.applyNetworkPolicyAmendment)) {
      const amendment = isObject(decision.applyNetworkPolicyAmendment.network_policy_amendment)
        ? decision.applyNetworkPolicyAmendment.network_policy_amendment : decision.applyNetworkPolicyAmendment
      add({ ...simpleOption('persistent_policy_change', `Save network ${String(amendment.action ?? 'policy')} rule for ${String(amendment.host ?? 'the offered target')}`, 'persistent_config'),
        scopeSummary: canonical(amendment), mutatesPersistentPolicy: true }, { decision })
    }
  }

  private handleNotification(runtime: Runtime, method: string, params: JsonObject): void {
    if (method === 'protocol/malformed') { this.record(runtime, 'native.malformed', params); return }
    if (params.threadId !== undefined && params.threadId !== runtime.session.nativeSessionId) return
    if (['serverRequest/resolved', 'turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) {
      if (params.threadId !== runtime.session.nativeSessionId) return
      if (this.stage(runtime, { method, params })) return
    }
    if (method === 'serverRequest/resolved') {
      if (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') return
      const key = requestKey(runtime.generation, params.requestId)
      const waiting = runtime.interactions.get(key)
      if (waiting) this.resolveInteraction(runtime, key, waiting, 'resolved')
      return
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : undefined
      if (!turn || !text(turn.id) || turn.id !== runtime.activeTurnId || runtime.terminalResult) return
      if (!Array.isArray(turn.items) || !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))) return
      if (method === 'turn/completed' && turn.status === 'inProgress') return
      this.applyTurn(runtime, turn)
      this.record(runtime, method === 'turn/started' ? 'turn.started' : 'turn.completed', { threadId: params.threadId, turnId: turn.id, status: turn.status })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params.threadId !== runtime.session.nativeSessionId || params.turnId !== runtime.activeTurnId || runtime.terminalResult) return
      const item = isObject(params.item) ? params.item : undefined
      if (!item || !text(item.id) || !text(item.type)) return
      const fingerprint = createHash('sha256').update(canonical([method, params.turnId, item.id])).digest('hex')
      if (runtime.seenNotifications.has(fingerprint)) return
      runtime.seenNotifications.add(fingerprint)
      if (runtime.seenNotifications.size > MAX_EVENTS) runtime.seenNotifications.delete(runtime.seenNotifications.values().next().value!)
      if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
        runtime.lastAgentMessage = item.text
        runtime.lastAgentMessageId = text(item.id)
        if (item.phase === 'final_answer') {
          runtime.finalAnswer = item.text
          runtime.finalAnswerId = text(item.id)
        }
      }
      this.record(runtime, method === 'item/started' ? 'item.started' : 'item.completed', params)
      return
    }
    // Streaming events with turn correlation obey the same identity gate.
    if (params.turnId !== undefined && (params.turnId !== runtime.activeTurnId || runtime.terminalResult)) return
    if (method === 'thread/started') {
      if (!isObject(params.thread) || params.thread.id !== runtime.session.nativeSessionId) return
      this.record(runtime, 'thread.started', { threadId: runtime.session.nativeSessionId })
    } else this.record(runtime, 'native.notification', { nativeMethod: method, ...params })
  }

  private resolveInteraction(runtime: Runtime, key: string, waiting: WaitingRequest, result: 'resolved' | 'cleared'): void {
    if (runtime.interactions.get(key) !== waiting) return
    runtime.interactions.delete(key)
    runtime.resolvedRequests.set(key, waiting.signature)
    if (runtime.resolvedRequests.size > MAX_EVENTS) runtime.resolvedRequests.delete(runtime.resolvedRequests.keys().next().value!)
    waiting.resolve(result)
    // Native "resolved" means answered OR cleared, not proof of a permission grant.
    this.record(runtime, `interaction.${result}`, {
      nativeRequestId: waiting.pending.turn.nativeRequestId,
      ...(waiting.selectedOptionId ? { submittedOptionId: waiting.selectedOptionId } : {}),
      evidence: result === 'resolved' ? 'serverRequest/resolved' : 'terminal_turn',
    })
  }

  private handleDisconnect(runtime: Runtime): void {
    runtime.closed = true
    if (runtime.phase === 'starting' || runtime.phase === 'active') runtime.phase = 'uncertain'
    for (const waiting of runtime.interactions.values()) waiting.delivery = 'uncertain'
    this.record(runtime, 'transport.disconnected', { unresolvedInteractions: runtime.interactions.size })
  }

  private record(runtime: Runtime, type: string, payload: JsonObject): void {
    const event = NativeHarnessEventSchema.parse({
      sequence: runtime.sequence, connectionId: runtime.connectionId, type, occurredAt: new Date().toISOString(), payload,
    })
    const size = Buffer.byteLength(JSON.stringify(event))
    if (size > MAX_EVENT_BYTES) throw new HarnessExecutionError('NATIVE_EVENT_TOO_LARGE', 'A native event exceeded the bounded delivery window.')
    runtime.sequence += 1
    runtime.events.push(event)
    runtime.eventSizes.push(size)
    runtime.eventBytes += size
    while (runtime.events.length > MAX_EVENTS || runtime.eventBytes > MAX_EVENT_BYTES) {
      runtime.events.shift()
      runtime.eventBytes -= runtime.eventSizes.shift()!
    }
    this.wake(runtime)
  }
  private wake(runtime: Runtime): void {
    for (const resolve of runtime.wake) resolve()
    runtime.wake.clear()
  }
  private wait(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')) }
      const cleanup = () => { runtime.wake.delete(done); signal?.removeEventListener('abort', abort) }
      runtime.wake.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

function simpleOption(
  semantic: ApprovalResponseOption['semantic'], label: string,
  persistence: ApprovalResponseOption['persistence'], interruptsCurrentTurn = false,
): Omit<ApprovalResponseOption, 'optionId'> {
  return { semantic, label, persistence, affectsOtherPendingRequests: false, interruptsCurrentTurn, mutatesPersistentPolicy: false }
}
