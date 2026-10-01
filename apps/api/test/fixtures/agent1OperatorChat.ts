import type {
  Conversation, ExecutionResult, NativeSessionReference, OperatorConfigurationVersion,
  OperatorConversationState, PendingNativeInteraction, SendOperatorMessageRequest,
} from '@graphql/contracts'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import type { ConversationRow, PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import type { ActivityTextOperation } from '@graphql/contracts/activity-text'
import type { NativeHarnessSessionManager, NativeHistory, NativeTurnInput } from '../../src/modules/harnesses/port.js'

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('The expected lifecycle transition did not finish.')
}
export function operator(id = 'human-owner'): ManagementPrincipal {
  return { id, name: id, audience: 'operator', revokedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString(),
    grants: [{ scope: {}, actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'settings:update', 'agents:read'] }] }
}
export function memoryConversation(configuration: OperatorConfigurationVersion, ownerId = 'human-owner', id = 'chat-one') {
  const now = new Date()
  const conversation: Conversation = { id, agentId: configuration.operatorId, scope: 'application',
    operatorConfigurationVersionId: configuration.id, status: 'open', title: 'Test conversation', createdAt: now.toISOString(), updatedAt: now.toISOString() }
  const row: ConversationRow = { id, operator_configuration_version_id: configuration.id,
    harness: configuration.harness.harness, owner_principal_id: ownerId, record: conversation,
    parent_conversation_id: null, fork_request_id: null, handoff_source_harness: null,
    handoff_source_sequence: null, handoff_omitted_messages: 0, handoff_context: null,
    native_session_id: null, provider_version: null, active_request_id: null, active_native_turn_id: null,
    active_phase: null, turn_state: 'idle', cancel_requested: false, last_error: null, revision: 0,
    pending_interaction: null, response_delivery: null, last_result: null, updated_at: now }
  const receipts = new Set<string>()
  const finishResults: ExecutionResult[] = []
  const change = () => { row.revision = Number(row.revision) + 1 }
  const state = (): OperatorConversationState => ({ conversation: row.record as Conversation, messages: [],
    turnState: row.turn_state, revision: Number(row.revision), activeRequestId: row.active_request_id,
    ...(row.pending_interaction ? { pendingInteraction: row.pending_interaction } : {}),
    ...(row.response_delivery ? { responseDelivery: row.response_delivery } : {}),
    ...(row.last_result ? { lastResult: row.last_result } : {}) })
  const repository = {
    activity: { append: async () => undefined, settleKnownByNative: async () => undefined, unfinishedOwners: async () => ({ owners: [], hasMore: false }) },
    active: async () => structuredClone(row), get: async () => state(),
    getWithActivity: async () => ({ ...state(), activitySnapshot: { schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: id }, revision: String(row.revision), active: [], queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } } }),
    // Lifecycle unit fixture; receipt SQL/idempotency is exercised by operator-chat-commands and production replay tests.
    createControlCommands: () => ({ execute: async (_principal: unknown, _source: unknown, _id: string, _key: string, _input: unknown, perform: (mark: () => void) => Promise<unknown>) => perform(() => {}), drain: async () => {} }),
    appendAssistantTextOperation: async (id: string, request: string, operation: ActivityTextOperation) => { void id; void request; void operation; return { status: 'committed' as const, revision: String(row.revision), messageRevision: String(row.revision) } },
    configuration: async () => configuration,
    hasTurn: async (_id: string, requestId: string) => receipts.has(requestId),
    hasMessages: async () => false,
    harnessForMessage: async () => configuration.harness,
    unfinished: async () => row.active_request_id ? [structuredClone(row)] : [],
    beginTurn: async (_id: string, input: SendOperatorMessageRequest, executionOwner: string) => {
      if (executionOwner !== ownerId) throw new Error('Execution owner changed.')
      if (receipts.has(input.requestId)) return { replayed: true, state: state() }
      if (row.active_request_id) throw new Error('Conversation busy.')
      receipts.add(input.requestId); row.active_request_id = input.requestId; row.active_phase = 'accepted'; row.turn_state = 'starting'; change()
      return { replayed: false, state: state() }
    },
    phase: async (_id: string, requestId: string, phase: ConversationRow['active_phase']) => {
      if (row.active_request_id !== requestId || row.cancel_requested) return false
      row.active_phase = phase; change(); return true
    },
    bind: async (_id: string, _requestId: string, version: string, sessionId: string) => {
      row.provider_version = version; row.native_session_id = sessionId; row.active_phase = 'ready'; change()
    },
    submitted: async (_id: string, requestId: string, nativeTurnId: string) => {
      if (row.active_request_id !== requestId || (row.active_native_turn_id && row.active_native_turn_id !== nativeTurnId)) return false
      row.active_native_turn_id = nativeTurnId; row.active_phase = 'submitted'; row.turn_state = row.cancel_requested ? 'canceling' : 'active'; change(); return true
    },
    requestCancel: async () => { row.cancel_requested = true; row.turn_state = 'canceling'; change(); return true },
    pending: async (_id: string, requestId: string, pending?: PendingNativeInteraction) => {
      if (row.active_request_id !== requestId) return
      row.pending_interaction = pending ?? null; row.response_delivery = pending ? 'offered' : null; change()
    },
    uncertain: async (_id: string, requestId: string, message: string) => {
      if (row.active_request_id !== requestId) return
      row.turn_state = 'uncertain'; row.last_error = message; change()
    },
    finish: async (_id: string, requestId: string, result: ExecutionResult) => {
      if (row.active_request_id !== requestId) return false
      finishResults.push(result); row.last_result = result; row.active_request_id = null; row.active_native_turn_id = null; row.active_phase = null
      row.turn_state = result.outcome === 'failed' ? 'error' : 'idle'; row.cancel_requested = false; change(); return true
    },
  }
  return { row, state, finishResults, repository: repository as unknown as PostgresOperatorConversationRepository }
}

/** Only provider I/O is fake. SQL, authority and OperatorChatService stay real in integration tests. */
export class ReviewManager implements NativeHarnessSessionManager {
  readonly harness = 'codex' as const
  turns = 0
  disposals = 0
  attachments = 0
  cancellations: string[] = []
  responses: string[] = []
  cancelAcknowledged = true
  pendingInteraction: PendingNativeInteraction | undefined
  nativeHistory: NativeHistory = { events: [], pendingInteractions: [] }
  readonly session: NativeSessionReference = { harness: 'codex', providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'review-native-session' }
  capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> { throw new Error('Not used by this fixture.') }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('Not used by this fixture.') }
  async createSession() { return this.session }
  async attachSession(session: NativeSessionReference) { this.attachments++; return session }
  async *startTurn(_session: NativeSessionReference, input: NativeTurnInput) {
    this.turns++
    this.nativeHistory = { correlationId: input.clientCorrelationId, nativeTurnId: `review-turn-${this.turns}`,
      events: [], pendingInteractions: this.pendingInteraction ? [this.pendingInteraction] : [] }
    await input.onSubmitted?.(this.nativeHistory.nativeTurnId!)
    if (this.pendingInteraction) yield { type: 'interaction.pending', sequence: 1, occurredAt: new Date().toISOString(), payload: {} }
  }
  async pending() { return this.pendingInteraction }
  async respond(_session: NativeSessionReference, nativeRequestId: string) {
    this.responses.push(nativeRequestId); this.pendingInteraction = undefined; this.nativeHistory.pendingInteractions = []
  }
  async cancel(_session: NativeSessionReference, _signal?: AbortSignal, nativeTurnId?: string) {
    if (!nativeTurnId || nativeTurnId !== this.nativeHistory.nativeTurnId) throw new Error('Cancellation was not scoped to the exact native turn.')
    this.cancellations.push(nativeTurnId)
    if (!this.cancelAcknowledged) return false
    this.pendingInteraction = undefined; this.nativeHistory.pendingInteractions = []; this.nativeHistory.terminalResult = { outcome: 'canceled' }
    return true
  }
  async history() { return this.nativeHistory }
  async reconcile() { return this.nativeHistory }
  async close() { this.disposals++ }
  async dispose() { this.disposals++ } // Deliberately does not invent a native terminal result.
}
