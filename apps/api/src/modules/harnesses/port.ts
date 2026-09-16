import type {
  AgentHarness,
  ExecutionResult,
  HarnessExecutionRequest,
  HarnessQualification,
  ApprovalResponseOption,
  McpDetection,
  NativeHarnessCapabilities,
  NativeHarnessEvent,
  NativeSessionReference,
  PendingNativeInteraction,
  OperatorConfigurationVersion,
} from '@graphql/contracts'

export interface NativeEventInput {
  type: string
  payload: Record<string, unknown>
}

export interface HarnessExecutionCallbacks {
  signal: AbortSignal
  /** Runner consistency check after qualification, immediately before agent spawn. */
  beforeSpawn?(): Promise<ChildProcessEnvironment | void>
  onSession(nativeSessionId: string): Promise<void>
  onEvent(event: NativeEventInput): Promise<void>
}

/** Product Agent execution boundary; native Agent/session concepts stay inside adapters. */
export interface HarnessAdapter {
  readonly harness: AgentHarness
  qualify(request: HarnessExecutionRequest, signal?: AbortSignal): Promise<HarnessQualification>
  execute(request: HarnessExecutionRequest, callbacks: HarnessExecutionCallbacks): Promise<ExecutionResult>
  resume(
    request: HarnessExecutionRequest,
    nativeSessionId: string,
    callbacks: HarnessExecutionCallbacks,
  ): Promise<ExecutionResult>
  cancel(executionId: string): Promise<boolean>
}

export interface HarnessResolver {
  resolve(harness: AgentHarness): HarnessAdapter
}

/** Values are supplied only to one child process and must never enter logs or persisted graph state. */
export interface ChildProcessEnvironment {
  readonly agentId: string
  readonly variables: Readonly<Record<string, string>>
}

export interface WorkflowNativeSessionStart {
  kind?: 'workflow'
  correlationId?: string
  request: HarnessExecutionRequest
  environment?: ChildProcessEnvironment
}

export interface OperatorNativeSessionStart {
  kind: 'operator'
  correlationId: string
  configuration: OperatorConfigurationVersion
  /** Dedicated validated application-global runtime directory; never inferred from process.cwd(). */
  workingDirectory: string
  environment?: ChildProcessEnvironment
}

export type NativeSessionStart = WorkflowNativeSessionStart | OperatorNativeSessionStart

export interface NativeTurnInput {
  prompt: string
  clientCorrelationId: string
}

export interface NativeHistory {
  /** Opaque native cursor for older authoritative history; never interpreted as a message ID. */
  nextCursor?: string
  /** This is a bounded live window; callers persist streamed events at the durable boundary. */
  firstRetainedSequence?: number
  nextSequence?: number
  interactionDeliveries?: readonly {
    nativeRequestId: string
    state: 'pending' | 'submitting' | 'submitted' | 'uncertain'
    selectedOptionId?: string
  }[]
  events: readonly NativeHarnessEvent[]
  pendingInteractions: readonly PendingNativeInteraction[]
  pendingInteraction?: PendingNativeInteraction
  terminalResult?: ExecutionResult
}

/** Rich provider-neutral lifecycle. Concrete Codex/OpenCode transports are HAP-02/03. */
export interface NativeHarnessSessionManager {
  readonly harness: AgentHarness
  capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities>
  inspectMcp(signal?: AbortSignal): Promise<McpDetection>
  createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  /** Verify and rebind a persisted provider identity; never create a replacement session. */
  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  pending(session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined>
  respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void>
  cancel(session: NativeSessionReference, signal?: AbortSignal): Promise<boolean>
  history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory>
  historyPage?(session: NativeSessionReference, before?: string, signal?: AbortSignal): Promise<NativeHistory>
  reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory>
  close(session: NativeSessionReference): Promise<void>
}
