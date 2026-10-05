import { WorkerClaudeCallbackIdentitySchema, WorkerClaudeCallbackAuthoritySchema, WorkerClaudeAuthorizationSchema,
  type WorkerClaudeAuthorityRequest, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'
import { isDeepStrictEqual } from 'node:util'
import type { NativeInitialTurnInput, NativeTurnInput } from '../harnesses/port.js'
import { ClaudeInteractionBridge } from '../harnesses/claudeSdk/interactions.js'
import type { ClaudeCallbackIdentity } from '../harnesses/claudeSdk/interactions.js'
import type { ClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import { DomainError } from '../errors.js'

interface AdmittedMessage {
  request: WorkerConversationRpcRequest
  authority: ReturnType<typeof WorkerClaudeCallbackAuthoritySchema.parse>
  submission?: NativeMessageSubmission
}

/** The SDK callback stays on its worker; Main alone authorizes its message and persisted response. */
export function createWorkerClaudeAuthority(input: {
  configuration: ClaudeHarnessConfiguration
  version: string
  signal: AbortSignal
  source(): WorkerConversationRpcRequest
  request(source: WorkerConversationRpcRequest, request: WorkerClaudeAuthorityRequest,
    signal: AbortSignal): Promise<unknown>
}) {
  const sources = new Map<string, AdmittedMessage>()
  const sourceFor = (identity: ClaudeCallbackIdentity) => {
    const source = identity.clientCorrelationId && sources.get(identity.clientCorrelationId)
    if (!source) throw new DomainError('CLAUDE_CALLBACK_SCOPE_DENIED', 'The native callback has no admitted message.', 409)
    return source.request
  }
  const authorize = async (source: WorkerConversationRpcRequest, request: WorkerClaudeAuthorityRequest,
    signal: AbortSignal) => WorkerClaudeAuthorizationSchema.parse(await input.request(source, request, signal))
  const bridge: ClaudeInteractionBridge = new ClaudeInteractionBridge(input.configuration, {
    async validate(identity) {
      await authorize(sourceFor(identity), { phase: 'validate',
        identity: WorkerClaudeCallbackIdentitySchema.parse(identity) }, input.signal)
    },
    async request(identity, toolName, _value, signal) {
      if (toolName === 'AskUserQuestion') return { outcome: 'deny',
        reason: 'Structured native question answers are not supported by the persisted response contract.' }
      const pending = bridge.pendingInteractions({ harness: 'claude', providerVersion: input.version,
        nativeSessionId: identity.nativeSessionId }).find(item => item.turn.nativeRequestId === identity.nativeRequestId)
      if (!pending) throw new DomainError('CLAUDE_CALLBACK_SCOPE_DENIED', 'The SDK callback is unavailable.', 409)
      await authorize(sourceFor(identity), { phase: 'pending',
        identity: WorkerClaudeCallbackIdentitySchema.parse(identity), pending }, signal)
      return bridge.waitForResponse(identity)
    },
    async validateResponse(identity, answer) {
      if (answer.outcome === 'answered') throw new DomainError('CLAUDE_RESPONSE_CONTRACT_UNSUPPORTED',
        'Structured native question answers are not supported by the persisted response contract.', 409)
      await authorize(sourceFor(identity), { phase: 'response',
        identity: WorkerClaudeCallbackIdentitySchema.parse(identity),
        answer: { outcome: answer.outcome, ...(answer.reason !== undefined ? { reason: answer.reason } : {}) },
      }, input.signal)
    },
  })
  const turn = async (message: NativeTurnInput) => {
    const source = input.source()
    if (!['conversation.initial-turn', 'conversation.start-turn'].includes(source.method)
      || !('correlationId' in source) || source.correlationId !== message.clientCorrelationId) {
      throw new DomainError('CLAUDE_CALLBACK_SCOPE_DENIED', 'The message differs from its paired admission.', 409)
    }
    const authority = WorkerClaudeCallbackAuthoritySchema.parse(await input.request(source,
      { phase: 'admission' }, input.signal))
    const admitted: AdmittedMessage = { request: source, authority }
    sources.set(message.clientCorrelationId, admitted)
    return { ...message, callbackAuthority: authority, onMessageSubmitted: async (submission: NativeMessageSubmission) => {
      await message.onMessageSubmitted?.(submission)
      admitted.submission = structuredClone(submission)
    } }
  }
  return { bridge,
    async recover(source: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }>,
      submission: NativeMessageSubmission, signal: AbortSignal) {
      signal.throwIfAborted()
      const admitted = sources.get(submission.clientCorrelationId)
      if (!admitted) return
      if (source.method !== 'conversation.reconcile' || source.correlationId !== submission.clientCorrelationId
        || source.session.nativeSessionId !== submission.nativeSessionId
        || !isDeepStrictEqual(source.binding, admitted.request.binding)
        || !isDeepStrictEqual(submission, admitted.submission)) {
        throw new DomainError('CLAUDE_CALLBACK_SCOPE_DENIED', 'Recovery differs from the owned native message.', 409)
      }
      const authority = WorkerClaudeCallbackAuthoritySchema.parse(await input.request(source,
        { phase: 'admission' }, signal))
      if (!isDeepStrictEqual(authority, admitted.authority)) throw new DomainError('CLAUDE_CALLBACK_SCOPE_DENIED',
        'The original native sender or request changed during recovery.', 409)
      signal.throwIfAborted()
      admitted.request = source
    },
    bind(manager: ClaudeNativeSessionManager) {
      bridge.subscribePending(notification => manager.notifyPendingChanged(notification))
      const initial = manager.startInitialTurn.bind(manager)
      manager.startInitialTurn = async function* (start, message: NativeInitialTurnInput, signal) {
        const prepared = { ...await turn(message), onSessionObserved: message.onSessionObserved }
        try { yield* initial(start, prepared, signal) }
        finally { sources.delete(message.clientCorrelationId) }
      }
      const startTurn = manager.startTurn.bind(manager)
      manager.startTurn = async function* (session, message, signal) {
        const prepared = await turn(message)
        try { yield* startTurn(session, prepared, signal) }
        finally { sources.delete(message.clientCorrelationId) }
      }
    },
    interactionPort: {
      async pending(session: import('@foreman-code/contracts').NativeSessionReference, signal?: AbortSignal) {
        signal?.throwIfAborted()
        return bridge.pendingInteractions(session)[0]
      },
      respond: bridge.respond.bind(bridge),
      async reconcileResponse(session: import('@foreman-code/contracts').NativeSessionReference,
        response: { nativeRequestId: string; option: import('@foreman-code/contracts').ApprovalResponseOption }, signal?: AbortSignal) {
        const observation = await bridge.observeResponse(session, response.nativeRequestId, response.option, signal)
        return { events: [], pendingInteractions: bridge.pendingInteractions(session),
          interactionDeliveries: [observation], responseDeliveries: [] }
      },
      stopAutomaticResponses: () => bridge.close(),
    },
  }
}
