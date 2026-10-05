import type { NativeMessageSubmission } from '@foreman-code/contracts'
export type { NativeMessageSubmission } from '@foreman-code/contracts'
import type {
  AgentHarness,
  ExecutionResult,
  HarnessExecutionRequest,
  HarnessQualification,
  HarnessConfiguration,
  ApprovalResponseOption,
  McpDetection,
  NativeHarnessCapabilities,
  NativeHarnessEvent,
  NativeSessionReference,
  PendingNativeInteraction,
  OperatorConfigurationVersion,
} from '@foreman-code/contracts'

import type { NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import type { ResponseAvailabilityInspector } from './responseAvailability.js'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { SubagentControlLease } from '../subagents/types.js'

export interface NativeEventInput {
  type: string
  payload: Record<string, unknown>
}

/** Read-only settings discovery; this cannot launch, resume, or cancel workflow work. */
export interface HarnessConfigurationQualifier {
  qualify(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal): Promise<HarnessQualification>
}

/** Values are supplied only to one child process and must never enter logs or persisted graph state. */
export interface ChildProcessEnvironment {
  readonly agentId: string
  readonly variables: Readonly<Record<string, string>>
}

export interface WorkflowNativeSessionStart {
  kind?: 'workflow'
  correlationId?: string
  nativeTurnId?: string
  request: HarnessExecutionRequest
  environment?: ChildProcessEnvironment
  /** The native session already carries its accepted startup instructions; attach/fork never resend them. */
  instructionsDelivered?: boolean
}

export interface OperatorNativeSessionStart {
  kind: 'operator'
  correlationId: string
  configuration: OperatorConfigurationVersion
  /** Durable identity of the addressed turn, not the latest turn in the session. */
  nativeTurnId?: string
  /** Dedicated validated application-global runtime directory; never inferred from process.cwd(). */
  workingDirectory: string
  environment?: ChildProcessEnvironment
}

export type NativeSessionStart = WorkflowNativeSessionStart | OperatorNativeSessionStart


export interface NativeTurnInput {
  prompt: string
  clientCorrelationId: string
  /** Await persistence of the provider identity immediately after submission acknowledgement. */
  onSubmitted?(nativeTurnId: string): Promise<void>
  onMessageSubmitted?(identity: NativeMessageSubmission): Promise<void>
  /** Save the matched native result before publishing completion or releasing its runtime. */
  onTerminal?(observation: NativeTerminalObservation): Promise<void>
}

export interface NativeTerminalObservation {
  submission: NativeMessageSubmission
  result: ExecutionResult
  nativeMessageId?: string
  /** Owned history saved with the result so settlement survives process replacement. */
  history?: NativeHistory
}

/** Input added to the exact active turn; the provider rejects it when that turn is no longer active. */
/** Providers that report their native session only after first input use this admitted atomic lifecycle. */
export interface NativeInitialTurnInput extends NativeTurnInput {
  /** Persist the actual provider identity before exposing input ACKs, callbacks or output. */
  onSessionObserved(session: NativeSessionReference): Promise<void>
}

export interface NativeSteerInput {
  prompt: string
  clientCorrelationId: string
  expectedTurnId: string
}

/** Positive acceptance of one steering correlation in one exact native turn; not proof of consumption. */
export interface NativeSteerReceipt {
  nativeSessionId: string
  nativeTurnId: string
  correlationId: string
}

/** Response identity is not a model-turn correlation and must never be used to replay a prompt. */
export interface NativeResponseIdentity {
  nativeRequestId: string
  nativeRequestType: string
  option: ApprovalResponseOption
}

export interface NativeHistory {
  nativeSubmission?: NativeMessageSubmission
  /** Definitive provider rejection of a correlated prompt before a turn exists. */
  nonSubmission?: { nativeSessionId: string; clientCorrelationId: string; result: ExecutionResult }
  /** Set only when the provider result was matched to this exact request. */
  correlationId?: string
  nativeTurnId?: string
  nativeMessageId?: string
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
  /** Explicit provider cancellation evidence, scoped to this exact session. */
  canceledRequestIds?: readonly string[]
  /** Result of the exact requested correlation, never the session's latest turn. */
  terminalTurn?: { correlationId: string; providerId: string; result: ExecutionResult }
  /** Optional positive evidence; an empty pending list is never a delivery receipt. */
  responseDeliveries?: readonly NativeResponseDeliveryEvidence[]
  events: readonly NativeHarnessEvent[]
  pendingInteractions: readonly PendingNativeInteraction[]
  pendingInteraction?: PendingNativeInteraction
  terminalResult?: ExecutionResult
}

/** Rich provider-neutral lifecycle. Concrete Codex/OpenCode transports are HAP-02/03. */
export interface NativeSubagentHistoryPage {
  events: readonly NativeHarnessEvent[]
  nextCursor: string | null
}

export interface NativeHarnessSessionManager extends ResponseAvailabilityInspector {
  readonly harness: AgentHarness
  /** True after native query dispatch; false proves this manager never launched work. */
  requiresRuntimeClosure?(): boolean
  capabilities(signal?: AbortSignal): Promise<NativeHarnessCapabilities>
  inspectMcp(signal?: AbortSignal): Promise<McpDetection>
  createSession(input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  /** Look up the original creation only; never launches a process or sends another creation request. */
  reconcileSessionCreation?(input: NativeSessionStart, signal?: AbortSignal,
    forkSource?: NativeSessionReference): Promise<NativeSessionReference>
  /** Verify and rebind a persisted provider identity; never create a replacement session. */
  attachSession(session: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  /** One first prompt under existing app admission; never a planned/local native session ID. */
  startInitialTurn?(start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent>
  /** Add input to the exact active turn. Absent when the provider has no expected-turn precondition. */
  steerTurn?(session: NativeSessionReference, input: NativeSteerInput, signal?: AbortSignal): Promise<{ nativeTurnId: string }>
  /** Read-only receipt lookup; must not replace the runtime's active turn/correlation or replay input. */
  reconcileSteers?(session: NativeSessionReference,
    inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[],
    signal?: AbortSignal): Promise<readonly NativeSteerReceipt[]>
  /** New native session copying a source session's history. The source session is never modified. */
  forkSession?(source: NativeSessionReference, input: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference>
  pending(session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined>
  respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void>
  /** Synchronously stop client-side auto replies before cleanup reads; never terminal evidence. */
  stopAutomaticResponses?(session: NativeSessionReference): void
  cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string): Promise<boolean>
  /** Read native descendants through their exact admitted parent. Never resumes a child or changes its input owner. */
  subagentHistory?(session: NativeSessionReference, cursor?: string, signal?: AbortSignal): Promise<NativeSubagentHistoryPage>
  /** Only an already-resident exact parent may expose child controls. Never allocate or attach here. */
  subagentControl?(child: RunSubagent, assertOwner: () => void): SubagentControlLease | undefined
  history(session: NativeSessionReference, signal?: AbortSignal): Promise<NativeHistory>
  /** Refresh authenticated remote ownership before a coordinator boundary check. */
  observeBoundary?(session: NativeSessionReference, signal?: AbortSignal): Promise<void>
  historyPage?(session: NativeSessionReference, before?: string, signal?: AbortSignal): Promise<NativeHistory>
  reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory>
  /** Release resident turn resources after the caller commits its result and history. */
  retireTurn?(session: NativeSessionReference, correlationId: string): Promise<void>
  /** Read-only recovery of the exact response; missing evidence remains uncertain. */
  reconcileResponse?(session: NativeSessionReference, response: NativeResponseIdentity, signal?: AbortSignal): Promise<NativeHistory>
  close(session: NativeSessionReference): Promise<void>
  /** Detach the local runtime for process restart without canceling unresolved provider work. */
  closeForRestart?(session: NativeSessionReference): Promise<void>
  /** Stop every owned transport, including creations without a known session identity. */
  dispose?(): Promise<void>
}
