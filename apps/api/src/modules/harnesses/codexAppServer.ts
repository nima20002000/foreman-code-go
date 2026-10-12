import { worktreeSecurity } from './worktreeSecurity.js'
import { codexDisabledMcpTransports } from './codexNativeTools.js'
import { APP_MCP_SERVER_NAMES, APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { beginRuntimeTiming, runtimeTimingPoint, timeRuntimeOperation } from '../diagnostics/runtimeTiming.js'
import { isWorkflowStart, sessionStartConfiguration, sessionStartDirectory, sessionStartOwner,
  sessionStartCorrelation, sessionStartSystemPrompt } from './sessionStart.js'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { SessionPreferencesSchema, type SessionPreferences } from '@foreman-code/contracts'
import { codexCollaborationMode, codexCompactionNotification, codexContextSnapshot } from './codexSessionControls.js'
import type { CompactionState, ContextSnapshot, SessionControlCapabilities } from '@foreman-code/contracts'
import type { NativeCompactInput } from './port.js'
import { childHistoryCursor, childHistoryEvent, encodeChildHistoryCursor } from '../subagents/nativeReadback.js'
import { APP_MCP_SERVER_NAME, chatExcludedAppMcpServerNames, appMcpServerName, appLauncherTokenName, isAppLauncher, isSupportedAppMcpServerName, isSupportedAppMcpTokenName } from './appMcpLauncher.js'
import { requireCodexAppMcp } from './codexMcpReadiness.js'
import { createHash, randomUUID } from 'node:crypto'
import { normalize } from 'node:path'

import {
  CODEX_INTERACTION_SUPPORT, CodexHarnessConfigurationSchema,
  DEFAULT_CODEX_ADVANCED_CONFIGURATION, McpDetectionSchema, NativeHarnessCapabilitiesSchema,
  NativeHarnessEventSchema, NativeSessionReferenceSchema,
  type ApprovalResponseOption, type CodexAdvancedConfiguration, type CodexHarnessConfiguration,
  type ExecutionResult, type McpDetection, type NativeHarnessCapabilities, type NativeHarnessEvent,
  type NativeSessionReference, type PendingNativeInteraction,
  isSessionNativeInteraction, nativeMcpServerAllowed,
} from '@foreman-code/contracts'

import { DomainError } from '../errors.js'
import { HarnessExecutionError, NativeDeliveryError, NativeTurnNotActiveError } from './errors.js'
import { CodexRuntimeFileTurn, type CodexChatFiles } from './codexFiles/runtime.js'
import { CodexFilePreparationCleanupError } from './codexFiles/turn.js'
import { codexChatFileDeclarations, codexChatFileTools } from './codexFiles/declarations.js'
import { CodexRuntimeNativeOutputTurn, codexNativeOutputDeclarations, CODEX_NATIVE_OUTPUT_TOOL_ALIASES,
  type CodexNativeOutputs, type CodexNativeOutputQualificationInput, type CodexNativeOutputSandbox } from './codexNativeOutput.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { readNativeCodexModelCatalog } from './codexModelCatalog.js'
import { nativeQualification } from './nativeQualification.js'
import { detachedStdioEnvironment, hasDetachedStdioProcess, type NativeProcessRecovery } from './recovery/processRegistry.js'
import { codexModelOptions } from './operatorOptions.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeSteerInput, NativeSteerReceipt, NativeTurnInput } from './port.js'
import { runCommand } from './process.js'
import { appMcpTokenEnvironment, inheritedAgentEnvironment, isControllerEnvironmentVariable } from './secrets.js'
import { agentInstructionBundle } from '../skills/instructions.js'
import {
  assertCodexUnchanged, canonical, codexRequest, qualifyCodex,
  type QualifiedCodex,
} from './codexProtocol.js'
import { resolveCodexInteractionResponse, translateCodexInteraction } from './codexInteractions.js'
import { CodexChildControls } from './codexChildControls.js'
import { codexInputDeliveryEvidence } from './codexResponseDelivery.js'
import { responseValueDigest, type NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import type { NativeResponseJournal } from './recovery/responseJournal.js'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { SubagentControlLease } from '../subagents/types.js'
import { normalizeCodexNotification } from './codexNormalization.js'
import { unavailableNativeResponse, type NativeResponseAvailability, type NativeResponseAvailabilityQuery } from './responseAvailability.js'
import { CodexRpcError, CodexStdioTransport, isObject, object, text, type JsonObject, type RequestId, type RpcRequest } from './codexStdioTransport.js'
import { CODEX_CAPACITY_ATTEMPTS, codexCapacityDelay, isCodexCapacityError, waitForCodexCapacity } from './codexCapacity.js'

/** Structural client boundary shared by native production and recorded replay. */
export type CodexTransport = Pick<CodexStdioTransport, 'start' | 'request' | 'respond' | 'reject' | 'close'>
  & { isConnected?(): boolean; reattached?(): boolean; detachForRestart?(): Promise<void>
    retainedThreadSettings?(threadId: string): JsonObject | undefined }
interface CodexSessionOperations {
  prepareEnvironment?: () => Promise<void>
  transport: (...args: ConstructorParameters<typeof CodexStdioTransport>) => CodexTransport
  qualify: typeof qualifyCodex
  assertUnchanged: typeof assertCodexUnchanged
  environment: typeof safeEnvironment
  runCommand: typeof runCommand
  qualifyModel: typeof qualifyNativeCodexModel
  id: () => string
  now: () => Date
  schedule: typeof setTimeout
  cancelTimer: typeof clearTimeout
  withDiagnostics<T>(pin: CodexDiagnosticPin, run: (io: CodexDiagnosticOperations) => Promise<T>): Promise<T>
}
export interface CodexDiagnosticPin {
  binary: string
  expectedVersion?: string
  cwd: string
  configurationIdentity: string
  scopedCredentialVariables: readonly string[]
  signal?: AbortSignal
}
export type CodexDiagnosticOperations = Pick<CodexSessionOperations,
  'qualify' | 'assertUnchanged' | 'runCommand' | 'qualifyModel' | 'environment'>
/** Replay must supply every IO boundary; partial replay cannot launch native IO. */
export type CodexSessionDependencies =
  | ({ mode: 'native' } & Partial<CodexSessionOperations>)
  | ({ mode: 'replay' } & CodexSessionOperations)
export interface CodexInspectionOptions {
  /** Original installed placement CWD; omitted local callers retain process.cwd(). */
  workingDirectory?: string
}

/** Manager-local residency evidence, never physical process or remote writer authority.
 * A saved thread resumed in a replacement app-server cannot produce this pin. */
export interface CodexOriginalResidency {
  readonly session: NativeSessionReference
  readonly connectionId: string
  readonly runtimeGeneration: number
  /** Only a native ACK past the onSubmitted admission gate establishes a turn here. */
  readonly nativeTurnId: string | undefined
}
export interface CodexOriginalSessionLifetime {
  readonly residency: CodexOriginalResidency
  /** Compose with the caller's existing Main/device/writer fence. */
  assertCurrent(): void
}

const MAX_EVENTS = 1_024
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const MAX_HISTORY_BYTES = 128 * 1024
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
  transport: CodexTransport
  conflictingIdentity?: boolean
  signature: string
  responses: Map<string, { option: ApprovalResponseOption; nativeResponse: JsonObject }>
  delivery: Delivery
  selectedOptionId?: string
  resolution: Promise<'resolved' | 'cleared'>
  resolve(value: 'resolved' | 'cleared'): void
}
interface ResolvedRequest {
  signature: string
  nativeRequestId: string | undefined
  nativeTurnId: string | undefined
  method: string
  generation: number
  /** File identity is reserved before work/response awaits, not native acceptance. */
  pending?: boolean
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
  nativeAttemptId?: string
  previous: TurnSnapshot
  cancelRequested: boolean
  preparationController: AbortController
  filePreparation?: Promise<CodexRuntimeFileTurn | undefined>
  nativeOutputPreparation?: Promise<CodexRuntimeNativeOutputTurn>
  onSubmitted?: NativeTurnInput['onSubmitted']
  acknowledgement?: Promise<void>
  acknowledgedTurnId?: string
  nativeIdentity: Promise<string | undefined>
  resolveIdentity(id: string | undefined): void
  staged: Array<{ method: string; params: JsonObject; arrivalOrdinal?: number } | { request: RpcRequest }>
  stagedBytes: number
}
interface Runtime extends TurnSnapshot {
  capacityRetry?: {
    attempt: number
    canAdvanceIdentity: boolean
    controller: AbortController
    failure?: ExecutionResult
  }
  parent?: Runtime
  contextBudgetLimit?: number
  sessionPreferences?: SessionPreferences
  compactionPreviousTurns?: Set<string>
  compaction?: CompactionState
  context?: ContextSnapshot
  readonly connectionId: string
  readonly schemaIdentity: string
  arrivalOrdinal: number
  readonly attached: boolean
  readonly binding: string
  readonly ownerId: string
  readonly configurationIdentity: string
  input: NativeSessionStart
  workingDirectory: string
  configuration: CodexHarnessConfiguration
  scopedCredentialVariable: string | undefined
  approvedAppMcpServerName: string | undefined
  strippedCredentialVariable: string | undefined
  qualified: QualifiedCodex
  transport: CodexTransport
  session: NativeSessionReference
  generation: number
  phase: 'idle' | 'starting' | 'active' | 'uncertain'
  streamActive: boolean
  starting: StartingTurn | undefined
  files: CodexRuntimeFileTurn | undefined
  fileCleanup: Promise<void> | undefined
  nativeOutput?: CodexRuntimeNativeOutputTurn | undefined
  nativeOutputCleanup?: Promise<void> | undefined
  effectiveSandbox?: CodexNativeOutputSandbox | undefined
  fileRequests: Map<string, { signature: string; pending: boolean; conflictingIdentity?: boolean }>
  cancellation: { turnId: string; promise: Promise<boolean> } | undefined
  interactions: Map<string, WaitingRequest>
  resolvedRequests: Map<string, ResolvedRequest>
  callbackOwners: Map<string, string>
  rejectedStarts: Map<string, ExecutionResult>
  responseDecisions: Map<string, { pending: PendingNativeInteraction; option: ApprovalResponseOption;
    nativeResponse: JsonObject; sequence: number }>
  responseDeliveries: Map<string, NativeResponseDeliveryEvidence>
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
  contextBudgetLimit?: number | undefined
  input: NativeSessionStart
  harnessConfiguration: CodexHarnessConfiguration
  workingDirectory: string
  scopedCredentialVariable: string | undefined
  strippedCredentialVariable: string | undefined
  environment: NodeJS.ProcessEnv
  qualified: QualifiedCodex
  disabledMcpServerNames: readonly string[]
  mcpTransportOverrides?: Record<string, string>
  nativeApps?: boolean | undefined
  /** The App MCP server whose tools a workflow Agent calls without native prompts; app grants still authorize each call. */
  approvedAppMcpServerName?: string
  effectiveSandbox?: CodexNativeOutputSandbox
}
interface Creation {
  identity: string
  status: 'creating' | 'uncertain' | 'ready' | 'rejected'
  source?: NativeSessionReference
  rejection?: unknown
  promise?: Promise<NativeSessionReference>
  session?: NativeSessionReference
  transport?: CodexTransport
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
    automaticEndpoint?: boolean
    enabledTools: string[] | null; disabledTools: string[]
    defaultToolsApprovalMode: string | null; tools: JsonObject
  }
}
export interface CodexQualificationEvidence {
  providerVersion: string
  schemaManifestSha256: string
  referenceSchemaManifestSha256: string
  stableSchemaGitBlob: string
  schemaVerification: 'installed-contract-validation'
  authentication: 'chatgpt'
  productionSupported: false
  productionRestriction: string
}

function advanced(value: CodexHarnessConfiguration): CodexAdvancedConfiguration {
  return value.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION
}
function accepted(input: NativeSessionStart) { return sessionStartConfiguration(input) }
function ownerId(input: NativeSessionStart): string {
  return sessionStartOwner(input)
}
function binding(input: NativeSessionStart): string {
  if (input.kind === 'operator') return canonical({ kind: 'operator', ownerId: ownerId(input), cwd: input.workingDirectory })
  if (input.kind === 'agent-chat') return canonical({ kind: input.kind, conversationId: input.conversationId,
    ownerId: ownerId(input), workspaceId: input.configuration.workspaceId,
    workflowId: input.workflowId, workflowNodeId: input.workflowNodeId, cwd: input.workingDirectory })
  return canonical({ kind: 'workflow', ownerId: ownerId(input), workspaceId: input.request.workspaceId,
      runId: input.request.runId, workflowNodeId: input.request.workflowNodeId, cwd: input.request.workingDirectory })
}
/** App-owned developer instructions: the accepted configuration's pinned bundle, never the live catalog.
 * Native base instructions stay Codex's own. Earlier accepted configurations keep their system prompt only. */
function instructions(input: NativeSessionStart): string | null {
  if (input.kind === 'operator') return agentInstructionBundle(input.configuration)?.text ?? null
  const configuration = input.kind === 'agent-chat' ? input.configuration : input.request.configuration
  const agentInstructions = configuration.instructionDelivery === 'native-v1'
    ? agentInstructionBundle(configuration)?.text : configuration.prompt.system
  return [sessionStartSystemPrompt(input)?.value.text, agentInstructions].filter(Boolean).join('\n\n') || null
}
function credentialIdentity(input: NativeSessionStart): string {
  return canonical(input.environment ?? null)
}
function validateEnvironmentVariables(input?: NativeSessionStart['environment']): void {
  for (const key of Object.keys(input?.variables ?? {})) {
    // Operator and Worker credentials use the admitted App token; the server resolves its role.
    if (!isSupportedAppMcpTokenName(key) && isControllerEnvironmentVariable(key)) {
      throw new HarnessExecutionError('CODEX_ENVIRONMENT_INVALID', 'An Agent environment cannot contain application-global secrets.')
    }
  }
}
export function safeEnvironment(input?: NativeSessionStart['environment'], scopedNames: readonly string[] = []): NodeJS.ProcessEnv {
  validateEnvironmentVariables(input)
  const environment = inheritedAgentEnvironment()
  for (const key of scopedNames) delete environment[key]
  if (input) {
    for (const [key, value] of Object.entries(input.variables)) {
      environment[key] = value
    }
  }
  return appMcpTokenEnvironment(environment)
}
function validateEnvironmentOwner(input: NativeSessionStart, requiredVariable?: string): void {
  if (input.environment && input.environment.agentId !== ownerId(input)) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The scoped process environment belongs to another Agent.')
  }
  if (isWorkflowStart(input) && input.request.workspaceId !== input.request.configuration.workspaceId) {
    throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The accepted configuration belongs to another workspace.')
  }
  const token = requiredVariable && isSupportedAppMcpTokenName(requiredVariable)
    ? readProductEnvironment(input.environment?.variables ?? {}, 'MCP_TOKEN') : input.environment?.variables[requiredVariable ?? '']
  if (requiredVariable && !token) {
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
function threadParameters(
  prepared: Pick<Prepared, 'harnessConfiguration' | 'workingDirectory' | 'input' | 'disabledMcpServerNames'
    | 'mcpTransportOverrides' | 'nativeApps' | 'approvedAppMcpServerName'>,
  resume = false,
): JsonObject {
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
      ...(prepared.input.sessionPreferences?.contextBudget != null
        ? { model_context_window: prepared.input.sessionPreferences.contextBudget } : {}),
      ...(prepared.input.sessionPreferences?.autoCompactTokens != null
        ? { model_auto_compact_token_limit: prepared.input.sessionPreferences.autoCompactTokens } : {}),
      ...Object.fromEntries(prepared.disabledMcpServerNames.map((name) => [`mcp_servers.${name}.enabled`, false])),
      ...prepared.mcpTransportOverrides,
      ...(prepared.nativeApps !== undefined ? { 'features.apps': prepared.nativeApps } : {}),
      // Codex 0.16x prompts for every MCP tool call under on-request approval; an unattended workflow Agent would
      // wait on its own App tools (ci_run, context_get) forever. Each call is still authorized by the Agent's grants.
      ...(prepared.approvedAppMcpServerName
        ? { [`mcp_servers.${prepared.approvedAppMcpServerName}.default_tools_approval_mode`]: 'approve' } : {}),
      ...(prepared.input.kind === 'operator' ? { model_reasoning_summary: prepared.input.configuration.showThinking ? 'auto' : 'none' } : {}),
    },
    // A resumed or forked thread already carries its accepted developer instructions.
    ...(resume || (prepared.input.kind !== 'operator' && prepared.input.instructionsDelivered) ? {} : { developerInstructions: instructions(prepared.input) }),
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
function itemNotificationKey(generation: number, method: string, turnId: unknown, itemId: unknown, itemType: unknown): string {
  return createHash('sha256').update(canonical([generation, method, turnId, itemId, itemType])).digest('hex')
}
function stagedNativeOutputTerminal(runtime: Runtime, turnId: string): boolean {
  return runtime.starting?.staged.some(event => 'method' in event && event.method === 'turn/completed'
    && event.params.threadId === runtime.session.nativeSessionId && isObject(event.params.turn)
    && event.params.turn.id === turnId && ['completed', 'failed', 'interrupted'].includes(String(event.params.turn.status))) ?? false
}

function snapshot(runtime: Runtime): TurnSnapshot {
  return {
    activeTurnId: runtime.activeTurnId, activeCorrelationId: runtime.activeCorrelationId,
    terminalResult: runtime.terminalResult, finalAnswer: runtime.finalAnswer, lastAgentMessage: runtime.lastAgentMessage,
    finalAnswerId: runtime.finalAnswerId, lastAgentMessageId: runtime.lastAgentMessageId,
  }
}
function isUncertain(error: unknown): boolean { return error instanceof CodexRpcError && error.uncertain }
function deadline<T>(promise: Promise<T>, signal?: AbortSignal, milliseconds = RESPONSE_DEADLINE_MS, timers: Pick<CodexSessionOperations, 'schedule' | 'cancelTimer'> = { schedule: setTimeout, cancelTimer: clearTimeout }): Promise<T> {
  signal?.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      timers.cancelTimer(timer)
      signal?.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve(value as T)
    }
    const abort = () => finish(signal?.reason ?? new Error('Aborted'))
    const timer = timers.schedule(() => finish(new HarnessExecutionError('NATIVE_RECONCILIATION_REQUIRED', 'Native confirmation has not arrived; reconcile before retrying.')), milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    void promise.then((value) => finish(undefined, value), (error: unknown) => finish(error))
  })
}

export class CodexAppServerSessionManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  private startupPreferences: SessionPreferences | undefined
  private readonly runtimes = new Map<string, Runtime>()
  private readonly locks = new Set<string>()
  private readonly creations = new Map<string, Creation>()
  private readonly childControls = new CodexChildControls()
  private readonly childRuntimes = new Map<string, { runtime: Runtime; child: RunSubagent; assertCurrent(): void }>()
  private readonly lifecycleTails = new Map<string, Promise<void>>()
  private loginControl: { transport: CodexTransport; loginId?: string; timer?: NodeJS.Timeout } | undefined
  private loginStarting = false
  private disposal: Promise<void> | undefined
  private readonly shutdownController = new AbortController()
  private readonly transports = new Set<CodexTransport>()

  private readonly dependencies: CodexSessionOperations

  constructor(
    private readonly binary: string,
    private readonly expectedVersion?: string,
    private readonly appMcpServerName: string = APP_MCP_SERVER_NAME,
    private readonly processRecovery?: NativeProcessRecovery,
    /** Agent chat disables only its App MCP entry with a verified process-local override. */
    private readonly appMcpAccess: 'scoped' | 'none' = 'scoped',
    private readonly chatFiles?: CodexChatFiles,
    dependencies: CodexSessionDependencies = { mode: 'native' },
    private readonly inspection: CodexInspectionOptions = {},
    private readonly nativeOutputs?: CodexNativeOutputs,
    private readonly responseJournal?: NativeResponseJournal,
  ) {
    const defaults: CodexSessionOperations = {
      transport: (...args) => new CodexStdioTransport(...args),
      qualify: (binary, cwd, environment, authentication, signal) =>
        qualifyCodex(binary, cwd, environment, authentication, signal, this.processRecovery),
      assertUnchanged: assertCodexUnchanged, environment: safeEnvironment,
      runCommand: (binary, args, cwd, signal, environment, options) => runCommand(binary, args, cwd, signal, environment,
        { ...options, ...(this.processRecovery ? { recovery: this.processRecovery } : {}) }),
      qualifyModel: (configuration, binary, cwd, environment, signal, _recovery, inspection) =>
        qualifyNativeCodexModel(configuration, binary, cwd, environment, signal, this.processRecovery, inspection),
      id: randomUUID, now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
      withDiagnostics: async (pin, run) => {
        if (this.processRecovery) throw new HarnessExecutionError('CODEX_DIAGNOSTIC_OWNER_REQUIRED',
          'Idle native inspection requires a separately owned diagnostic lifetime.')
        return run({ ...this.dependencies, environment: (_input, names = []) =>
          this.dependencies.environment(undefined, [...pin.scopedCredentialVariables, ...names]) })
      },
    }
    if (dependencies.mode === 'replay') {
      for (const key of Object.keys(defaults) as Array<keyof CodexSessionOperations>) {
        if (typeof dependencies[key] !== 'function') throw new HarnessExecutionError(
          'CODEX_REPLAY_DEPENDENCIES_REQUIRED', 'Replay requires every native IO boundary to be explicitly supplied.')
      }
    }
    this.dependencies = { ...defaults, ...dependencies }
  }

  async capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const result = await this.dependencies.qualify(this.binary, this.inspection.workingDirectory ?? process.cwd(), this.dependencies.environment(), true, signal)
    return NativeHarnessCapabilitiesSchema.parse({
      provider: 'codex', providerVersion: result.providerVersion, persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true,
      mcpDetection: true,
      supportedInteractionKinds: ['command_approval', 'file_approval', 'permission_profile',
        'mcp_tool_call_approval_question', 'mcp_confirmation', 'tool_user_input', 'mcp_elicitation'],
      interactionSupport: CODEX_INTERACTION_SUPPORT,
    })
  }

  /** Qualify the same native transport/settings without creating a thread or issuing an App credential. */
  async qualifyConfiguration(value: CodexHarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const parsed = CodexHarnessConfigurationSchema.safeParse(value)
    if (!parsed.success) throw new HarnessExecutionError('CODEX_SETTING_INVALID', 'The accepted Codex configuration is invalid.')
    const environment = this.dependencies.environment()
    const qualified = await this.dependencies.qualify(this.binary, workingDirectory, environment, true, signal)
    await this.validateMcpPolicies(parsed.data, qualified.binary, workingDirectory, environment, signal)
    await this.dependencies.qualifyModel(parsed.data, qualified.binary, workingDirectory, environment, signal,
      undefined, { qualified, assertUnchanged: this.dependencies.assertUnchanged,
        runCommand: this.dependencies.runCommand,
        transportFactory: (...args) => this.ownTransport(this.dependencies.transport(...args)) })
    return nativeQualification(parsed.data, qualified.providerVersion)
  }

  async discoverModels(workingDirectory: string, signal?: AbortSignal) {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const qualified = await this.dependencies.qualify(this.binary, workingDirectory, this.dependencies.environment(), true, signal)
    await this.dependencies.assertUnchanged(qualified)
    const catalog = await readNativeCodexModelCatalog({ qualified, assertUnchanged: this.dependencies.assertUnchanged,
      runCommand: this.dependencies.runCommand,
      transportFactory: (...args) => this.ownTransport(this.dependencies.transport(...args)) },
      workingDirectory, this.dependencies.environment(), signal, this.processRecovery)
    return { providerVersion: qualified.providerVersion, models: codexModelOptions(catalog) }
  }

  async qualificationEvidence(signal?: AbortSignal): Promise<CodexQualificationEvidence> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const result = await this.dependencies.qualify(this.binary, this.inspection.workingDirectory ?? process.cwd(), this.dependencies.environment(), true, signal)
    return {
      providerVersion: result.providerVersion, schemaManifestSha256: result.schemaManifestSha256,
      referenceSchemaManifestSha256: result.referenceSchemaManifestSha256, stableSchemaGitBlob: result.stableSchemaGitBlob,
      schemaVerification: 'installed-contract-validation',
      authentication: 'chatgpt', productionSupported: false,
      productionRestriction: 'Codex app-server remains experimental upstream. It is the only application execution transport; native qualification failure refuses execution.',
    }
  }

  async createSession(source: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    if (isWorkflowStart(source) && source.sessionContinuation) {
      return this.attachSession(source.sessionContinuation.session, { ...source, instructionsDelivered: true }, signal)
    }
    return this.beginCreation(source, { signal })
  }

  private async beginCreation(source: NativeSessionStart,
    options: { forkSource?: NativeSessionReference; signal?: AbortSignal | undefined }): Promise<NativeSessionReference> {
    const { forkSource, signal } = options
    this.shutdownController.signal.throwIfAborted()
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source)
    if (forkSource && input.kind !== 'operator') input.instructionsDelivered = true
    const key = this.creationKey(input)
    const identity = this.creationIdentity(input, forkSource)
    const existing = this.creations.get(key)
    if (existing) {
      if (existing.identity !== identity) throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH', 'The creation correlation belongs to a different accepted session.')
      if (existing.session) return structuredClone(existing.session)
      if (existing.status === 'rejected') return this.rejectCreation(existing)
      if (existing.status === 'uncertain') throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'A native thread may already exist for this creation correlation; do not create another one.')
      return structuredClone(await existing.promise!)
    }
    if (this.creations.size >= 128) throw new HarnessExecutionError('CODEX_CREATION_LIMIT', 'Resolve or close existing sessions before creating more.')
    const creation: Creation = { identity, status: 'creating', ...(forkSource ? { source: structuredClone(forkSource) } : {}) }
    this.creations.set(key, creation)
    creation.promise = this.create(input, creation, key, signal)
    return structuredClone(await creation.promise)
  }

  /** Retrieve an identity learned from a late thread/start response without replaying it. */
  async reconcileSessionCreation(input: NativeSessionStart, signal?: AbortSignal,
    forkSource?: NativeSessionReference): Promise<NativeSessionReference> {
    signal?.throwIfAborted()
    this.shutdownController.signal.throwIfAborted()
    const creation = this.creations.get(this.creationKey(input))
    const identity = this.creationIdentity(input, forkSource)
    if (!creation || creation.identity !== identity) {
      throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'Native creation identity is not established; no replacement thread was created.')
    }
    if (creation.status === 'rejected') return this.rejectCreation(creation)
    if (!creation.session) {
      throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'Native creation identity is not established; no replacement thread was created.')
    }
    return structuredClone(creation.session)
  }

  private creationIdentity(input: NativeSessionStart, source?: NativeSessionReference): string {
    return canonical({ binding: binding(input), configuration: accepted(input),
      systemPrompt: sessionStartSystemPrompt(input) ?? null,
      environment: input.environment ?? null, source: source ?? null,
      sessionPreferences: input.sessionPreferences ?? this.startupPreferences ?? null })
  }

  private async rejectCreation(creation: Creation): Promise<never> {
    try { await creation.transport?.close() } catch (error) {
      throw new NativeDeliveryError('session_creation', 'not_sent', error, 'pending')
    }
    throw new NativeDeliveryError('session_creation', 'not_sent', creation.rejection)
  }

  private creationKey(input: NativeSessionStart): string {
    const correlation = sessionStartCorrelation(input)
    if (!correlation) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Session creation requires a stable correlation ID.')
    return canonical([binding(input), correlation])
  }

  private async create(input: NativeSessionStart, creation: Creation, key: string, signal?: AbortSignal): Promise<NativeSessionReference> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    let candidate: Awaited<ReturnType<CodexAppServerSessionManager['transport']>> | undefined
    let expiration: NodeJS.Timeout | undefined
    let creationAttempted = false
    let creationAccepted = false
    const method = creation.source ? 'thread/fork' : 'thread/start'
    try {
      const prepared = await this.prepareInput(input, signal)
      if (creation.source) {
        this.assertSessionVersion(creation.source)
      }
      candidate = await this.transport(prepared, 0, signal)
      creation.transport = candidate.transport
      const publish = async (value: unknown): Promise<NativeSessionReference> => {
        creationAccepted = true
        this.shutdownController.signal.throwIfAborted()
        const response = object(value, 'CODEX_THREAD_START_INVALID')
        const thread = this.validateThreadResponse(prepared, response)
        if (thread.id === creation.source?.nativeSessionId) {
          throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex returned the source thread instead of a fork.')
        }
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
        this.dependencies.cancelTimer(expiration)
        this.record(runtime, creation.source ? 'thread.forked' : 'thread.started', {
          threadId: session.nativeSessionId,
          ...(creation.source ? { sourceThreadId: creation.source.nativeSessionId } : {}),
        })
        return session
      }
      const params = {
        ...threadParameters(prepared, Boolean(creation.source && this.chatFiles)),
        ephemeral: advanced(prepared.harnessConfiguration).sessionPersistence === 'ephemeral',
        ...(creation.source ? { threadId: creation.source.nativeSessionId, excludeTurns: true } : {}),
        // Codex persists declarations at thread/start; thread/resume cannot add
        // them when a text-first Operator later attaches files.
        // Declarations grant no access: handlers still require an admitted file
        // turn and its durable ACK, never the credentialed text-mode process.
        ...(!creation.source && (this.chatFiles || prepared.input.kind === 'operator')
          ? { dynamicTools: codexChatFileDeclarations(prepared.harnessConfiguration, prepared.qualified.providerVersion) }
          : !creation.source && this.nativeOutputs ? { dynamicTools: codexNativeOutputDeclarations(prepared.harnessConfiguration, prepared.qualified.providerVersion, this.nativeOutputs) } : {}),
      }
      creationAttempted = true
      const result = await candidate.transport.request(method, params, signal, (value, error) => {
        void (async () => {
          if (error) {
            this.dependencies.cancelTimer(expiration)
            creation.status = 'rejected'
            creation.rejection = error
            await candidate!.transport.close()
          } else await publish(value)
        })().catch(() => { void candidate!.transport.close().catch(() => undefined) })
      })
      return await publish(result)
    } catch (error) {
      const notCreated = !creationAttempted || !creationAccepted && error instanceof CodexRpcError
        && error.method === method && !error.uncertain
      if (!notCreated && isUncertain(error) && candidate && !this.shutdownController.signal.aborted) {
        creation.status = 'uncertain'
        // Keep a bounded late-response window. Expiry never authorizes a retry.
        expiration = this.dependencies.schedule(() => { void candidate!.transport.close().catch(() => undefined) }, 300_000)
        creation.timer = expiration
        expiration.unref()
      } else {
        try { await candidate?.transport.close() }
        catch (cleanupError) {
          creation.status = notCreated ? 'rejected' : 'uncertain'
          if (notCreated) creation.rejection = error
          throw new NativeDeliveryError('session_creation', notCreated ? 'not_sent' : 'unknown',
            new AggregateError([error, cleanupError], 'Native setup failed and transport closure is unconfirmed.', { cause: cleanupError }), 'pending')
        }
        if (notCreated) this.creations.delete(key)
        else creation.status = 'uncertain'
      }
      throw new NativeDeliveryError('session_creation', notCreated ? 'not_sent' : 'unknown', error)
    }
  }

  /** Passive lookup; never launches, reads history, renews credentials or replaces ownership. */
  originalSessionLifetime(session: NativeSessionReference, source: NativeSessionStart): CodexOriginalSessionLifetime | undefined {
    this.assertSessionVersion(session)
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime) return undefined
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source), reference = structuredClone(session)
    this.assertOriginalBinding(runtime, session, input)
    if (!this.isOriginalResident(runtime)) return undefined
    const residency: CodexOriginalResidency = {
      session: structuredClone(runtime.session), connectionId: runtime.connectionId,
      runtimeGeneration: runtime.generation, nativeTurnId: runtime.activeTurnId,
    }
    // Capture a private copy: mutating a caller's readback cannot retarget the fence.
    const pin = structuredClone(residency)
    return { residency, assertCurrent: () => { this.requireOriginalResidency(reference, input, pin) } }
  }

  /** Reattach only the surviving original stdio runtime. Cold/generation reconnect is unsupported. */
  async reattachOriginalSession(session: NativeSessionReference, source: NativeSessionStart,
    residency: CodexOriginalResidency, signal?: AbortSignal): Promise<NativeSessionReference> {
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source), pin = structuredClone(residency)
    return this.exclusive(session.nativeSessionId, async () => {
      signal?.throwIfAborted()
      const runtime = this.requireOriginalResidency(session, input, pin)
      const response = object(await runtime.transport.request('thread/read', {
        threadId: session.nativeSessionId, includeTurns: false,
      }, signal))
      // A late read must not bless a disconnected, replaced or differently admitted turn.
      signal?.throwIfAborted()
      this.requireOriginalResidency(session, input, pin)
      if (object(response.thread).id !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex read a different native thread.')
      }
      return structuredClone(runtime.session)
    })
  }

  /** Control is restricted to the exact admitted original turn; no cold-attach fallback. */
  async cancelOriginalTurn(session: NativeSessionReference, source: NativeSessionStart,
    residency: CodexOriginalResidency, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    this.requireOriginalResidency(session, source, residency)
    if (!residency.nativeTurnId) throw new NativeTurnNotActiveError()
    return this.cancel(session, signal, residency.nativeTurnId)
  }

  async respondOriginal(session: NativeSessionReference, source: NativeSessionStart,
    residency: CodexOriginalResidency, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const runtime = this.requireOriginalResidency(session, source, residency)
    const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === nativeRequestId)
    if (!residency.nativeTurnId || runtime.terminalResult
      || waiting && waiting.pending.turn.nativeTurnId !== residency.nativeTurnId) throw new NativeTurnNotActiveError()
    return this.respond(session, nativeRequestId, option, signal)
  }

  private isOriginalResident(runtime: Runtime): boolean {
    return !runtime.attached && runtime.generation === 0 && !runtime.closed && !runtime.disposed
      && !runtime.starting && runtime.phase !== 'uncertain' && this.transports.has(runtime.transport)
      && runtime.transport.isConnected?.() === true
      && !this.shutdownController.signal.aborted
  }

  private assertOriginalBinding(runtime: Runtime, session: NativeSessionReference, input: NativeSessionStart): void {
    if (runtime.session.providerVersion !== session.providerVersion) {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
    }
    this.assertBinding(runtime, input)
    if (input.nativeTurnId !== undefined && input.nativeTurnId !== runtime.activeTurnId) {
      throw new HarnessExecutionError('CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The accepted native turn does not match the resident turn.')
    }
    if (credentialIdentity(runtime.input) !== credentialIdentity(input)) {
      throw new HarnessExecutionError('CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED', 'Original residency requires the accepted process environment.')
    }
  }

  private requireOriginalResidency(session: NativeSessionReference, input: NativeSessionStart, pin: CodexOriginalResidency): Runtime {
    this.assertSessionVersion(session)
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime) throw new HarnessExecutionError('CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The original stdio runtime is not resident; saved history cannot recover its process or callbacks.')
    this.assertOriginalBinding(runtime, session, input)
    if (!this.isOriginalResident(runtime) || pin.session.harness !== session.harness
      || pin.session.providerVersion !== session.providerVersion || pin.session.nativeSessionId !== session.nativeSessionId
      || pin.connectionId !== runtime.connectionId || pin.runtimeGeneration !== runtime.generation
      || pin.nativeTurnId !== runtime.activeTurnId) {
      throw new HarnessExecutionError('CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The original connection, generation or admitted turn is no longer current.')
    }
    return runtime
  }

  async attachSession(session: NativeSessionReference, source: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    this.assertSessionVersion(session)
    if (this.locks.has(session.nativeSessionId)) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
    }
    return this.exclusive(session.nativeSessionId, async () => {
      const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source)
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
      const detached = this.processRecovery && hasDetachedStdioProcess(this.processRecovery)
      const prepared = detached
        ? await this.dependencies.withDiagnostics({ binary: this.binary, cwd: sessionStartDirectory(input),
          configurationIdentity: canonical(configuration(input)),
          scopedCredentialVariables: Object.keys(input.environment?.variables ?? {}),
          ...(signal ? { signal } : {}) }, io => this.prepareInput(input, signal, io))
        : await this.prepareInput(input, signal)
      if (advanced(prepared.harnessConfiguration).sessionPersistence === 'ephemeral') {
        throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'Ephemeral sessions cannot be resumed after their process exits.')
      }
      const candidate = await this.transport(prepared, 0, signal)
      let attachedRuntime: Runtime | undefined
      try {
        const response = candidate.transport.reattached?.()
          ? object(await candidate.transport.request('thread/read', {
            threadId: session.nativeSessionId, includeTurns: false,
          }, signal), 'CODEX_THREAD_READ_INVALID')
          : object(await candidate.transport.request('thread/resume', {
            ...threadParameters(prepared, Boolean(this.chatFiles)), threadId: session.nativeSessionId, excludeTurns: true,
          }, signal), 'CODEX_THREAD_RESUME_INVALID')
        const settings = candidate.transport.reattached?.()
          ? candidate.transport.retainedThreadSettings?.(session.nativeSessionId) : response
        if (!settings) throw new HarnessExecutionError('CODEX_EFFECTIVE_SETTINGS_MISMATCH',
          'The original daemon has no accepted thread settings.')
        this.validateThreadResponse(prepared, { ...settings, thread: response.thread }, session.nativeSessionId)
        const runtime = this.runtime(prepared, structuredClone(session), candidate.transport, true)
        attachedRuntime = runtime
        const rejected = input.correlationId && this.responseJournal?.readTurnRejection(session, input.correlationId)
        if (!rejected) {
          await this.synchronize(runtime, candidate.transport.reattached?.() ? input.correlationId : undefined, signal)
        }
        if (candidate.transport.reattached?.()) await this.restoreNativeOutputTurn(runtime, signal)
        await candidate.activate(runtime)
        this.runtimes.set(session.nativeSessionId, runtime)
        this.record(runtime, 'thread.attached', { threadId: session.nativeSessionId })
        return structuredClone(session)
      } catch (error) {
        if (attachedRuntime) attachedRuntime.disposed = true
        const restarting = candidate.transport.reattached?.() && signal?.reason instanceof DomainError
          && signal.reason.code === 'ENGINE_RESTART'
        const results = await Promise.allSettled([
          attachedRuntime ? this.finishTurnResources(attachedRuntime) : Promise.resolve(),
          restarting ? candidate.transport.detachForRestart!() : candidate.transport.close(),
        ])
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) {
          throw new AggregateError([error, ...failures], 'Native attachment cleanup is unconfirmed.', { cause: error })
        }
        throw error
      }
    })
  }

  async configureSessionPreferences(preferences: SessionPreferences) {
    if (this.runtimes.size) throw new HarnessExecutionError('CODEX_SETTINGS_BUSY', 'Startup settings require an idle new allocation.')
    this.startupPreferences = SessionPreferencesSchema.parse(preferences)
  }

  async applySessionPreferences(session: NativeSessionReference, preferences: SessionPreferences, signal?: AbortSignal) {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      const capabilities = await this.sessionControlCapabilities(session)
      if (preferences.contextBudget !== null && !capabilities.contextBudgets.includes(preferences.contextBudget)) {
        throw new HarnessExecutionError('CODEX_CONTEXT_BUDGET_INVALID', 'Choose a qualified native context budget.')
      }
      const start = { ...runtime.input, sessionPreferences: preferences }
      const prepared = await this.prepareIdleInput(runtime, start, signal)
      const response = object(await runtime.transport.request('thread/resume', {
        ...threadParameters(prepared, true), threadId: session.nativeSessionId, excludeTurns: true,
      }, signal), 'CODEX_THREAD_RESUME_INVALID')
      this.validateThreadResponse(prepared, response, session.nativeSessionId)
      runtime.input = start
      runtime.sessionPreferences = structuredClone(preferences)
      if (runtime.context) runtime.context = { ...runtime.context, stale: true }
    })
  }

  appliedSessionPreferences(session: NativeSessionReference): SessionPreferences | null {
    const runtime = this.requireRuntime(session)
    // Native thread startup/resume acknowledges configuration; usable context can include a provider reserve.
    return runtime.sessionPreferences ?? runtime.input.sessionPreferences ?? SessionPreferencesSchema.parse({})
  }

  async sessionControlCapabilities(session: NativeSessionReference): Promise<SessionControlCapabilities> {
    const runtime = this.requireRuntime(session)
    const supports = (method: string, params: JsonObject) => {
      try { runtime.qualified.protocol.request({ id: 0, method, params }); return true } catch { return false }
    }
    const plan = supports('turn/start', { threadId: session.nativeSessionId, input: [],
      collaborationMode: codexCollaborationMode('plan', runtime.configuration.model, runtime.configuration.reasoningEffort) })
    const compact = supports('thread/compact/start', { threadId: session.nativeSessionId })
    const supportedBudget = supports('thread/resume', { threadId: session.nativeSessionId, config: { model_context_window: 100000 } })
    const capacity = runtime.contextBudgetLimit
      ?? (runtime.input.sessionPreferences?.contextBudget == null ? runtime.context?.capacityTokens ?? null : null)
    if (capacity !== null && runtime.input.sessionPreferences?.contextBudget == null) runtime.contextBudgetLimit = capacity
    const budgets = supportedBudget && capacity !== null
      ? [...new Set([Math.floor(capacity / 2), capacity])].filter(value => value > 0) : []
    const contextBudgetReason = !supportedBudget ? 'This qualified app-server schema has no per-thread context override.'
      : capacity === null ? 'A native default context-window observation is required before choosing a budget.' : null
    const unsupported = { supported: false, reason: 'This installed profile has no automatic-compaction toggle.' }
    return { compact: { supported: compact, reason: compact ? null : 'Native compaction is unavailable in this schema.' },
      plan: { supported: plan, reason: plan ? null : 'Native Plan mode is unavailable in this schema.' },
      autoCompact: unsupported, autoCompactBudget: unsupported, contextBudgetReason, contextBudgets: budgets, contextProfiles: [],
      modelCapacity: capacity, model: runtime.configuration.model, profileKey: createHash('sha256').update(runtime.configurationIdentity).digest('hex') }
  }

  contextSnapshot(session: NativeSessionReference): ContextSnapshot | null {
    // A Worker can read retained history after its provider runtime closed; no live context remains then.
    const loaded = this.runtimes.get(session.nativeSessionId) ?? this.childRuntimes.get(session.nativeSessionId)?.runtime
    if (!loaded || loaded.disposed) return null
    return this.requireRuntime(session).context ?? null
  }

  async compactSession(session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal): Promise<CompactionState> {
    return this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconnect before compacting.')
      const before = await codexRequest(runtime.transport, 'thread/read', { threadId: session.nativeSessionId, includeTurns: true }, signal)
      runtime.compactionPreviousTurns = new Set(before.thread.turns.map(turn => turn.id))
      runtime.compaction = { requestId: input.requestId, nativeSessionId: session.nativeSessionId,
        baselineTurnId: before.thread.turns.at(-1)?.id ?? null,
        nativeOperationId: null, status: 'accepted', message: 'Compaction is starting.',
        beforeTokens: runtime.context?.usedTokens ?? null, observedAt: new Date().toISOString() }
      let dispatched = false
      try {
        await input.onProgress(runtime.compaction)
        await input.onDispatch?.()
        dispatched = true
        await runtime.transport.request('thread/compact/start', { threadId: session.nativeSessionId }, signal)
        await input.onProgress(runtime.compaction)
        const waitSignal = AbortSignal.any([this.shutdownController.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
        while (['accepted', 'running'].includes(runtime.compaction.status) && !runtime.closed) {
          await this.wait(runtime, waitSignal)
          await input.onProgress(runtime.compaction)
        }
        if (runtime.closed) runtime.compaction = { ...runtime.compaction, status: 'uncertain', message: 'Reconnect to recover compaction.' }
        this.record(runtime, 'session.compaction', { ...runtime.compaction })
        return runtime.compaction
      } catch (error) {
        const definite = !dispatched || error instanceof CodexRpcError && error.method === 'thread/compact/start' && !error.uncertain
        runtime.compaction = { ...runtime.compaction, status: definite ? 'failed' : 'uncertain',
          message: definite ? 'Codex rejected compaction.' : 'Native compaction is unconfirmed.' }
        throw error
      }
    })
  }

  async readCompaction(session: NativeSessionReference, start: NativeSessionStart,
    state: CompactionState, signal?: AbortSignal): Promise<CompactionState> {
    this.assertSessionVersion(session)
    if (state.nativeSessionId !== session.nativeSessionId) return state
    const prepared = await this.prepareInput(start, signal)
    const candidate = await this.transport(prepared, 0, signal)
    try {
      const result = await codexRequest(candidate.transport, 'thread/read', {
        threadId: session.nativeSessionId, includeTurns: true,
      }, signal)
      if (result.thread.id !== session.nativeSessionId) throw new Error('Codex read a different native thread')
      return this.compactionFromTurns(state, result.thread.turns)
    } finally { await candidate.transport.close() }
  }

  async reconcileCompaction(session: NativeSessionReference, state: CompactionState, signal?: AbortSignal): Promise<CompactionState> {
    const runtime = this.requireRuntime(session)
    if (runtime.compaction?.requestId === state.requestId) {
      state = runtime.compaction
      if (!['accepted', 'running', 'uncertain'].includes(state.status)) return state
    }
    if (state.nativeSessionId !== session.nativeSessionId) return state
    const result = await codexRequest(runtime.transport, 'thread/read', { threadId: session.nativeSessionId, includeTurns: true }, signal)
    if (result.thread.id !== session.nativeSessionId) throw new Error('Codex read a different native thread')
    const recovered = this.compactionFromTurns(state, result.thread.turns)
    runtime.compaction = recovered
    if (recovered.status === 'completed' && runtime.context) runtime.context = { ...runtime.context, stale: true }
    return recovered
  }

  private compactionFromTurns(state: CompactionState,
    turns: Array<{ id: string; status: string; items: Array<{ type: string }> }>): CompactionState {
    let turn = turns.find(entry => entry.id === state.nativeOperationId)
    if (!turn && state.baselineTurnId !== undefined) {
      const baseline = state.baselineTurnId === null ? -1
        : turns.findIndex(entry => entry.id === state.baselineTurnId)
      const matches = baseline < 0 && state.baselineTurnId !== null ? [] : turns.slice(baseline + 1)
        .filter(entry => entry.items.some(item => item.type === 'contextCompaction'))
      if (matches.length === 1) turn = matches[0]
    }
    if (!turn) return state
    return codexCompactionNotification({ ...state, nativeOperationId: turn.id }, 'turn/completed', {
      threadId: state.nativeSessionId, turn,
    })
  }

  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const subscriber = new AbortController()
    const iterator = this.streamTurn(session, input, signal, subscriber.signal)
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => iterator.next(),
          return: async () => { subscriber.abort(); return iterator.return() },
          throw: async (error: unknown) => { subscriber.abort(); return iterator.throw(error) },
        }
      },
    }
  }

  private async *streamTurn(session: NativeSessionReference, input: NativeTurnInput, signal: AbortSignal | undefined,
    subscriberSignal: AbortSignal): AsyncGenerator<NativeHarnessEvent, void> {
    let runtime: Runtime
    try {
      runtime = this.requireRuntime(session)
    } catch (error) {
      throw new NativeDeliveryError('turn_submission', 'not_sent', error)
    }
    if (runtime.capacityRetry) throw new NativeDeliveryError('turn_submission', 'not_sent',
      new HarnessExecutionError('CODEX_TURN_ACTIVE', 'This session is waiting for model capacity.'))
    const retry: NonNullable<Runtime['capacityRetry']> = {
      attempt: 1, canAdvanceIdentity: !input.onSubmitted || Boolean(input.onRetry), controller: new AbortController(),
    }
    runtime.capacityRetry = retry
    const retrySignal = AbortSignal.any([retry.controller.signal, subscriberSignal,
      this.shutdownController.signal, ...(signal ? [signal] : [])])
    const attemptSignal = AbortSignal.any([retry.controller.signal, ...(signal ? [signal] : [])])
    try {
      for (;;) {
        yield* this.streamTurnAttempt(session, input, attemptSignal, subscriberSignal)
        if (!retry.failure || retrySignal.aborted || runtime.closed) return
        await this.finishTurnResources(runtime)
        const turnId = runtime.activeTurnId!
        const delayMs = codexCapacityDelay(retry.attempt)
        this.record(runtime, 'turn.capacity_wait', {
          threadId: session.nativeSessionId, turnId, attempt: retry.attempt, delayMs,
        })
        yield structuredClone(runtime.events.at(-1)!)
        await waitForCodexCapacity(delayMs, retrySignal, this.dependencies)
        retrySignal.throwIfAborted()
        await input.onRetry?.(turnId)
        retrySignal.throwIfAborted()
        this.record(runtime, 'turn.capacity_retry', { threadId: session.nativeSessionId, turnId })
        yield structuredClone(runtime.events.at(-1)!)
        retrySignal.throwIfAborted()
        retry.attempt += 1
        delete retry.failure
      }
    } catch (error) {
      if (!retrySignal.aborted || error !== retrySignal.reason) throw error
      if (!signal?.aborted && !subscriberSignal.aborted) {
        runtime.terminalResult = { outcome: 'canceled' }
        this.record(runtime, 'turn.retry_canceled', { threadId: session.nativeSessionId, turnId: runtime.activeTurnId })
        yield structuredClone(runtime.events.at(-1)!)
      }
    } finally {
      delete runtime.capacityRetry
    }
  }

  private async *streamTurnAttempt(session: NativeSessionReference, input: NativeTurnInput,
    signal: AbortSignal | undefined, subscriberSignal: AbortSignal): AsyncGenerator<NativeHarnessEvent, void> {
    let runtime: Runtime
    try {
      runtime = this.requireRuntime(session)
      signal?.throwIfAborted()
      if (this.locks.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
      if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconcile the disconnected session before starting another turn.')
      if (runtime.compaction && ['accepted', 'running', 'uncertain'].includes(runtime.compaction.status)) {
        throw new HarnessExecutionError('CODEX_COMPACT_PENDING', 'Recover native compaction before sending another turn.')
      }
      if (runtime.phase !== 'idle' || runtime.streamActive || runtime.interactions.size > 0) {
        throw new HarnessExecutionError('CODEX_TURN_ACTIVE', 'This session has an active or uncertain turn or interaction.')
      }
      if (input.sessionPreferences && canonical(input.sessionPreferences) !== canonical(runtime.sessionPreferences ?? runtime.input.sessionPreferences ?? SessionPreferencesSchema.parse({}))) {
        await this.applySessionPreferences(session, input.sessionPreferences, signal)
      }
      if (!input.clientCorrelationId.trim()) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Turn startup requires a stable correlation ID.')
    } catch (error) {
      throw new NativeDeliveryError('turn_submission', 'not_sent', error)
    }
    let resolveIdentity!: StartingTurn['resolveIdentity']
    const nativeIdentity = new Promise<string | undefined>((resolve) => { resolveIdentity = resolve })
    const starting: StartingTurn = {
      correlationId: input.clientCorrelationId, previous: snapshot(runtime), cancelRequested: false,
      preparationController: new AbortController(),
      ...(input.onSubmitted ? { onSubmitted: input.onSubmitted } : {}),
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
      const restarting = signal?.reason instanceof DomainError && signal.reason.code === 'ENGINE_RESTART'
      if (!restarting) starting.cancelRequested = true
      starting.preparationController.abort(signal?.reason)
      void this.finishTurnResources(runtime).catch(() => undefined)
      if (!restarting && runtime.activeTurnId && !runtime.terminalResult) void this.interrupt(runtime).catch(() => undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    let cursor = runtime.sequence
    let nativeSubmissionAttempted = false
    let operationFailure: Error | undefined
    let cleaningUp = false
    try {
      try {
        await this.finishTurnResources(runtime)
        runtime.files = undefined
        runtime.fileCleanup = undefined
        runtime.nativeOutput = undefined
        runtime.nativeOutputCleanup = undefined
        runtime.fileRequests.clear()
        const preparationSignal = AbortSignal.any([starting.preparationController.signal, this.shutdownController.signal, subscriberSignal, ...(signal ? [signal] : [])])
        preparationSignal.throwIfAborted()
        if (isWorkflowStart(runtime.input) && this.appMcpAccess === 'scoped') {
          await requireCodexAppMcp(runtime.transport, session.nativeSessionId,
            runtime.approvedAppMcpServerName ?? this.appMcpServerName, preparationSignal)
        }
        if (this.chatFiles) {
          starting.filePreparation = this.chatFiles.prepare({ session: structuredClone(session),
            clientCorrelationId: input.clientCorrelationId, signal: preparationSignal }).then(async (bridge) => {
            if (!bridge) return undefined
            const files = new CodexRuntimeFileTurn(bridge, session.nativeSessionId)
            runtime.files = files
            if (runtime.disposed || runtime.closed || starting.cancelRequested || preparationSignal.aborted) {
              await files.close()
              throw new HarnessExecutionError('CODEX_FILE_TURN_CLOSED', 'File preparation was canceled before native submission.')
            }
            if (!starting.onSubmitted) {
              await files.close()
              throw new HarnessExecutionError('CODEX_FILE_RECEIPT_REQUIRED', 'File turns require durable native identity persistence.')
            }
            if (bridge.allowedTools().some((tool) => !codexChatFileTools(runtime.configuration).includes(tool))) {
              await files.close()
              throw new HarnessExecutionError('CODEX_FILE_POLICY_MISMATCH', 'File admission exceeds this chat harness policy.')
            }
            return files
          }, (error: unknown) => {
            if (error instanceof CodexFilePreparationCleanupError) {
              runtime.files = new CodexRuntimeFileTurn(error.turn, session.nativeSessionId)
            }
            throw error
          })
        }
        preparationSignal.throwIfAborted()
        if (this.nativeOutputs) {
          if (!starting.onSubmitted || !runtime.effectiveSandbox) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_ADMISSION_REQUIRED', 'Native outputs require measured policy and durable turn admission.')
          starting.nativeOutputPreparation = this.nativeOutputs.prepare({
            ...this.nativeOutputQualification(runtime.configuration, runtime.qualified, runtime.workingDirectory, runtime.effectiveSandbox.tmpdir),
            effectiveSandbox: structuredClone(runtime.effectiveSandbox), session: structuredClone(session),
            clientCorrelationId: input.clientCorrelationId, connectionId: runtime.connectionId, runtimeGeneration: runtime.generation,
          }, preparationSignal).then(async (bridge) => {
            const output = new CodexRuntimeNativeOutputTurn(bridge)
            runtime.nativeOutput = output
            if (runtime.closed || runtime.disposed || starting.cancelRequested || preparationSignal.aborted) {
              await output.close(); throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Native output preparation was withdrawn.')
            }
            return output
          })
          await starting.nativeOutputPreparation
        }
        const preparedFiles = await starting.filePreparation
        const nativeInput = preparedFiles ? await preparedFiles.bridge.nativeInput(input.prompt)
          : [{ type: 'text' as const, text: input.prompt, text_elements: [] }]
        preparationSignal.throwIfAborted()
        if (runtime.disposed || runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The session closed during file preparation.')
        runtime.rejectedStarts.delete(starting.correlationId)
        if (this.responseJournal) {
          starting.nativeAttemptId = this.responseJournal.beginTurnAttempt(session, starting.correlationId)
        }
        nativeSubmissionAttempted = true
        runtimeTimingPoint('harness', 'native.submit', { nativeSessionId: session.nativeSessionId })
        const result = await codexRequest(runtime.transport, 'turn/start', {
          threadId: session.nativeSessionId, clientUserMessageId: input.clientCorrelationId,
          input: nativeInput,
          ...(input.sessionMode ? { collaborationMode: codexCollaborationMode(input.sessionMode, runtime.configuration.model, runtime.configuration.reasoningEffort) } : {}),
          serviceTierForTurn: runtime.configuration.serviceTier === 'priority' ? 'fast' : 'default',
        }, AbortSignal.any([subscriberSignal, ...(signal ? [signal] : [])]), (value, error) => {
          if (runtime.starting !== starting || runtime.disposed) return
          if (error instanceof CodexRpcError && !error.uncertain) this.rejectStartedTurn(runtime, starting)
          else if (error) runtime.phase = 'uncertain'
          else void this.acceptStartedTurn(runtime, starting, value).catch(() => {
            runtime.phase = 'uncertain'
            this.record(runtime, 'turn.start_uncertain', { correlationId: starting.correlationId })
          })
        }).catch((error: unknown) => {
          const rejected = !starting.acknowledgedTurnId && !runtime.activeTurnId
            && error instanceof CodexRpcError && error.method === 'turn/start' && !error.uncertain
          if (rejected) nativeSubmissionAttempted = false
          if (runtime.starting === starting) {
            if (!rejected) {
              runtime.phase = 'uncertain'
              this.record(runtime, 'turn.start_uncertain', { correlationId: starting.correlationId })
            } else this.rejectStartedTurn(runtime, starting)
          }
          throw error
        })
        await this.acceptStartedTurn(runtime, starting, result)
        await input.onSettingsApplied?.()
        while (!signal?.aborted && !subscriberSignal.aborted) {
          const firstSequence = runtime.events[0]?.sequence ?? runtime.sequence
          if (cursor < firstSequence) throw new HarnessExecutionError('NATIVE_HISTORY_GAP', 'The in-memory event window was exceeded; reload durable history.')
          const available = runtime.events.filter((event) => event.sequence >= cursor)
          for (const event of available) { cursor = event.sequence + 1; yield structuredClone(event) }
          // The consumer can suspend at yield while more events (including terminal
          // events) arrive. Drain them before returning or registering a waiter.
          if (runtime.events.some((event) => event.sequence >= cursor)) continue
          if (runtime.terminalResult || runtime.closed) { await this.finishTurnResources(runtime); return }
          await this.wait(runtime, AbortSignal.any([subscriberSignal, ...(signal ? [signal] : [])]))
        }
      } catch (error) {
        if (!nativeSubmissionAttempted) this.restoreRejectedStart(runtime, starting)
        if (!subscriberSignal.aborted) {
          const restart = signal?.reason instanceof DomainError && signal.reason.code === 'ENGINE_RESTART'
          operationFailure = restart ? signal.reason
            : new NativeDeliveryError('turn_submission', nativeSubmissionAttempted ? 'unknown' : 'not_sent', error)
          throw operationFailure
        }
      } finally {
        if (!nativeSubmissionAttempted || signal?.aborted || subscriberSignal.aborted || runtime.closed || runtime.terminalResult) {
          cleaningUp = true
          await this.finishTurnResources(runtime)
          cleaningUp = false
        }
      }
    } catch (error) {
      if (!cleaningUp) throw error
      const cause = operationFailure
        ? new AggregateError([operationFailure, error], 'Native turn failed and resource cleanup is unconfirmed.', { cause: error })
        : error
      throw new NativeDeliveryError('turn_submission', nativeSubmissionAttempted ? 'unknown' : 'not_sent', cause, 'pending')
    } finally {
      signal?.removeEventListener('abort', abort)
      runtime.streamActive = false
    }
  }

  async steerTurn(session: NativeSessionReference, input: NativeSteerInput, signal?: AbortSignal): Promise<{ nativeTurnId: string }> {
    const runtime = this.requireRuntime(session)
    signal?.throwIfAborted()
    if (runtime.closed || runtime.disposed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconcile the disconnected session before steering.')
    if (!input.clientCorrelationId.trim()) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Steering requires a stable correlation ID.')
    if (!runtime.activeTurnId || runtime.terminalResult || runtime.activeTurnId !== input.expectedTurnId) throw new NativeTurnNotActiveError()
    let result: unknown
    try {
      result = await codexRequest(runtime.transport, 'turn/steer', {
        threadId: session.nativeSessionId, expectedTurnId: input.expectedTurnId, clientUserMessageId: input.clientCorrelationId,
        input: [{ type: 'text' as const, text: input.prompt, text_elements: [] }],
      }, signal)
    } catch (error) {
      // Codex enforces expectedTurnId. A definite RPC rejection accepted no input.
      if (error instanceof CodexRpcError && !error.uncertain) throw new NativeTurnNotActiveError(`Codex rejected the steer: ${error.nativeMessage ?? error.message}`)
      throw error
    }
    const turnId = object(result, 'CODEX_TURN_STEER_INVALID').turnId
    if (!text(turnId)) throw new HarnessExecutionError('CODEX_TURN_STEER_INVALID', 'Codex accepted the steer without a turn identity.')
    this.record(runtime, 'turn.steered', { turnId, correlationId: input.clientCorrelationId })
    return { nativeTurnId: String(turnId) }
  }

  /** Inspect persisted user-message identities without synchronizing/retargeting the live owner. */
  async reconcileSteers(session: NativeSessionReference,
    inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[],
    signal?: AbortSignal): Promise<readonly NativeSteerReceipt[]> {
    signal = AbortSignal.any([this.shutdownController.signal, signal ?? AbortSignal.timeout(RESPONSE_DEADLINE_MS)])
    return this.exclusive(session.nativeSessionId, async () => {
      signal.throwIfAborted()
      const runtime = this.requireRuntime(session)
      if (!inputs.length) return []
      if (runtime.closed) await this.restart(runtime, signal)
      const response = object(await runtime.transport.request('thread/read', {
        threadId: session.nativeSessionId, includeTurns: false,
      }, signal), 'CODEX_THREAD_READ_INVALID')
      if (object(response.thread, 'CODEX_THREAD_READ_INVALID').id !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Steer reconciliation returned another thread.')
      }
      const wanted = new Map(inputs.map((input) => [input.clientCorrelationId, input.expectedTurnId]))
      const found = new Map<string, NativeSteerReceipt>()
      const seen = new Map<string, string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        signal.throwIfAborted()
        const page = await listCodexTurns(runtime.transport, {
          threadId: session.nativeSessionId, limit: 50, sortDirection: 'desc', itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        }, signal) ?? { data: [] }
        if (!Array.isArray(page.data)) throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'Codex returned an invalid turn page.')
        for (const turn of page.data.filter(isObject)) {
          const nativeTurnId = text(turn.id)
          if (!nativeTurnId || turn.itemsView !== 'full' || !Array.isArray(turn.items)) continue
          for (const item of turn.items.filter(isObject)) {
            const correlationId = text(item.clientId)
            if (item.type !== 'userMessage' || !correlationId || !wanted.has(correlationId)) continue
            if (seen.has(correlationId) && seen.get(correlationId) !== nativeTurnId) {
              throw new HarnessExecutionError('CODEX_CORRELATION_AMBIGUOUS', 'More than one native turn has this steering correlation.')
            }
            seen.set(correlationId, nativeTurnId)
            if (wanted.get(correlationId) === nativeTurnId) {
              found.set(correlationId, { nativeSessionId: session.nativeSessionId, nativeTurnId, correlationId })
            }
          }
        }
        cursor = text(page.nextCursor)
        if (cursor && cursors.has(cursor)) throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'Codex repeated a history cursor.')
        if (cursor) cursors.add(cursor)
      } while (cursor && found.size < wanted.size)
      return [...found.values()]
    })
  }

  /** `thread/fork` copies the source history into a new thread; the source thread is never written. */
  async forkSession(source: NativeSessionReference, value: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    return this.beginCreation(value, { forkSource: source, signal })
  }

  async pending(session: NativeSessionReference): Promise<PendingNativeInteraction | undefined> {
    const first = [...this.requireRuntime(session).interactions.values()].find((entry) => entry.delivery === 'pending')
    return first ? structuredClone(first.pending) : undefined
  }

  /** Inspects only this manager's current exact native callback; never reconstructs one from history. */
  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
    signal?: AbortSignal): Promise<NativeResponseAvailability> {
    signal?.throwIfAborted()
    const unavailable = (reason: NativeResponseAvailability['reason']) => unavailableNativeResponse(session, query, reason)
    if (this.shutdownController.signal.aborted) return unavailable('session_closed')
    if (session.harness !== 'codex') return unavailable('unqualified')
    const child = this.childRuntimes.get(session.nativeSessionId)
    try { child?.assertCurrent() } catch { return unavailable('session_closed') }
    const runtime = this.runtimes.get(session.nativeSessionId) ?? child?.runtime
    if (!runtime) return unavailable('callback_lost')
    if (runtime.session.providerVersion !== session.providerVersion) return unavailable('identity_mismatch')
    if (runtime.closed || runtime.disposed) return unavailable('session_closed')
    const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === query.nativeRequestId)
    if (!waiting) {
      const consumed = [...runtime.resolvedRequests.values()].find((entry) => entry.nativeRequestId === query.nativeRequestId)
      if (consumed && (consumed.method !== query.nativeRequestType
        || query.expectedNativeTurnId !== undefined && consumed.nativeTurnId !== query.expectedNativeTurnId)) return unavailable('identity_mismatch')
      return unavailable(consumed ? 'request_consumed' : 'callback_lost')
    }
    const turnId = waiting.pending.turn.nativeTurnId
    if (waiting.method !== query.nativeRequestType || waiting.pending.nativeRequestType !== query.nativeRequestType
      || waiting.pending.session.harness !== session.harness || waiting.pending.session.nativeSessionId !== session.nativeSessionId || waiting.pending.session.providerVersion !== session.providerVersion
      || query.expectedNativeTurnId !== undefined && turnId !== query.expectedNativeTurnId) return unavailable('identity_mismatch')
    if (waiting.generation !== runtime.generation || waiting.transport !== runtime.transport
      || runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) !== waiting) {
      return { ...unavailable('callback_lost'), state: 'recovery_required' }
    }
    if (waiting.conflictingIdentity) return { ...unavailable('identity_mismatch'), state: 'recovery_required' }
    const standalone = isSessionNativeInteraction(waiting.pending)
    if (!standalone && (!turnId || turnId !== runtime.activeTurnId || runtime.terminalResult)) return unavailable('identity_mismatch')
    if ((!standalone && runtime.phase !== 'active') || runtime.starting
      || !runtime.qualified.schemaManifestSha256) return unavailable('unqualified')
    if (!this.transports.has(runtime.transport) || runtime.transport.isConnected?.() !== true) return unavailable('callback_lost')
    const current = { ...unavailable('callback_lost'), ...(turnId ? { nativeTurnId: turnId } : {}),
      generation: `${runtime.connectionId}:${runtime.generation}`, qualified: true }
    if (waiting.delivery !== 'pending') return { ...current, state: 'recovery_required', reason: 'response_in_flight' }
    return { ...current, state: 'available', path: 'live_callback', reason: 'live_callback' }
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    const runtime = this.requireRuntime(session)
    if (this.locks.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
    const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === nativeRequestId)
    if (!waiting) throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The addressed native request is not pending in this session.')
    const stored = waiting.responses.get(option.optionId)
    if (!stored) throw new HarnessExecutionError('NATIVE_RESPONSE_OPTION_INVALID', 'The selected response was not offered for this native request.')
    if (waiting.delivery !== 'pending' || waiting.conflictingIdentity || waiting.generation !== runtime.generation || waiting.transport !== runtime.transport || runtime.closed) {
      throw new HarnessExecutionError('NATIVE_RESPONSE_RECONCILIATION_REQUIRED', 'A submitted, disconnected, or uncertain native response cannot be retransmitted.')
    }
    signal?.throwIfAborted()
    const nativeResponse = resolveCodexInteractionResponse(stored, option)
    // Synchronous reservation prevents two competing responses from both writing.
    waiting.delivery = 'submitting'
    waiting.selectedOptionId = stored.option.optionId
    runtime.responseDecisions.set(nativeRequestId, { pending: waiting.pending, option, nativeResponse,
      sequence: runtime.sequence })
    this.record(runtime, 'interaction.submitting', { nativeRequestId, optionId: option.optionId })
    try {
      await runtime.transport.respond(waiting.requestId, waiting.method, nativeResponse)
      this.record(runtime, 'interaction.submitted', { nativeRequestId, optionId: stored.option.optionId,
        semantic: stored.option.semantic, responseDigest: responseValueDigest(option.response) })
      if (runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) === waiting) {
        waiting.delivery = 'submitted'
      }
      const resolved = await deadline(waiting.resolution, signal, undefined, this.dependencies)
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
    // An explicit stale target cannot withdraw the newly preparing turn's files.
    if (nativeTurnId && nativeTurnId !== runtime.activeTurnId) return false
    if (runtime.capacityRetry?.failure) {
      runtime.capacityRetry.controller.abort()
      return true
    }
    if (runtime.starting) {
      runtime.starting.cancelRequested = true
      runtime.starting.preparationController.abort()
      void this.finishTurnResources(runtime).catch(() => undefined)
      const id = await deadline(runtime.starting.nativeIdentity, signal, undefined, this.dependencies)
      if (!id) return false
    }
    if (!runtime.activeTurnId || runtime.terminalResult || (nativeTurnId && nativeTurnId !== runtime.activeTurnId)) return false
    return deadline(this.interrupt(runtime), signal, undefined, this.dependencies)
  }

  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const runtime = this.requireRuntime(session)
    this.captureResponseDeliveries(runtime)
    const all = [...runtime.interactions.values()]
    const first = all.find((entry) => entry.delivery === 'pending')
    // Streamed frames are persisted individually. Observation proofs need a
    // smaller window so their combined JSON stays within graph traversal limits.
    let firstEvent = runtime.events.length
    let historyBytes = 0
    while (firstEvent > 0) {
      const size = runtime.eventSizes[firstEvent - 1]!
      if (historyBytes + size > MAX_HISTORY_BYTES && firstEvent < runtime.events.length) break
      historyBytes += size
      firstEvent -= 1
    }
    const events = runtime.events.slice(firstEvent)
    const terminalEvent = runtime.terminalResult ? runtime.events.findLast((event) => {
      if (event.type === 'turn.completed') return event.payload.turnId === runtime.activeTurnId
      const thread = event.payload.thread
      return event.type === 'thread.reconciled' && isObject(thread) && Array.isArray(thread.turns)
        && thread.turns.some((turn) => isObject(turn) && turn.id === runtime.activeTurnId)
    }) : undefined
    // Reconciliation can append metadata after a large original terminal read.
    // Keep that atomic provider frame even when transcript context rolls out.
    if (terminalEvent && !events.includes(terminalEvent)) events.unshift(terminalEvent)
    const gapStart = terminalEvent && terminalEvent.sequence < (runtime.events[firstEvent]?.sequence ?? runtime.sequence)
      ? terminalEvent.sequence + 1 : undefined
    return structuredClone({
      events,
      ...(gapStart !== undefined && gapStart < runtime.events[firstEvent]!.sequence
        ? { gap: { fromSequence: gapStart, toSequence: runtime.events[firstEvent]!.sequence - 1,
          reason: 'retention' as const } } : {}),
      pendingInteractions: all.map((entry) => entry.pending),
      ...(first?.delivery === 'pending' ? { pendingInteraction: first.pending } : {}),
      ...(runtime.terminalResult && !runtime.capacityRetry?.failure ? { terminalResult: runtime.terminalResult } : {}),
      ...((runtime.finalAnswer !== undefined ? runtime.finalAnswerId : runtime.lastAgentMessageId)
        ? { nativeMessageId: runtime.finalAnswer !== undefined ? runtime.finalAnswerId! : runtime.lastAgentMessageId! } : {}),
      firstRetainedSequence: events[0]?.sequence ?? runtime.sequence,
      nextSequence: runtime.sequence,
      interactionDeliveries: all.map((entry) => ({
        nativeRequestId: entry.pending.turn.nativeRequestId!, state: entry.delivery,
        ...(entry.selectedOptionId ? { selectedOptionId: entry.selectedOptionId } : {}),
      })),
      responseDeliveries: [...runtime.responseDeliveries.values()],
    })
  }

  async subagentHistory(session: NativeSessionReference, cursor?: string, signal?: AbortSignal) {
    return this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      const transport = runtime.transport, generation = runtime.generation
      const current = () => {
        signal?.throwIfAborted()
        if (runtime.closed || runtime.disposed || runtime.transport !== transport || runtime.generation !== generation || transport.isConnected?.() !== true) {
          throw new DomainError('SUBAGENT_HISTORY_OWNER_STALE', 'The exact parent history owner is not connected.', 409)
        }
      }
      current()
      const metadata = (value: unknown): JsonObject => isObject(value) ? value : {}
      const page = childHistoryCursor(session.nativeSessionId, cursor)
      if (page.target !== session.nativeSessionId) {
        let target = page.target
        const visited = new Set<string>()
        while (target !== session.nativeSessionId) {
          if (visited.has(target) || visited.size >= 32) throw new DomainError('SUBAGENT_ANCESTRY_INVALID', 'Native child ancestry does not reach the admitted parent.', 409)
          visited.add(target)
          const response = object(await transport.request('thread/read', { threadId: target, includeTurns: false }, signal))
          current()
          const thread = object(response.thread)
          const spawn = metadata(metadata(metadata(thread.source).subAgent).thread_spawn)
          if (thread.id !== target || !text(thread.parentThreadId) || spawn.parent_thread_id !== thread.parentThreadId || thread.ephemeral === true) {
            throw new DomainError('SUBAGENT_ANCESTRY_INVALID', 'Native history did not prove the exact durable child ancestry.', 409)
          }
          target = thread.parentThreadId as string
        }
      }
      const response = object(await transport.request('thread/items/list', { threadId: page.target, cursor: page.cursor, limit: 50, sortDirection: 'asc' }, signal))
      current()
      if (!Array.isArray(response.data) || response.data.length > 50) throw new DomainError('SUBAGENT_HISTORY_INVALID', 'Native child item page is not bounded.', 409)
      const events: NativeHarnessEvent[] = []
      for (const raw of response.data) {
        const entry = object(raw), item = object(entry.item)
        if (!text(item.id) || !text(entry.turnId)) continue
        const root = page.target === session.nativeSessionId
        if (root && !['subAgentActivity', 'collabAgentToolCall'].includes(String(item.type))) continue
        if (!root && !['subAgentActivity', 'collabAgentToolCall', 'agentMessage', 'userMessage', 'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(String(item.type))) continue
        const params = { threadId: page.target, turnId: entry.turnId, item }
        events.push(childHistoryEvent(root ? 'item.completed' : 'native.unlinked_notification', root ? params : { threadId: page.target, method: 'item/completed', params }))
      }
      const rootHistory = await this.history(session)
      const childIds = [...new Set([...(page.children ?? []), ...[...rootHistory.events, ...events].flatMap(event => {
        const payload = event.type === 'native.unlinked_notification' ? metadata(event.payload.params) : event.payload
        const item = metadata(payload.item)
        return item.type === 'subAgentActivity' && text(item.agentThreadId) ? [item.agentThreadId as string]
          : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => Boolean(text(id))) : []
      })])].filter(id => id !== session.nativeSessionId).sort()
      if (response.nextCursor != null && !text(response.nextCursor)) throw new DomainError('SUBAGENT_HISTORY_INVALID', 'Native page cursor is invalid.', 409)
      const nextTarget = page.target === session.nativeSessionId ? childIds[0] : childIds.find(id => id > page.target)
      return { events, nextCursor: response.nextCursor ? encodeChildHistoryCursor({ ...page, children: childIds, cursor: response.nextCursor as string })
        : nextTarget ? encodeChildHistoryCursor({ root: page.root, target: nextTarget, children: childIds, cursor: null }) : null }
    })
  }

  subagentControl(child: RunSubagent, assertOwner: () => void): SubagentControlLease | undefined {
    const runtime = [...this.runtimes.values()].find((candidate) => {
      const input = candidate.input
      return input.kind !== 'operator' && input.kind !== 'agent-chat' && input.request.executionId === child.parentExecutionId
        && input.request.runId === child.runId && input.request.workspaceId === child.workspaceId
        && input.request.configuration.agentId === child.parentAgentId
    })
    if (!runtime || runtime.closed || runtime.disposed || runtime.transport.isConnected?.() !== true) return undefined
    const transport = runtime.transport
    const generation = runtime.generation
    const current = () => {
      assertOwner()
      this.shutdownController.signal.throwIfAborted()
      if (this.runtimes.get(runtime.session.nativeSessionId) !== runtime || runtime.closed || runtime.disposed
        || runtime.transport !== transport || runtime.generation !== generation || transport.isConnected?.() !== true) {
        throw new HarnessExecutionError('SUBAGENT_OWNER_STALE', 'The admitted child control owner changed.')
      }
    }
    const lease = this.childControls.lease(child, {
      rootThreadId: runtime.session.nativeSessionId,
      generation: `${runtime.connectionId}:${generation}`,
      qualified: runtime.qualified,
      transport,
      assertCurrent: current,
      exclusive: (work) => this.exclusive(runtime.session.nativeSessionId, work),
      observeThread: thread => this.observeChildThread(runtime, child, thread, current),
      beginTurn: correlationId => this.beginChildTurn(child, correlationId, current),
    }, assertOwner)
    if (!lease) return undefined
    return { ...lease,
      pendingInteraction: () => {
        current()
        const owned = this.childRuntimes.get(child.native.childSessionId!)
        if (!owned || owned.runtime.parent !== runtime) return undefined
        return structuredClone([...owned.runtime.interactions.values()].find(entry => entry.delivery === 'pending')?.pending)
      },
      respond: receipt => this.exclusive(runtime.session.nativeSessionId, async () => {
        current()
        const response = receipt.response
        const owned = this.childRuntimes.get(child.native.childSessionId!)
        const pending = owned && [...owned.runtime.interactions.values()]
          .find(entry => entry.pending.turn.nativeRequestId === response?.nativeRequestId)?.pending
        if (!response || !owned || owned.runtime.parent !== runtime
          || receipt.operation !== 'run_subagent_respond_v1' || receipt.subagentId !== child.id
          || receipt.runId !== child.runId || receipt.workspaceId !== child.workspaceId
          || !pending || pending.nativeRequestType !== response.nativeRequestType
          || (pending.turn.nativeTurnId ?? null) !== receipt.nativeTurnId) {
          throw new HarnessExecutionError('SUBAGENT_RESPONSE_STALE', 'The child request is no longer owned.')
        }
        await this.respond(owned.runtime.session, response.nativeRequestId, response.option)
        current()
      }),
      reconcile: async receipt => {
        if (!receipt.response) return lease.reconcile!(receipt)
        current()
        // Native ancestry readback requalifies the child even when only its response journal survives.
        await lease.reconcile!(receipt)
        const session = { ...runtime.session, nativeSessionId: child.native.childSessionId! }
        const history = await this.reconcileResponse(session, receipt.response)
        return history.responseDeliveries?.some(proof => proof.nativeRequestId === receipt.response!.nativeRequestId
          && proof.optionId === receipt.response!.option.optionId) ? 'acknowledged' : 'uncertain'
      },
    }
  }

  private observeChildThread(parent: Runtime, child: RunSubagent, thread: import('./codexMethodTypes.js').Thread,
    assertCurrent: () => void): void {
    assertCurrent()
    const previous = this.childRuntimes.get(thread.id)
    if (previous && previous.runtime.parent === parent && previous.runtime.generation === parent.generation) {
      previous.assertCurrent = assertCurrent
      return
    }
    const runtime: Runtime = { ...parent, parent, session: { ...parent.session, nativeSessionId: thread.id },
      starting: undefined, streamActive: false, activeTurnId: thread.turns.at(-1)?.id ?? child.native.currentTurnId,
      activeCorrelationId: undefined, terminalResult: undefined, phase: thread.status.type === 'active' ? 'active' : 'idle',
      finalAnswer: undefined, finalAnswerId: undefined, lastAgentMessage: undefined, lastAgentMessageId: undefined,
      files: undefined, fileCleanup: undefined, nativeOutput: undefined, nativeOutputCleanup: undefined,
      fileRequests: new Map(), interactions: new Map(), resolvedRequests: new Map(), callbackOwners: parent.callbackOwners,
      responseDecisions: new Map(), responseDeliveries: new Map(), rejectedStarts: new Map(), seenNotifications: new Set(),
      events: [], eventSizes: [], eventBytes: 0, sequence: 0, wake: new Set(), cancellation: undefined }
    delete runtime.context
    delete runtime.compaction
    delete runtime.compactionPreviousTurns
    this.childRuntimes.set(thread.id, { runtime, child, assertCurrent })
  }

  private beginChildTurn(child: RunSubagent, correlationId: string, assertCurrent: () => void) {
    assertCurrent()
    const runtime = this.childRuntimes.get(child.native.childSessionId!)!.runtime
    let resolveIdentity!: StartingTurn['resolveIdentity']
    const nativeIdentity = new Promise<string | undefined>(resolve => { resolveIdentity = resolve })
    const starting: StartingTurn = { correlationId, previous: snapshot(runtime), cancelRequested: false,
      preparationController: new AbortController(), nativeIdentity, resolveIdentity, staged: [], stagedBytes: 0 }
    runtime.starting = starting
    runtime.phase = 'starting'
    runtime.activeTurnId = undefined
    runtime.activeCorrelationId = correlationId
    runtime.terminalResult = undefined
    return { acknowledge: async (value: unknown) => {
      assertCurrent()
      await this.acceptStartedTurn(runtime, starting, value)
    }, reject: () => this.restoreRejectedStart(runtime, starting) }
  }

  async reconcileResponse(
    session: NativeSessionReference,
    response: import('./port.js').NativeResponseIdentity,
    signal?: AbortSignal,
  ): Promise<NativeHistory> {
    signal?.throwIfAborted()
    const durable = this.responseJournal?.read(session, response)
    if (durable && !this.runtimes.has(session.nativeSessionId) && !this.childRuntimes.has(session.nativeSessionId)) {
      return { events: [], pendingInteractions: [], responseDeliveries: [durable] }
    }
    const history = await this.history(session)
    if (durable) return { ...history, responseDeliveries: [...(history.responseDeliveries ?? []), durable] }
    if (history.responseDeliveries?.some(proof => proof.nativeRequestId === response.nativeRequestId)) return history
    const runtime = this.requireRuntime(session)
    const decision = runtime.responseDecisions.get(response.nativeRequestId)
    if (decision?.pending.nativeRequestType === 'mcpServer/elicitation/request' && !runtime.closed) {
      const transport = runtime.transport
      const generation = runtime.generation
      const { thread } = await codexRequest(transport, 'thread/read', {
        threadId: session.nativeSessionId, includeTurns: true,
      }, signal)
      if (this.requireRuntime(session) !== runtime || runtime.transport !== transport || runtime.generation !== generation
        || runtime.closed || thread.id !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The response readback owner changed.')
      }
      const latest = thread.turns.at(-1)
      this.record(runtime, 'interaction.readback', { nativeRequestId: response.nativeRequestId,
        threadId: thread.id, observedTurnId: latest?.id ?? null, observedTurnStatus: latest?.status ?? null })
      const observed = await this.history(session)
      if (observed.responseDeliveries?.some(proof => proof.nativeRequestId === response.nativeRequestId)) return observed
    }
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
      const rejected = runtime.rejectedStarts.get(correlationId)
        ?? this.responseJournal?.readTurnRejection(session, correlationId)
      if (rejected) return { ...await this.history(session), correlationId,
        nonSubmission: { nativeSessionId: session.nativeSessionId, clientCorrelationId: correlationId,
          result: structuredClone(rejected) } }
      const observedTerminal = runtime.activeCorrelationId === correlationId
        && runtime.activeTurnId !== undefined && runtime.terminalResult !== undefined
      const restarted = runtime.closed && !observedTerminal
      if (restarted) await this.restart(runtime, signal)
      const locallyIdle = !runtime.attached && runtime.phase === 'idle' && runtime.activeCorrelationId === undefined
        && runtime.activeTurnId === undefined && runtime.interactions.size === 0
      if (!locallyIdle && !observedTerminal) await this.synchronize(runtime, correlationId, signal)
      const lateRejection = runtime.rejectedStarts.get(correlationId)
        ?? this.responseJournal?.readTurnRejection(session, correlationId)
      if (lateRejection) return { ...await this.history(session), correlationId,
        nonSubmission: { nativeSessionId: session.nativeSessionId, clientCorrelationId: correlationId,
          result: structuredClone(lateRejection) } }
      this.record(runtime, 'thread.reconciled', {
        correlationId, restarted, threadId: session.nativeSessionId,
        ...(runtime.activeTurnId ? { turnId: runtime.activeTurnId } : {}),
        terminal: runtime.terminalResult?.outcome ?? null,
      })
      const history = await this.history(session)
      return runtime.activeCorrelationId === correlationId && runtime.activeTurnId
        ? {
            ...history,
            correlationId,
            nativeTurnId: runtime.activeTurnId,
            ...(runtime.terminalResult && !runtime.capacityRetry?.failure ? {
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
      if (runtime.capacityRetry?.failure) runtime.capacityRetry.controller.abort()
      for (const [id, child] of this.childRuntimes) {
        if (child.runtime.parent !== runtime) continue
        child.runtime.closed = true
        child.runtime.disposed = true
        for (const waiting of child.runtime.interactions.values()) waiting.resolve('cleared')
        this.wake(child.runtime)
        this.childRuntimes.delete(id)
      }
      runtime.starting?.preparationController.abort()
      runtime.starting?.resolveIdentity(undefined)
      // Stop the process even when host cleanup or token revocation fails. Keep
      // ownership until BOTH cleanups succeed, so explicit disposal can retry.
      const fileCleanup = (async () => {
        await Promise.allSettled([runtime.starting?.filePreparation, runtime.starting?.nativeOutputPreparation])
        await this.finishTurnResources(runtime)
      })()
      for (const waiting of runtime.interactions.values()) waiting.resolve('cleared')
      this.wake(runtime)
      const outcomes = await Promise.allSettled([fileCleanup, runtime.transport.close()])
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      if (this.runtimes.get(session.nativeSessionId) === runtime) this.runtimes.delete(session.nativeSessionId)
      for (const [key, creation] of this.creations) if (creation.session?.nativeSessionId === session.nativeSessionId) this.creations.delete(key)
    })
  }

  async originalEnvironment(session: NativeSessionReference, signal?: AbortSignal) {
    this.assertSessionVersion(session)
    if (!this.processRecovery) return undefined
    return detachedStdioEnvironment(this.processRecovery, signal)
  }

  canDetachForRestart(session: NativeSessionReference): boolean {
    const runtime = this.runtimes.get(session.nativeSessionId)
    return !!this.processRecovery && process.platform === 'linux' && !!runtime
      && runtime.session.providerVersion === session.providerVersion && !runtime.closed && !runtime.disposed
      && runtime.activeTurnId !== undefined
      && advanced(runtime.configuration).sessionPersistence !== 'ephemeral'
      && runtime.transport.detachForRestart !== undefined
  }

  async closeForRestart(session: NativeSessionReference): Promise<void> {
    this.assertSessionVersion(session)
    const loaded = this.runtimes.get(session.nativeSessionId)
    if (!this.processRecovery || process.platform !== 'linux' || !loaded?.transport.detachForRestart
      || advanced(loaded.configuration).sessionPersistence === 'ephemeral') {
      await this.close(session)
      return
    }
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.runtimes.get(session.nativeSessionId)
      if (!runtime) return
      runtime.closed = true
      runtime.disposed = true
      runtime.starting?.preparationController.abort()
      await Promise.allSettled([runtime.starting?.filePreparation, runtime.starting?.nativeOutputPreparation])
      await this.finishTurnResources(runtime)
      await runtime.transport.detachForRestart!()
      this.transports.delete(runtime.transport)
      this.wake(runtime)
      this.runtimes.delete(session.nativeSessionId)
      for (const [id, child] of this.childRuntimes) {
        if (child.runtime.parent !== runtime) continue
        child.runtime.disposed = true
        this.wake(child.runtime)
        this.childRuntimes.delete(id)
      }
    })
  }

  async inspectMcp(signal?: AbortSignal): Promise<McpDetection> {
    const checkedAt = this.dependencies.now().toISOString()
    try {
      const value = await this.inspectMcpConfiguration(this.inspection.workingDirectory ?? process.cwd(), signal)
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: value.serverName,
        state: value.configured.enabled ? 'status_unavailable' : 'disabled',
        endpointMatches: value.configured.automaticEndpoint === true && value.configured.transport === 'stdio' ? true : null,
        credentialEnvironmentVariable: isSupportedAppMcpTokenName(value.configured.bearerTokenEnvironmentVariable ?? undefined)
          ? value.configured.bearerTokenEnvironmentVariable : null,
        checkedAt,
        detail: 'CLI inspection proves configuration only; inspectNativeMcp reports runtime status.',
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const notConfigured = error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_MCP_NOT_CONFIGURED'
      return McpDetectionSchema.parse({
        harness: 'codex', serverName: this.appMcpServerName, state: notConfigured ? 'not_detected' : 'check_failed',
        endpointMatches: null, credentialEnvironmentVariable: null, checkedAt,
        ...(error instanceof Error && error.name === 'TimeoutError'
          ? { detail: 'Native MCP inspection timed out. Retry after Codex finishes starting.' } : {}),
      })
    }
  }

  async inspectMcpConfiguration(cwd: string, signal?: AbortSignal): Promise<CodexMcpConfigurationInspection> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const environment = this.dependencies.environment()
    return timeRuntimeOperation('harness', 'native.inspect_mcp', async () => {
      const qualified = await this.dependencies.qualify(this.binary, cwd, environment, true, signal)
      return this.mcpConfiguration(qualified.binary, cwd, environment, qualified.providerVersion, signal)
    })
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
      if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reload requires a live native process.')
      const before = { generation: runtime.generation, transport: runtime.transport, closed: runtime.closed }
      // Revalidate policy/credentials before allowing a newly enabled MCP entry.
      const prepared = await this.prepareIdleInput(runtime, runtime.input, signal)
      this.assertIdleAfterDiagnostics(runtime, before, signal)
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
      const before = { generation: runtime.generation, transport: runtime.transport, closed: runtime.closed }
      const nextInput = { ...structuredClone(runtime.input), environment: structuredClone(environment) }
      // Validate through separately owned diagnostics while the idle process remains usable.
      const prepared = await this.prepareIdleInput(runtime, nextInput, signal)
      this.assertIdleAfterDiagnostics(runtime, before, signal)
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
      await this.dependencies.prepareEnvironment?.()
      const environment = this.dependencies.environment()
      const qualified = await this.dependencies.qualify(this.binary, process.cwd(), environment, false, signal)
      await this.dependencies.assertUnchanged(qualified)
      const transport = this.dependencies.transport(
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
        this.loginControl.timer = this.dependencies.schedule(() => { void this.closeLoginControl().catch(() => undefined) }, 15 * 60_000)
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
      this.dependencies.cancelTimer(creation.timer)
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
    this.dependencies.cancelTimer(control.timer)
    await control.transport.close()
    if (this.loginControl === control) this.loginControl = undefined
  }

  private assertSessionVersion(session: NativeSessionReference): void {
    if (session.harness !== 'codex') {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The session does not match this qualified Codex provider.')
    }
  }
  private requireRuntime(session: NativeSessionReference): Runtime {
    this.assertSessionVersion(session)
    const child = this.childRuntimes.get(session.nativeSessionId)
    child?.assertCurrent()
    const runtime = this.runtimes.get(session.nativeSessionId) ?? child?.runtime
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
    if (canonical(sessionStartSystemPrompt(runtime.input) ?? null)
      !== canonical(sessionStartSystemPrompt(input) ?? null)) {
      throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH',
        'The loaded session has a different accepted system prompt snapshot.')
    }
  }
  private assertIdle(runtime: Runtime): void {
    if (runtime.phase !== 'idle' || runtime.streamActive || runtime.interactions.size > 0) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'This operation requires an idle, fully reconciled session.')
    }
  }
  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(key)
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    this.lifecycleTails.set(key, tail)
    this.locks.add(key)
    try {
      await previous
      return await operation()
    } finally {
      if (this.lifecycleTails.get(key) === tail) {
        this.lifecycleTails.delete(key)
        this.locks.delete(key)
      }
      release()
    }
  }

  private async prepareIdleInput(runtime: Runtime, source: NativeSessionStart, signal?: AbortSignal): Promise<Prepared> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    this.assertBinding(runtime, source)
    return this.dependencies.withDiagnostics({
      binary: runtime.qualified.binary, ...(this.expectedVersion ? { expectedVersion: this.expectedVersion } : {}), cwd: runtime.workingDirectory,
      configurationIdentity: runtime.configurationIdentity, signal,
      scopedCredentialVariables: [...new Set([...APP_MCP_TOKEN_NAMES, ...Object.keys(source.environment?.variables ?? {}),
        ...(runtime.scopedCredentialVariable ? [runtime.scopedCredentialVariable] : []),
        ...(runtime.strippedCredentialVariable ? [runtime.strippedCredentialVariable] : [])])],
    }, async (io) => {
      await io.assertUnchanged(runtime.qualified)
      const prepared = await this.prepareInput(source, signal, io, runtime.qualified.binary)
      const pin = (value: QualifiedCodex) => canonical([value.binary, value.identity, value.providerVersion,
        value.schemaManifestSha256, value.stableSchemaGitBlob, value.referenceSchemaManifestSha256])
      if (pin(prepared.qualified) !== pin(runtime.qualified)) throw new HarnessExecutionError(
        'CODEX_SESSION_QUALIFICATION_MISMATCH', 'Idle inspection must retain the exact native executable and schema qualification.')
      await io.assertUnchanged(runtime.qualified)
      return prepared
    })
  }

  private assertIdleAfterDiagnostics(runtime: Runtime, before: Pick<Runtime, 'generation' | 'transport' | 'closed'>, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    this.shutdownController.signal.throwIfAborted()
    if (this.requireRuntime(runtime.session) !== runtime || runtime.generation !== before.generation
      || runtime.transport !== before.transport || runtime.closed !== before.closed) {
      throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The inspected native process changed before control dispatch.')
    }
    // A previously closed refresh can retry retained cleanup; a new disconnect
    // during inspection must never turn that inspection into a replacement.
    this.assertIdle(runtime)
  }

  private async prepareInput(source: NativeSessionStart, signal?: AbortSignal, io: CodexDiagnosticOperations = this.dependencies, binary = this.binary): Promise<Prepared> {
    await this.dependencies.prepareEnvironment?.()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source)
    validateEnvironmentOwner(input)
    validateEnvironmentVariables(input.environment)
    if (this.chatFiles && this.appMcpAccess === 'scoped' && input.kind !== 'operator') {
      throw new HarnessExecutionError('CODEX_FILE_CHAT_ISOLATION_REQUIRED',
        'Only Operator chat can combine file tools with application management credentials.')
    }
    if (this.appMcpAccess === 'none' && Object.keys(input.environment?.variables ?? {}).length) {
      throw new HarnessExecutionError('CODEX_APP_MCP_UNAVAILABLE', 'Agent chat cannot receive scoped App MCP credentials.')
    }
    const workingDirectory = sessionStartDirectory(input)
    const harnessConfiguration = isWorkflowStart(input)
      ? await worktreeSecurity(configuration(input), workingDirectory, signal)
      : configuration(input)
    const environment = io.environment(input.environment)
    const qualified = await io.qualify(binary, workingDirectory, environment, true, signal)
    await this.validateMcpPolicies(harnessConfiguration, qualified.binary, workingDirectory, environment, signal, io)
    let scopedCredentialVariable: string | undefined
    let excludedCredentialVariable: string | undefined
    let disabledMcpServerNames: readonly string[] = []
    let mcpTransportOverrides: Record<string, string> = {}
    let approvedAppMcpServerName: string | undefined
    const nativeTools = accepted(input).nativeTools
    const nativeApps = nativeMcpServerAllowed('codex_apps', nativeTools) ? nativeTools?.apps : false
    if (this.appMcpAccess === 'none' || nativeTools?.mcpServers !== undefined || nativeTools?.apps === false) {
      const listed = await io.runCommand(qualified.binary, ['mcp', 'list', '--json'], workingDirectory, signal, environment)
      let entries: unknown
      try { entries = JSON.parse(listed.stdout) } catch { entries = undefined }
      if (listed.exitCode !== 0 || !Array.isArray(entries) || entries.length > 500
        || !entries.every((entry: unknown) => isObject(entry) && typeof entry.name === 'string')) {
        throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED', 'Codex MCP configuration inspection failed; absence was not established.')
      }
      const configuredNames = entries.map((entry: JsonObject) => String(entry.name))
      const chatExcluded = this.appMcpAccess === 'none' ? chatExcludedAppMcpServerNames(this.appMcpServerName) : []
      disabledMcpServerNames = configuredNames.filter(name => chatExcluded.includes(name)
        || !nativeMcpServerAllowed(name, nativeTools))
      mcpTransportOverrides = codexDisabledMcpTransports(entries, disabledMcpServerNames)
    }
    try {
      const mcp = await this.mcpConfiguration(qualified.binary, workingDirectory, environment, qualified.providerVersion, signal, io)
      excludedCredentialVariable = mcp.configured.bearerTokenEnvironmentVariable ?? undefined
      if (this.appMcpAccess !== 'none' && mcp.configured.enabled) {
        scopedCredentialVariable = excludedCredentialVariable
        if (isWorkflowStart(input)) approvedAppMcpServerName = mcp.serverName
      }
    } catch (error) {
      if (!(error instanceof HarnessExecutionError) || error.result.error?.code !== 'CODEX_MCP_NOT_CONFIGURED') throw error
    }
    validateEnvironmentOwner(input, scopedCredentialVariable)
    const strippedCredentialVariable = this.appMcpAccess === 'none' ? excludedCredentialVariable : scopedCredentialVariable
    const scopedEnvironment = this.dependencies.environment(input.environment, strippedCredentialVariable ? [strippedCredentialVariable] : [])
    const modelFacts = await io.qualifyModel(harnessConfiguration, qualified.binary, workingDirectory,
      io.environment(input.environment, strippedCredentialVariable ? [strippedCredentialVariable] : []), signal,
      undefined, { qualified, assertUnchanged: io.assertUnchanged,
        runCommand: io.runCommand,
        transportFactory: (...args) => {
          args[9] = disabledMcpServerNames
          args[11] = { ...args[11], nativeApps, mcpTransportOverrides }
          return this.ownTransport(this.dependencies.transport(...args))
        } })
    if (this.nativeOutputs) {
      if (!isWorkflowStart(input) || this.appMcpAccess !== 'scoped' || harnessConfiguration.sandbox === 'read-only'
        || harnessConfiguration.sandbox === 'danger-full-access' && this.nativeOutputs.storageKind !== 'buffer') {
        throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_UNQUALIFIED', 'Native outputs require an original writable workflow, scoped App MCP and compatible output storage.')
      }
      codexNativeOutputDeclarations(harnessConfiguration, qualified.providerVersion, this.nativeOutputs)
      await this.nativeOutputs.assertQualified(this.nativeOutputQualification(harnessConfiguration, qualified, workingDirectory, scopedEnvironment.TMPDIR), signal)
      signal.throwIfAborted()
    }
    return { input, harnessConfiguration, workingDirectory, scopedCredentialVariable, strippedCredentialVariable, environment: scopedEnvironment, qualified,
      disabledMcpServerNames, mcpTransportOverrides, nativeApps,
      contextBudgetLimit: typeof modelFacts === 'object' ? modelFacts.contextWindow ?? undefined : undefined,
      ...(approvedAppMcpServerName ? { approvedAppMcpServerName } : {}),
    }
  }

  private async mcpConfiguration(binary: string, cwd: string, environment: NodeJS.ProcessEnv,
    providerVersion: string, signal?: AbortSignal, io: CodexDiagnosticOperations = this.dependencies): Promise<CodexMcpConfigurationInspection> {
    const candidates = isSupportedAppMcpServerName(this.appMcpServerName)
      ? APP_MCP_SERVER_NAMES : [this.appMcpServerName]
    const entries: Record<string, Awaited<ReturnType<typeof runCommand>>> = Object.create(null)
    for (const name of candidates) {
      const result = await io.runCommand(binary, ['mcp', 'get', name, '--json'], cwd, signal, environment)
      if (result.exitCode === 0) {
        entries[name] = result
        continue
      }
      // A failed command alone cannot prove absence: retain only the CLI's definite missing-entry reply.
      if (result.exitCode !== 1 || result.stdout.trim() !== ''
        || result.stderr.trim() !== `Error: No MCP server named '${name}' found.`) {
        throw new HarnessExecutionError('CODEX_MCP_INSPECTION_FAILED',
          'Codex could not establish the named MCP configuration.')
      }
    }
    const serverName = appMcpServerName(entries, this.appMcpServerName)
    const result = entries[serverName]
    if (!result) throw new HarnessExecutionError('CODEX_MCP_NOT_CONFIGURED', 'The named native MCP entry is absent.')
    try {
      const parsed = object(JSON.parse(result.stdout))
      const transport = isObject(parsed.transport) ? parsed.transport : {}
      const url = text(transport.url) ?? null
      return {
        providerVersion, binary, cwd, serverName, inspectionScope: 'effective_config',
        configured: {
          enabled: parsed.enabled !== false, required: parsed.required === true,
          transport: transport.type === 'streamable_http' || transport.type === 'stdio'
            ? transport.type : url ? 'streamable_http' : text(transport.command) ? 'stdio' : 'unknown',
          url, bearerTokenEnvironmentVariable: isAppLauncher(transport)
            ? appLauncherTokenName(transport) ?? null : text(transport.bearer_token_env_var) ?? null,
          automaticEndpoint: isSupportedAppMcpServerName(serverName) && isAppLauncher(transport),
          enabledTools: stringArray(parsed.enabled_tools) ?? null, disabledTools: stringArray(parsed.disabled_tools) ?? [],
          defaultToolsApprovalMode: text(parsed.default_tools_approval_mode) ?? null,
          tools: isObject(parsed.tools) ? parsed.tools : {},
        },
      }
    } catch { throw new HarnessExecutionError('CODEX_MCP_CONFIG_INVALID', 'Codex returned invalid structured MCP configuration.') }
  }

  private nativeOutputQualification(configuration: CodexHarnessConfiguration, qualified: QualifiedCodex,
    cwd: string, tmpdir: string | undefined): CodexNativeOutputQualificationInput {
    const draft = advanced(configuration)
    return { configuration: structuredClone(configuration), binary: qualified.binary, binaryIdentity: qualified.identity,
      providerVersion: qualified.providerVersion, schemaIdentity: qualified.schemaManifestSha256,
      expectedSandbox: { cwd, writableRoots: [...draft.additionalWritableDirectories], tmpdir,
        networkAccess: draft.workspaceWrite?.networkAccess ?? false,
        excludeTmpdirEnvVar: draft.workspaceWrite?.excludeTmpdirEnvVar ?? false,
        excludeSlashTmp: draft.workspaceWrite?.excludeSlashTmp ?? false } }
  }

  private async validateMcpPolicies(
    value: CodexHarnessConfiguration, binary: string, cwd: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal,
    io: CodexDiagnosticOperations = this.dependencies,
  ): Promise<void> {
    for (const [serverName, expected] of Object.entries(advanced(value).mcpServers)) {
      const result = await io.runCommand(binary, ['mcp', 'get', serverName, '--json'], cwd, signal, environment)
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

  private validateThreadResponse(prepared: Pick<Prepared, 'harnessConfiguration' | 'workingDirectory' | 'environment' | 'effectiveSandbox'>, response: JsonObject, expectedId?: string): JsonObject {
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
    if (value.sandbox === 'workspace-write') prepared.effectiveSandbox = {
      cwd: String(response.cwd), writableRoots: stringArray(sandbox.writableRoots) ?? [],
      networkAccess: sandbox.networkAccess === true, excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar === true,
      excludeSlashTmp: sandbox.excludeSlashTmp === true, tmpdir: prepared.environment.TMPDIR,
    }
    if (value.sandbox === 'danger-full-access' && this.nativeOutputs?.storageKind === 'buffer') {
      prepared.effectiveSandbox = { cwd: String(response.cwd), writableRoots: ['/'], networkAccess: true,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false, tmpdir: prepared.environment.TMPDIR }
    }
    return thread
  }

  private runtime(prepared: Prepared, session: NativeSessionReference, transport: CodexTransport, attached = false): Runtime {
    return {
      ...(prepared.contextBudgetLimit ? { contextBudgetLimit: prepared.contextBudgetLimit } : {}),
      connectionId: this.dependencies.id(), schemaIdentity: prepared.qualified.schemaManifestSha256, arrivalOrdinal: 0, attached,
      binding: binding(prepared.input), ownerId: ownerId(prepared.input), configurationIdentity: canonical(accepted(prepared.input)),
      input: prepared.input, workingDirectory: prepared.workingDirectory, configuration: prepared.harnessConfiguration,
      scopedCredentialVariable: prepared.scopedCredentialVariable, transport, session, generation: 0,
      approvedAppMcpServerName: prepared.approvedAppMcpServerName,
      strippedCredentialVariable: prepared.strippedCredentialVariable,
      qualified: { ...prepared.qualified },
      phase: 'idle', streamActive: false, starting: undefined, cancellation: undefined,
      files: undefined, fileCleanup: undefined, nativeOutput: undefined, nativeOutputCleanup: undefined,
      effectiveSandbox: prepared.effectiveSandbox ? structuredClone(prepared.effectiveSandbox) : undefined, fileRequests: new Map(),
      activeTurnId: undefined, activeCorrelationId: undefined, terminalResult: undefined, finalAnswer: undefined, lastAgentMessage: undefined,
      finalAnswerId: undefined, lastAgentMessageId: undefined,
      interactions: new Map(), resolvedRequests: new Map(), callbackOwners: new Map(), rejectedStarts: new Map(),
      responseDecisions: new Map(), responseDeliveries: new Map(),
      events: [], eventSizes: [], eventBytes: 0, sequence: 0,
      seenNotifications: new Set(), wake: new Set(), closed: false, disposed: false,
    }
  }

  private async transport(prepared: Prepared, generation: number, signal?: AbortSignal): Promise<{
    transport: CodexTransport
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
    await this.dependencies.assertUnchanged(prepared.qualified)
    signal.throwIfAborted()
    const transport = this.dependencies.transport(
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
      undefined, this.processRecovery, prepared.disabledMcpServerNames, undefined,
      { nativeApps: prepared.nativeApps, mcpTransportOverrides: prepared.mcpTransportOverrides ?? {},
        reconnectableStdio: isWorkflowStart(prepared.input)
        && advanced(prepared.harnessConfiguration).sessionPersistence !== 'ephemeral' },
    )
    // Also own cold-attachment candidates before a Runtime has been published.
    this.ownTransport(transport)
    try {
      await transport.start(signal)
      if (this.appMcpAccess === 'none') {
        // Read the launched process, not the unmodified on-disk CLI configuration.
        const response = object(await transport.request('config/read', { includeLayers: false, cwd: prepared.workingDirectory }, signal))
        const config = object(response.config, 'CODEX_APP_MCP_UNAVAILABLE')
        const servers = config.mcp_servers === undefined ? {} : object(config.mcp_servers, 'CODEX_APP_MCP_UNAVAILABLE')
        if (chatExcludedAppMcpServerNames(this.appMcpServerName).some((name) => {
          const entry = servers[name]
          return prepared.disabledMcpServerNames.includes(name)
            ? !Object.hasOwn(servers, name) || !isObject(entry) || entry.enabled !== false
            : Object.hasOwn(servers, name)
        })) {
          throw new HarnessExecutionError('CODEX_APP_MCP_UNAVAILABLE', 'Foreman Code workflow tools are not available in chat; native launch did not confirm the App MCP entry was disabled.')
        }
      }
    } catch (error) {
      await transport.close()
      throw error
    }
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

  private ownTransport(transport: CodexTransport): CodexTransport {
    this.transports.add(transport)
    const close = transport.close.bind(transport)
    transport.close = async () => {
      await close()
      this.transports.delete(transport)
    }
    return transport
  }

  private async restart(runtime: Runtime, signal?: AbortSignal, supplied?: Prepared): Promise<void> {
    if (advanced(runtime.configuration).sessionPersistence === 'ephemeral') {
      throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'An ephemeral native session cannot survive a process restart.')
    }
    const prepared = supplied ?? await this.prepareInput(runtime.input, signal)
    this.assertBinding(runtime, prepared.input)
    const generation = runtime.generation + 1
    // Withdraw the old turn's file authority before replacing its process.
    runtime.starting?.preparationController.abort()
    await Promise.allSettled([runtime.starting?.filePreparation, runtime.starting?.nativeOutputPreparation])
    await this.finishTurnResources(runtime)
    // The old transport remains owned until its entire process tree is stopped.
    await runtime.transport.close()
    const candidate = await this.transport(prepared, generation, signal)
    try {
      const response = object(await candidate.transport.request('thread/resume', {
        ...threadParameters(prepared, Boolean(this.chatFiles)), threadId: runtime.session.nativeSessionId, excludeTurns: true,
      }, signal), 'CODEX_THREAD_RESUME_INVALID')
      this.validateThreadResponse(prepared, response, runtime.session.nativeSessionId)
      runtime.transport = candidate.transport
      runtime.generation = generation
      runtime.input = prepared.input
      runtime.scopedCredentialVariable = prepared.scopedCredentialVariable
      runtime.approvedAppMcpServerName = prepared.approvedAppMcpServerName
      runtime.strippedCredentialVariable = prepared.strippedCredentialVariable
      runtime.qualified = { ...prepared.qualified }
      runtime.effectiveSandbox = prepared.effectiveSandbox ? structuredClone(prepared.effectiveSandbox) : undefined
      runtime.closed = false
      for (const waiting of runtime.interactions.values()) waiting.delivery = 'uncertain'
      await candidate.activate(runtime)
    } catch (error) {
      runtime.closed = true
      await candidate.transport.close().catch(() => undefined)
      throw error
    }
  }

  private rejectStartedTurn(runtime: Runtime, starting: StartingTurn): void {
    if (runtime.starting !== starting || starting.acknowledgedTurnId || runtime.activeTurnId) return
    const result: ExecutionResult = { outcome: 'failed', error: {
      code: 'CODEX_TURN_START_REJECTED', message: 'Codex rejected this message before starting a turn.', retryable: true,
    } }
    runtime.rejectedStarts.set(starting.correlationId, result)
    if (starting.nativeAttemptId) {
      this.responseJournal?.recordTurnRejection(runtime.session, starting.correlationId, starting.nativeAttemptId, result)
    }
    this.restoreRejectedStart(runtime, starting)
  }

  private restoreRejectedStart(runtime: Runtime, starting: StartingTurn): void {
    if (runtime.starting !== starting) return
    if (starting.acknowledgedTurnId || runtime.activeTurnId) return
    Object.assign(runtime, starting.previous)
    runtime.phase = 'idle'
    runtime.starting = undefined
    starting.resolveIdentity(undefined)
    starting.staged.length = 0
    void this.finishTurnResources(runtime).catch(() => undefined)
    this.record(runtime, 'turn.start_rejected', { correlationId: starting.correlationId })
  }

  private acceptStartedTurn(runtime: Runtime, starting: StartingTurn, value: unknown): Promise<void> {
    if (runtime.disposed || runtime.starting !== starting) return Promise.resolve()
    const turn = object(object(value, 'CODEX_TURN_START_INVALID').turn, 'CODEX_TURN_START_INVALID')
    const turnId = text(turn.id)
    if (!turnId || turnId.length > 1_024 || turnId === starting.previous.activeTurnId
      || (starting.acknowledgedTurnId && starting.acknowledgedTurnId !== turnId)) {
      runtime.phase = 'uncertain'
      return Promise.reject(new HarnessExecutionError('CODEX_TURN_START_INVALID', 'Codex did not establish a new turn identity.'))
    }
    if (starting.acknowledgement) return starting.acknowledgement
    starting.acknowledgedTurnId = turnId
    const acknowledgement = (async () => {
      let admitted = false
      runtime.activeTurnId = turnId
      runtime.activeCorrelationId = starting.correlationId
      starting.resolveIdentity(turnId)
      try {
        // Durable identity FIRST. Early callbacks remain staged across both
        // persistence and token issuance, including a late-ACK recovery path.
        await starting.onSubmitted?.(turnId)
        if (runtime.disposed || runtime.closed) { await this.finishTurnResources(runtime); return }
        if (runtime.files && !runtime.files.closed && !starting.cancelRequested && turn.status === 'inProgress') {
          await runtime.files.activate(turnId)
        } else await this.finishFiles(runtime)
        if (runtime.nativeOutput && !starting.cancelRequested && turn.status === 'inProgress') {
          const output = runtime.nativeOutput, transport = runtime.transport, generation = runtime.generation
          await output.activate({ session: structuredClone(runtime.session), connectionId: runtime.connectionId,
            runtimeGeneration: generation, nativeTurnId: turnId, assertCurrent: () => {
              if (runtime.nativeOutput !== output || runtime.transport !== transport || runtime.generation !== generation
                || runtime.closed || runtime.disposed || runtime.terminalResult || starting.cancelRequested
                || runtime.activeTurnId !== turnId || stagedNativeOutputTerminal(runtime, turnId)) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Original native output turn was withdrawn.')
            } }, starting.preparationController.signal)
        } else if (runtime.nativeOutput) await this.finishTurnResources(runtime)
        runtime.phase = 'active'
        this.record(runtime, 'turn.started', { threadId: runtime.session.nativeSessionId, turnId, clientCorrelationId: starting.correlationId })
        this.applyTurn(runtime, { ...turn, status: 'inProgress' })
        admitted = true
      } catch (error) {
        runtime.phase = 'uncertain'
        delete starting.acknowledgement
        await this.finishTurnResources(runtime)
        throw error
      } finally {
        // Keep the gate closed while draining: callbacks arriving during an
        // awaited file operation must not overtake earlier staged callbacks.
        try {
          while (admitted && !runtime.disposed && starting.staged.length > 0) {
            const event = starting.staged.shift()!
            if ('request' in event) await this.handleRequest(runtime, event.request, true)
            else this.handleNotification(runtime, event.method, event.params, true, event.arrivalOrdinal)
          }
        } finally {
          if (admitted) {
            starting.staged.length = 0
            if (runtime.starting === starting) runtime.starting = undefined
          }
        }
      }
      if (admitted && !runtime.disposed && turn.status !== 'inProgress') this.applyTurn(runtime, turn)
      if (starting.cancelRequested && !runtime.terminalResult) await this.interrupt(runtime)
    })()
    starting.acknowledgement = acknowledgement
    return acknowledgement
  }

  private finishTurnResources(runtime: Runtime): Promise<void> {
    if (runtime.nativeOutput && !runtime.nativeOutputCleanup) {
      const attempt = runtime.nativeOutput.close()
      runtime.nativeOutputCleanup = attempt
      void attempt.catch(() => { if (runtime.nativeOutputCleanup === attempt) runtime.nativeOutputCleanup = undefined })
    }
    return Promise.all([this.finishFiles(runtime), runtime.nativeOutputCleanup]).then(() => undefined)
  }

  private async restoreNativeOutputTurn(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    if (!this.nativeOutputs || !runtime.activeTurnId || runtime.terminalResult) return
    const correlationId = runtime.activeCorrelationId
    if (!correlationId || !runtime.effectiveSandbox) throw new HarnessExecutionError(
      'CODEX_NATIVE_OUTPUT_ADMISSION_REQUIRED', 'Recovered native output requires the original turn and sandbox.')
    const activeSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    const bridge = await this.nativeOutputs.prepare({
      ...this.nativeOutputQualification(runtime.configuration, runtime.qualified,
        runtime.workingDirectory, runtime.effectiveSandbox.tmpdir),
      effectiveSandbox: structuredClone(runtime.effectiveSandbox), session: structuredClone(runtime.session),
      clientCorrelationId: correlationId, connectionId: runtime.connectionId, runtimeGeneration: runtime.generation,
    }, activeSignal)
    const output = new CodexRuntimeNativeOutputTurn(bridge)
    runtime.nativeOutput = output
    const turnId = runtime.activeTurnId
    await output.activate({ session: structuredClone(runtime.session), connectionId: runtime.connectionId,
      runtimeGeneration: runtime.generation, nativeTurnId: turnId, assertCurrent: () => {
        if (runtime.nativeOutput !== output || runtime.closed || runtime.disposed || runtime.terminalResult
          || runtime.activeTurnId !== turnId) throw new HarnessExecutionError(
          'CODEX_NATIVE_OUTPUT_CLOSED', 'The recovered native output turn was withdrawn.')
      } }, activeSignal)
  }

  private finishFiles(runtime: Runtime): Promise<void> {
    if (!runtime.files) return Promise.resolve()
    if (runtime.fileCleanup) return runtime.fileCleanup
    const attempt = runtime.files.close()
    runtime.fileCleanup = attempt
    void attempt.catch(() => {
      // Keep the bridge owned so close/dispose or the next admission can retry.
      if (runtime.fileCleanup === attempt) runtime.fileCleanup = undefined
      this.record(runtime, 'files.cleanup_failed', {})
    })
    return attempt
  }

  private interrupt(runtime: Runtime): Promise<boolean> {
    const turnId = runtime.activeTurnId
    if (!turnId || runtime.terminalResult) return Promise.resolve(false)
    if (runtime.starting) { runtime.starting.cancelRequested = true; runtime.starting.preparationController.abort() }
    // Cancellation withdraws file authority even when native interrupt delivery is uncertain.
    void this.finishTurnResources(runtime).catch(() => undefined)
    if (runtime.cancellation?.turnId === turnId) return runtime.cancellation.promise
    const promise = (async () => {
      for (let attempt = 0; attempt <= INTERRUPT_STARTUP_RETRIES; attempt += 1) {
        if (runtime.terminalResult) return false
        try {
          await codexRequest(runtime.transport, 'turn/interrupt', { threadId: runtime.session.nativeSessionId, turnId })
          this.record(runtime, 'turn.cancel_submitted', { turnId })
          return true
        } catch (error) {
          const startupRace = error instanceof CodexRpcError
            && !error.uncertain
            && error.nativeMessage?.startsWith('no active turn to interrupt')
          if (!startupRace || attempt === INTERRUPT_STARTUP_RETRIES) throw error
          await new Promise((resolve) => this.dependencies.schedule(resolve, INTERRUPT_STARTUP_RETRY_MS))
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
    if (!starting) return false
    starting.stagedBytes += Buffer.byteLength(JSON.stringify(event))
    if (starting.staged.length >= MAX_STAGED || starting.stagedBytes > MAX_EVENT_BYTES) {
      runtime.phase = 'uncertain'
      throw new Error('The turn-start notification buffer exceeded its limit.')
    }
    starting.staged.push(event)
    return true
  }

  private async synchronize(runtime: Runtime, correlationId?: string, signal?: AbortSignal): Promise<void> {
    const transport = runtime.transport
    const generation = runtime.generation
    const registered = this.runtimes.get(runtime.session.nativeSessionId)
    const starting = runtime.starting
    if (starting && correlationId !== starting.correlationId) {
      throw new HarnessExecutionError('CODEX_CORRELATION_MISMATCH', 'Reconcile the correlation of the uncertain turn/start operation.')
    }
    const rejectedDuringRead = () => {
      if (this.runtimes.get(runtime.session.nativeSessionId) !== registered || runtime.transport !== transport
        || runtime.generation !== generation || runtime.closed || runtime.disposed) {
        throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The native history owner changed during reconciliation.')
      }
      // A definite rejection can restore idle while an older native read is in flight.
      return starting !== undefined && !starting.acknowledgedTurnId && runtime.starting === undefined
        && runtime.phase === 'idle' && runtime.activeTurnId === starting.previous.activeTurnId
        && runtime.activeCorrelationId === starting.previous.activeCorrelationId
        && runtime.rejectedStarts.has(starting.correlationId)
    }
    const wantedCorrelation = starting?.correlationId ?? correlationId
    const wantedId = starting ? undefined : wantedCorrelation
      ? runtime.activeCorrelationId === wantedCorrelation ? runtime.activeTurnId
        : runtime.input.correlationId === wantedCorrelation ? runtime.input.nativeTurnId : undefined
      : runtime.input.nativeTurnId ?? runtime.activeTurnId
    const response = object(await transport.request('thread/read', {
      threadId: runtime.session.nativeSessionId, includeTurns: false,
    }, signal), 'CODEX_THREAD_READ_INVALID')
    if (rejectedDuringRead()) return
    const thread = object(response.thread, 'CODEX_THREAD_READ_INVALID')
    if (thread.id !== runtime.session.nativeSessionId) throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Reconciliation returned another thread.')
    const matches = (turn: JsonObject) => wantedId ? turn.id === wantedId
      : wantedCorrelation ? Array.isArray(turn.items) && turn.items.some((item) => isObject(item) && item.type === 'userMessage' && item.clientId === wantedCorrelation)
        : true
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : []
    let selected = [...turns].reverse().find(matches)
    if (!selected || selected.itemsView !== 'full') {
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      selected = undefined
      for (let page = 0; page < 20; page += 1) {
        const result = await listCodexTurns(transport, {
          threadId: runtime.session.nativeSessionId, limit: 50, sortDirection: 'desc', itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        }, signal)
        if (rejectedDuringRead()) return
        // Before its first turn lands the thread has no history; an unacknowledged turn/start is still pending.
        if (!result) { if (starting && !starting.acknowledgedTurnId) return; break }
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
    // Retain the actual full native turn read, not just its derived terminal enum.
    this.record(runtime, 'thread.reconciled', {
      threadId: thread.id, thread: { id: thread.id, turns: [selected] },
    })
  }

  private applyTurn(runtime: Runtime, turn: JsonObject): void {
    if (turn.id !== runtime.activeTurnId || !Array.isArray(turn.items)) return
    if (runtime.capacityRetry?.failure) return
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
      if (turn.status !== 'inProgress' && text(value.id)) {
        const fingerprint = itemNotificationKey(runtime.generation, 'item/completed', turn.id, value.id, value.type)
        if (!runtime.seenNotifications.has(fingerprint)) {
          runtime.seenNotifications.add(fingerprint)
          this.record(runtime, 'item.completed', {
            threadId: runtime.session.nativeSessionId, turnId: turn.id, item: value,
          })
        }
      }
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
    const result: ExecutionResult = turn.status === 'completed'
      ? { outcome: 'succeeded', output: { text: runtime.finalAnswer ?? runtime.lastAgentMessage ?? '' } }
      : turn.status === 'interrupted' ? { outcome: 'canceled' }
        : { outcome: 'failed', error: { code: 'CODEX_TURN_FAILED', message: text(isObject(turn.error) ? turn.error.message : undefined) ?? 'Codex turn failed.', retryable: false } }
    const retry = runtime.capacityRetry
    runtime.terminalResult = result
    if (turn.status === 'failed' && retry?.canAdvanceIdentity && isCodexCapacityError(turn.error)
      && retry.attempt < CODEX_CAPACITY_ATTEMPTS && !retry.controller.signal.aborted) retry.failure = result
    runtime.phase = 'idle'
    void this.finishTurnResources(runtime).catch(() => undefined)
    for (const [key, waiting] of runtime.interactions) {
      if (waiting.pending.turn.nativeTurnId === turn.id) this.resolveInteraction(runtime, key, waiting, 'cleared')
    }
    this.wake(runtime)
  }

  private async handleRequest(runtime: Runtime, request: RpcRequest, staged = false): Promise<void> {
    if (runtime.closed || runtime.disposed) return
    const params = request.params ?? {}
    const key = requestKey(runtime.generation, request.id)
    const root = runtime.parent ?? runtime
    const callbackOwner = root.callbackOwners.get(key)
    if (callbackOwner && callbackOwner !== params.threadId) {
      const owner = callbackOwner === root.session.nativeSessionId
        ? root : this.childRuntimes.get(callbackOwner)?.runtime
      const interaction = owner?.interactions.get(key)
      const file = owner?.fileRequests.get(key)
      if (interaction) interaction.conflictingIdentity = true
      if (file) file.conflictingIdentity = true
      this.record(root, 'protocol.conflicting_request_identity', { nativeRequestKey: key })
      return
    }
    if (!runtime.parent && params.threadId !== runtime.session.nativeSessionId) {
      const child = this.childRuntimes.get(String(params.threadId))
      if (child?.runtime.parent === runtime) {
        child.assertCurrent()
        await this.handleRequest(child.runtime, request, staged)
        return
      }
    }
    const signature = createHash('sha256').update(canonical([request.method, params])).digest('hex')
    const existing = runtime.interactions.get(key)
    const resolved = runtime.resolvedRequests.get(key)
    const file = runtime.fileRequests.get(key)
    if (existing || resolved || file) {
      // All callbacks share one connection/generation/typed RPC-ID namespace.
      // Never reply to a conflicting envelope using the original callback's ID.
      if ((existing?.signature ?? resolved?.signature ?? file?.signature) !== signature) {
        if (existing) existing.conflictingIdentity = true
        if (file) file.conflictingIdentity = true
        this.record(runtime, 'protocol.conflicting_request_identity', { nativeRequestKey: key })
        return
      }
      // Equivalent file retries retain their existing receipt, never a second
      // concurrent writer. Consumed identities from earlier turns stay fenced.
      if (!file || file.conflictingIdentity || request.method !== 'item/tool/call') return
    }
    if (params.threadId !== runtime.session.nativeSessionId) {
      await runtime.transport.reject(request.id, -32602, 'This request belongs to another thread.'); return
    }
    root.callbackOwners.set(key, runtime.session.nativeSessionId)
    if (!staged && this.stage(runtime, { request })) return
    if (request.method === 'item/tool/call') {
      // Do not block the stdio frame reader on file I/O: turn/completed and
      // interrupt acknowledgements must be able to withdraw authority mid-call.
      void this.handleFileCall(runtime, request, typeof params.tool === 'string'
        && Object.hasOwn(CODEX_NATIVE_OUTPUT_TOOL_ALIASES, params.tool)).catch(() => {
        this.record(runtime, 'files.response_unconfirmed', {})
      })
      return
    }
    if (runtime.interactions.size >= MAX_INTERACTIONS) {
      await runtime.transport.reject(request.id, -32000, 'Native pending-interaction limit exceeded.'); return
    }
    const standalone = request.method === 'mcpServer/elicitation/request' && params.turnId == null
    if (!standalone && (!text(params.turnId) || params.turnId !== runtime.activeTurnId || runtime.terminalResult)) {
      await runtime.transport.reject(request.id, -32602, 'The request does not belong to the active turn.'); return
    }
    const translated = this.translateRequest(runtime, request, signature)
    if (!translated) {
      await runtime.transport.reject(request.id, -32601, 'This native approval request has no supported response mapping.')
      return
    }
    const retainedBytes = [...runtime.interactions.values()].reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.pending)), 0)
    if (retainedBytes + Buffer.byteLength(JSON.stringify(translated.pending)) > MAX_EVENT_BYTES) {
      await runtime.transport.reject(request.id, -32000, 'Native pending-interaction memory limit exceeded.')
      this.record(runtime, 'interaction.capacity_exceeded', { nativeMethod: request.method })
      return
    }
    runtime.interactions.set(key, translated)
    let observedTurnStatus: string | null = runtime.activeTurnId ? 'inProgress' : null
    if (runtime.terminalResult?.outcome === 'succeeded') observedTurnStatus = 'completed'
    else if (runtime.terminalResult?.outcome === 'canceled') observedTurnStatus = 'interrupted'
    else if (runtime.terminalResult?.outcome === 'failed') observedTurnStatus = 'failed'
    this.record(runtime, 'interaction.pending', {
      nativeRequestId: translated.pending.turn.nativeRequestId, nativeRequestType: request.method,
      turnId: translated.pending.turn.nativeTurnId,
      observedTurnId: runtime.activeTurnId ?? null,
      observedTurnStatus,
    })
  }

  private async handleFileCall(runtime: Runtime, request: RpcRequest, nativeOutputCall = false): Promise<void> {
    const params = request.params ?? {}
    const transport = runtime.transport
    const generation = runtime.generation
    const key = requestKey(generation, request.id)
    const signature = createHash('sha256').update(canonical([request.method, params])).digest('hex')
    const prior = runtime.fileRequests.get(key)
    if (prior?.pending || prior?.conflictingIdentity) return
    if ([...runtime.resolvedRequests.values()].filter((entry) => entry.pending).length >= MAX_INTERACTIONS) {
      this.record(runtime, 'files.response_capacity_exceeded', { nativeRequestKey: key })
      // An untrackable live ID cannot be forgotten while this connection keeps
      // accepting callbacks. Fence it synchronously and retain failed cleanup.
      this.handleDisconnect(runtime)
      void runtime.transport.close().catch(() => { this.record(runtime, 'transport.close_unconfirmed', {}) })
      return
    }
    const reservation: ResolvedRequest = { signature, nativeRequestId: undefined,
      nativeTurnId: text(params.turnId), method: request.method, generation, pending: true }
    // This connection-owned identity survives next-turn file-cache cleanup and
    // remains pinned until the entire file call and transport response settle.
    this.rememberResolvedRequest(runtime, key, reservation)
    const denied = { success: false, contentItems: [{ type: 'inputText', text: 'File operation unavailable or denied.' }] }
    const capacityExceeded = runtime.fileRequests.size >= MAX_INTERACTIONS && !prior
    const receipt: NonNullable<typeof prior> = prior ?? { signature, pending: true }
    receipt.pending = true
    if (!capacityExceeded) runtime.fileRequests.set(key, receipt)
    try {
      if (capacityExceeded || runtime.closed || runtime.disposed || runtime.terminalResult || params.turnId !== runtime.activeTurnId
        || (nativeOutputCall ? !runtime.nativeOutput : !runtime.files) || typeof params.callId !== 'string' || typeof params.tool !== 'string'
        || (params.namespace != null && typeof params.namespace !== 'string')) {
        await transport.respond(request.id, request.method, denied); return
      }
      const output = runtime.nativeOutput
      const outputTool = nativeOutputCall
      if (outputTool && params.namespace != null) { await transport.respond(request.id, request.method, denied); return }
      const assertCurrent = () => {
        if (!output || runtime.nativeOutput !== output || runtime.transport !== transport || runtime.generation !== generation
          || runtime.closed || runtime.disposed || runtime.terminalResult || runtime.activeTurnId !== params.turnId
          || runtime.fileRequests.get(key) !== receipt || receipt.conflictingIdentity || !receipt.pending
          || runtime.transport.isConnected?.() !== true || stagedNativeOutputTerminal(runtime, String(params.turnId))) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Original native output callback was withdrawn.')
      }
      const result = outputTool && output ? await output.dispatch(params.tool, params.arguments, {
        session: structuredClone(runtime.session), connectionId: runtime.connectionId, runtimeGeneration: generation,
        nativeTurnId: String(params.turnId), rpcId: request.id, callId: params.callId, assertCurrent,
      }) : runtime.files ? await runtime.files.dispatch({ threadId: runtime.session.nativeSessionId,
        turnId: String(params.turnId), callId: params.callId, tool: params.tool, arguments: params.arguments,
        ...(typeof params.namespace === 'string' ? { namespace: params.namespace } : {}),
      }) : denied
      if (outputTool) assertCurrent()
      if (runtime.transport === transport && runtime.generation === generation && !runtime.disposed && !runtime.closed
        && runtime.fileRequests.get(key) === receipt && !receipt.conflictingIdentity) {
        await transport.respond(request.id, request.method, { ...result })
      }
    } finally {
      receipt.pending = false
      reservation.pending = false
    }
  }

  private translateRequest(runtime: Runtime, request: RpcRequest, signature: string): WaitingRequest | undefined {
    const translated = translateCodexInteraction({ session: runtime.session, configuration: runtime.configuration,
      connectionId: runtime.connectionId, generation: runtime.generation }, request)
    if (!translated) return undefined
    const { pending, responses } = translated
    let resolve!: WaitingRequest['resolve']
    const resolution = new Promise<'resolved' | 'cleared'>((complete) => { resolve = complete })
    return { pending, requestId: request.id, method: request.method, generation: runtime.generation, transport: runtime.transport,
      signature, responses, delivery: 'pending', resolution, resolve }
  }

  private handleNotification(runtime: Runtime, method: string, params: JsonObject, staged = false, arrivalOrdinal = ++runtime.arrivalOrdinal): void {
    if (!runtime.parent && params.threadId !== runtime.session.nativeSessionId) {
      const child = this.childRuntimes.get(String(params.threadId))
      if (child?.runtime.parent === runtime) {
        try { child.assertCurrent() } catch { return }
        this.handleNotification(child.runtime, method, params, staged)
      }
    }
    if (method === 'thread/tokenUsage/updated') {
      const context = codexContextSnapshot(params, runtime.session.nativeSessionId, runtime.configuration.model, arrivalOrdinal)
      if (context) runtime.context = { ...context, generation: `${runtime.connectionId}:${runtime.generation}` }
    }
    if (runtime.compaction && ['accepted', 'running', 'uncertain'].includes(runtime.compaction.status)
      && params.threadId === runtime.session.nativeSessionId && ['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) {
      const turnId = text(params.turnId) ?? text(isObject(params.turn) ? params.turn.id : undefined)
      if (turnId && runtime.compactionPreviousTurns?.has(turnId)) return
      runtime.compaction = codexCompactionNotification(runtime.compaction, method, params)
      if (runtime.compaction.status === 'completed' && runtime.context) runtime.context = { ...runtime.context, stale: true }
      this.wake(runtime)
      return
    }
    if (method === 'protocol/malformed') { this.record(runtime, 'native.malformed', params); return }
    if (['serverRequest/resolved', 'turn/started', 'turn/completed', 'item/started', 'item/completed',
      'item/agentMessage/delta'].includes(method)) {
      if (params.threadId === runtime.session.nativeSessionId && !staged && this.stage(runtime, { method, params, arrivalOrdinal })) return
    }
    const normalized = normalizeCodexNotification({ threadId: runtime.session.nativeSessionId, ...(runtime.activeTurnId ? { turnId: runtime.activeTurnId } : {}),
      runtimeGeneration: runtime.generation, terminal: Boolean(runtime.terminalResult),
      knownCommandItem: (itemId) => !runtime.closed && !runtime.disposed && runtime.transport.isConnected?.() === true
        && runtime.seenNotifications.has(itemNotificationKey(runtime.generation, 'item/started', runtime.activeTurnId, itemId, 'commandExecution')) }, {
      providerVersion: runtime.session.providerVersion, schemaIdentity: runtime.schemaIdentity,
      connectionId: runtime.connectionId, runtimeGeneration: runtime.generation, arrivalOrdinal, method, params,
    })
    if (normalized.kind === 'ignored') return
    if (normalized.kind === 'unlinked') {
      this.record(runtime, 'native.unlinked_notification', { ...normalized.evidence })
      return
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
      this.record(runtime, method === 'turn/started' ? 'turn.started' : 'turn.completed', {
        threadId: params.threadId, turnId: turn.id, status: turn.status,
        ...(runtime.capacityRetry?.failure ? { willRetry: true } : {}),
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params.threadId !== runtime.session.nativeSessionId || params.turnId !== runtime.activeTurnId
        || runtime.terminalResult && !(normalized.kind === 'item' && normalized.knownAfterTerminal)) return
      const item = isObject(params.item) ? params.item : undefined
      if (!item || !text(item.id) || !text(item.type)) return
      const fingerprint = itemNotificationKey(runtime.generation, method, params.turnId, item.id, item.type)
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
    this.rememberResolvedRequest(runtime, key, { signature: waiting.signature,
      nativeRequestId: waiting.pending.turn.nativeRequestId, nativeTurnId: waiting.pending.turn.nativeTurnId,
      method: waiting.method, generation: waiting.generation })
    waiting.resolve(result)
    // Native "resolved" means answered OR cleared, not proof of a permission grant.
    this.record(runtime, `interaction.${result}`, {
      nativeRequestId: waiting.pending.turn.nativeRequestId,
      ...(waiting.selectedOptionId ? { submittedOptionId: waiting.selectedOptionId } : {}),
      evidence: result === 'resolved' ? 'serverRequest/resolved' : 'terminal_turn',
    })
  }

  private rememberResolvedRequest(runtime: Runtime, key: string, request: ResolvedRequest): void {
    runtime.resolvedRequests.set(key, request)
    if (runtime.resolvedRequests.size > MAX_EVENTS) {
      const expired = [...runtime.resolvedRequests].find(([, entry]) => !entry.pending)
      if (expired) runtime.resolvedRequests.delete(expired[0])
    }
  }

  private handleDisconnect(runtime: Runtime): void {
    runtime.closed = true
    runtime.starting?.preparationController.abort()
    void this.finishTurnResources(runtime).catch(() => undefined)
    if (runtime.phase === 'starting' || runtime.phase === 'active') runtime.phase = 'uncertain'
    for (const waiting of runtime.interactions.values()) waiting.delivery = 'uncertain'
    this.record(runtime, 'transport.disconnected', { unresolvedInteractions: runtime.interactions.size })
  }

  private record(runtime: Runtime, type: string, payload: JsonObject): void {
    const event = NativeHarnessEventSchema.parse({
      sequence: runtime.sequence, connectionId: runtime.connectionId, type, occurredAt: this.dependencies.now().toISOString(), payload,
    })
    const size = Buffer.byteLength(JSON.stringify(event))
    if (size > MAX_EVENT_BYTES) throw new HarnessExecutionError('NATIVE_EVENT_TOO_LARGE', 'A native event exceeded the bounded delivery window.')
    runtime.sequence += 1
    runtime.events.push(event)
    const item = isObject(payload.item) ? payload.item : undefined
    runtimeTimingPoint('harness', 'native.event', { nativeSessionId: runtime.session.nativeSessionId,
      ...(isWorkflowStart(runtime.input)
        ? { runId: runtime.input.request.runId, executionId: runtime.input.request.executionId } : {}),
      eventType: type, sequence: event.sequence,
      ...(typeof payload.nativeMethod === 'string' ? { nativeMethod: payload.nativeMethod } : {}),
      ...(typeof payload.turnId === 'string' ? { nativeTurnId: payload.turnId } : {}),
      ...(typeof item?.type === 'string' ? { itemType: item.type } : {}) })
    runtime.eventSizes.push(size)
    runtime.eventBytes += size
    while (runtime.events.length > MAX_EVENTS || runtime.eventBytes > MAX_EVENT_BYTES) {
      runtime.events.shift()
      runtime.eventBytes -= runtime.eventSizes.shift()!
    }
    this.captureResponseDeliveries(runtime)
    this.wake(runtime)
  }
  private captureResponseDeliveries(runtime: Runtime): void {
    for (const [id, decision] of runtime.responseDecisions) {
      const proof = codexInputDeliveryEvidence(decision.pending, decision.option, decision.nativeResponse,
        { events: runtime.events, pendingInteractions: [] })
      if (!proof) {
        if (decision.sequence < (runtime.events[0]?.sequence ?? runtime.sequence)) runtime.responseDecisions.delete(id)
        continue
      }
      this.responseJournal?.record(proof)
      runtime.responseDeliveries.set(id, proof)
      runtime.responseDecisions.delete(id)
      if (runtime.responseDeliveries.size > MAX_INTERACTIONS) {
        runtime.responseDeliveries.delete(runtime.responseDeliveries.keys().next().value!)
      }
    }
  }
  private wake(runtime: Runtime): void {
    for (const resolve of runtime.wake) resolve()
    runtime.wake.clear()
  }
  private wait(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const finished = beginRuntimeTiming('harness', 'native.notification_wait',
        { nativeSessionId: runtime.session.nativeSessionId })
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')) }
      const cleanup = () => { finished(); runtime.wake.delete(done); signal?.removeEventListener('abort', abort) }
      runtime.wake.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

/** Codex refuses `thread/turns/list` until the first user message materializes the thread; undefined means no turns yet. */
async function listCodexTurns(transport: CodexTransport, params: JsonObject, signal?: AbortSignal): Promise<JsonObject | undefined> {
  try {
    return object(await transport.request('thread/turns/list', params, signal), 'CODEX_THREAD_READ_INVALID')
  } catch (error) {
    if (error instanceof CodexRpcError && /is not materialized yet/.test(error.nativeMessage ?? '')) return undefined
    throw error
  }
}
