import { PendingNativeInteractionSchema, type PendingNativeInteraction, type NativeSessionReference, type ApprovalResponseOption } from '@graphql/contracts'
import type { ClaudeLiveCallbackQuery, ClaudeResponseAvailability } from './callbackAvailability.js'
import { ClaudeQuestionInputSchema, ClaudeQuestionAnswersSchema, type ClaudeHarnessConfiguration } from '@graphql/contracts/claude'
import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionError } from '../errors.js'

export interface ClaudeCallbackIdentity {
  /** Current owned SDK callback lifetime, supplied by the native manager. */
  generation?: string
  nativeRequestType?: 'can_use_tool'
  ownerPrincipalId: string
  nativeSessionId: string
  nativeTurnId?: string
  nativeMessageId?: string
  clientCorrelationId?: string
  attemptId: string
  toolUseId: string
  /** Control request ID, distinct from tool_use and message IDs; absent on PreToolUse hooks. */
  nativeRequestId?: string
  agentId?: string
  parentToolUseId?: string
}
export interface ClaudePendingNotification {
  nativeSessionId: string; nativeMessageId: string; clientCorrelationId: string; generation: string
  nativeRequestId: string; nativeRequestType: 'can_use_tool'
}
export type ClaudeToolDecision = { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
export type ClaudeInteractionAnswer = { outcome: 'allow_once' | 'deny' | 'cancel' | 'expired'; reason?: string }
  | { outcome: 'answered'; answers: unknown }
/** Consumer binds these operations to existing persistence/claim/delivery services, not a second store. */
export interface ClaudeInteractionAuthority {
  validate(identity: ClaudeCallbackIdentity, toolName: string, input: Record<string, unknown>): Promise<void>
  request(identity: ClaudeCallbackIdentity, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeInteractionAnswer>
  /** Re-fetch current principal, grants, revision and selected response under its delivery claim. */
  validateResponse(identity: ClaudeCallbackIdentity, answer: ClaudeInteractionAnswer): Promise<void>
}

export class ClaudeInteractionBridge {
  private readonly configuration: ClaudeHarnessConfiguration
  private readonly requests = new Map<string, {
    input: unknown; promise: Promise<ClaudeToolDecision>; identity: ClaudeCallbackIdentity; signal: AbortSignal
    stage: 'pending' | 'response_in_flight' | 'consumed'
    response?: { promise: Promise<ClaudeInteractionAnswer>; resolve(answer: ClaudeInteractionAnswer): void; selected?: ClaudeInteractionAnswer }
  }>()
  private readonly controller = new AbortController()
  private readonly listeners = new Set<(notification: ClaudePendingNotification) => void>()
  constructor(configuration: ClaudeHarnessConfiguration, private readonly authority: ClaudeInteractionAuthority) {
    this.configuration = structuredClone(configuration)
  }
  close(): void { this.controller.abort() }
  subscribePending(listener: (notification: ClaudePendingNotification) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private changed(identity: ClaudeCallbackIdentity): void {
    if (!identity.nativeMessageId || !identity.clientCorrelationId || !identity.generation || !identity.nativeRequestId || identity.nativeRequestType !== 'can_use_tool') return
    const notification: ClaudePendingNotification = { nativeSessionId: identity.nativeSessionId, nativeMessageId: identity.nativeMessageId,
      clientCorrelationId: identity.clientCorrelationId, generation: identity.generation, nativeRequestId: identity.nativeRequestId, nativeRequestType: identity.nativeRequestType }
    for (const listener of this.listeners) listener(notification)
  }

  /** Inspect only the owned SDK callback map; availability is never delivery evidence. */
  inspectCallbackAvailability(query: ClaudeLiveCallbackQuery): ClaudeResponseAvailability {
    const base = { nativeSessionId: query.nativeSessionId, nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType }
    const unavailable = (reason: ClaudeResponseAvailability['reason']): ClaudeResponseAvailability => ({ ...base, qualified: false, state: 'unavailable', path: null, reason })
    if (this.controller.signal.aborted) return unavailable('callback_lost')
    if (query.expectedNativeMessageId !== undefined && query.expectedNativeMessageId !== query.nativeMessageId
      || query.expectedGeneration !== undefined && query.expectedGeneration !== query.generation) return unavailable('identity_mismatch')
    if (!query.nativeSessionId || !query.nativeMessageId || !query.generation || query.nativeRequestType !== 'can_use_tool') return unavailable('identity_mismatch')
    const candidates = [...this.requests.values()].filter((entry) => entry.identity.nativeRequestId === query.nativeRequestId)
    const matches = candidates.filter(({ identity }) => identity.nativeSessionId === query.nativeSessionId
      && identity.nativeMessageId === query.nativeMessageId && identity.generation === query.generation
      && identity.nativeRequestType === query.nativeRequestType
      && (query.expectedNativeTurnId === undefined || identity.nativeTurnId === query.expectedNativeTurnId))
    if (matches.length !== 1) return unavailable(candidates.length ? 'identity_mismatch' : 'callback_lost')
    const request = matches[0]!
    if (request.signal.aborted) return unavailable('callback_lost')
    if (request.stage === 'consumed') return unavailable('request_consumed')
    if (request.stage === 'response_in_flight') return unavailable('response_in_flight')
    return { ...base, nativeMessageId: query.nativeMessageId, ...(request.identity.nativeTurnId ? { nativeTurnId: request.identity.nativeTurnId } : {}), generation: query.generation,
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }
  }

  private live(identity: ClaudeCallbackIdentity) {
    const entries = [...this.requests.values()].filter((entry) => isDeepStrictEqual(entry.identity, identity))
    if (entries.length !== 1 || this.controller.signal.aborted || entries[0]!.signal.aborted) throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The exact SDK callback is not live.')
    return entries[0]!
  }

  pendingInteractions(session: NativeSessionReference): PendingNativeInteraction[] {
    if (this.controller.signal.aborted) return []
    return [...this.requests.values()].filter((entry) => entry.stage !== 'consumed' && !entry.signal.aborted
      && entry.identity.nativeSessionId === session.nativeSessionId && (entry.input as { toolName: string }).toolName !== 'AskUserQuestion')
      .map((entry) => PendingNativeInteractionSchema.parse({ session,
        turn: { ...(entry.identity.nativeTurnId ? { nativeTurnId: entry.identity.nativeTurnId } : { nativeMessageId: entry.identity.nativeMessageId }), nativeRequestId: entry.identity.nativeRequestId },
        nativeRequestType: entry.identity.nativeRequestType,
        request: { ...(entry.input as { toolName: string; input: Record<string, unknown> }), nativeMessageId: entry.identity.nativeMessageId,
          toolUseId: entry.identity.toolUseId, generation: entry.identity.generation, attemptId: entry.identity.attemptId },
        responseOptions: ['allow_once', 'deny', 'cancel'].map((optionId) => ({ optionId, semantic: optionId === 'allow_once' ? 'approve_once' : optionId === 'deny' ? 'reject' : 'cancel',
          label: optionId === 'allow_once' ? 'Allow once' : optionId === 'deny' ? 'Deny' : 'Cancel', persistence: 'request',
          affectsOtherPendingRequests: false, interruptsCurrentTurn: optionId === 'cancel', mutatesPersistentPolicy: false })) }))
  }

  /** Wait on the already-owned SDK callback; no new persistence or permission request is created. */
  waitForResponse(identity: ClaudeCallbackIdentity): Promise<ClaudeInteractionAnswer> {
    const entry = this.live(identity)
    if (entry.stage === 'consumed') throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The SDK callback was consumed.')
    if (!entry.response) {
      let resolve!: (answer: ClaudeInteractionAnswer) => void
      const promise = new Promise<ClaudeInteractionAnswer>((finish) => { resolve = finish })
      entry.response = { promise, resolve }
      const abort = () => resolve({ outcome: 'cancel' })
      entry.signal.addEventListener('abort', abort, { once: true })
      void promise.then(() => entry.signal.removeEventListener('abort', abort))
    }
    return entry.response.promise
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const pending = this.pendingInteractions(session).find((item) => item.turn.nativeRequestId === nativeRequestId)
    if (!pending || !pending.responseOptions.some((offered) => isDeepStrictEqual(offered, option))) throw new HarnessExecutionError('NATIVE_RESPONSE_OPTION_INVALID', 'The exact callback did not offer this option.')
    const entries = [...this.requests.values()].filter((entry) => entry.identity.nativeSessionId === session.nativeSessionId && entry.identity.nativeRequestId === nativeRequestId)
    if (entries.length !== 1) throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The native control identity is ambiguous.')
    const entry = this.live(entries[0]!.identity)
    if (entry.stage !== 'pending' || entry.response?.selected) throw new HarnessExecutionError('NATIVE_RESPONSE_UNCERTAIN', 'A response is already in flight; join observation without resending.')
    const answer: ClaudeInteractionAnswer = { outcome: option.optionId as 'allow_once' | 'deny' | 'cancel' }
    await this.authority.validateResponse(entry.identity, answer)
    signal?.throwIfAborted()
    this.live(entry.identity)
    if (entry.stage !== 'pending' || entry.response?.selected) throw new HarnessExecutionError('NATIVE_RESPONSE_UNCERTAIN', 'The response already entered the SDK callback.')
    void this.waitForResponse(entry.identity)
    entry.response!.selected = answer
    entry.response!.resolve(answer)
    await entry.promise
  }

  /** Join only this SDK map's existing response listener. Never resubmit a permission reply. */
  async observeResponse(session: NativeSessionReference, requestId: string, option: ApprovalResponseOption, signal?: AbortSignal) {
    const entries = [...this.requests.values()].filter((entry) => entry.identity.nativeSessionId === session.nativeSessionId && entry.identity.nativeRequestId === requestId)
    if (entries.length !== 1 || this.controller.signal.aborted) return { nativeRequestId: requestId, state: 'uncertain' as const }
    const entry = entries[0]!
    if (!entry.response?.selected) return { nativeRequestId: requestId, state: 'pending' as const }
    if (entry.response.selected.outcome !== option.optionId) throw new HarnessExecutionError('NATIVE_RESPONSE_OPTION_INVALID', 'The observed callback belongs to another selected option.')
    signal?.throwIfAborted()
    let abort: (() => void) | undefined
    const canceled = new Promise<never>((_resolve, reject) => {
      if (!signal) return
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const decision = await Promise.race([entry.promise, canceled])
      if (entry.signal.aborted || option.optionId === 'allow_once' && decision.behavior !== 'allow') return { nativeRequestId: requestId, state: 'uncertain' as const }
      return { nativeRequestId: requestId, state: 'submitted' as const, selectedOptionId: option.optionId }
    } finally { if (abort) signal?.removeEventListener('abort', abort) }
  }

  /** Install only as the pinned release's qualified always-applied PreToolUse hook. */
  async beforeToolUse(identity: ClaudeCallbackIdentity, toolName: string, input: Record<string, unknown>): Promise<{ permissionDecision?: 'deny' | 'ask'; permissionDecisionReason?: string }> {
    identity = structuredClone(identity); input = structuredClone(input)
    if (![identity.ownerPrincipalId, identity.nativeSessionId, identity.nativeTurnId ?? identity.nativeMessageId, identity.attemptId, identity.toolUseId].every(Boolean)) {
      return { permissionDecision: 'deny', permissionDecisionReason: 'The callback requires exact admitted native identity.' }
    }
    if (this.controller.signal.aborted || (identity.parentToolUseId || identity.agentId) || !this.configuration.tools.includes(toolName)
      || this.configuration.permissionRules.some((rule) => rule.tool === toolName && rule.effect === 'deny')) {
      return { permissionDecision: 'deny', permissionDecisionReason: 'The accepted Claude policy does not authorize this tool call.' }
    }
    try { await this.authority.validate(identity, toolName, input) }
    catch { return { permissionDecision: 'deny', permissionDecisionReason: 'The current app authority does not authorize this tool call.' } }
    if (this.controller.signal.aborted) return { permissionDecision: 'deny', permissionDecisionReason: 'The native callback was aborted.' }
    return toolName === 'AskUserQuestion' || this.configuration.permissionRules.some((rule) => rule.tool === toolName && rule.effect === 'ask')
      ? { permissionDecision: 'ask', permissionDecisionReason: 'The accepted configuration routes this interaction through the app.' } : {}
  }

  async canUseTool(identity: ClaudeCallbackIdentity, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ClaudeToolDecision> {
    identity = structuredClone(identity); input = structuredClone(input)
    if (signal.aborted || this.controller.signal.aborted) return { behavior: 'deny', message: 'The native callback was aborted.', interrupt: true }
    if (identity.parentToolUseId || identity.agentId) return { behavior: 'deny', message: 'Child approvals have not been qualified.' }
    for (const value of [identity.ownerPrincipalId, identity.nativeSessionId, identity.nativeTurnId ?? identity.nativeMessageId, identity.attemptId, identity.toolUseId, identity.nativeRequestId, identity.generation]) {
      if (!value) throw new HarnessExecutionError('CLAUDE_CALLBACK_IDENTITY_REQUIRED', 'The callback requires exact admitted native identity.')
    }
    if (identity.nativeRequestType !== 'can_use_tool') throw new HarnessExecutionError('CLAUDE_CALLBACK_IDENTITY_REQUIRED', 'The callback requires the actual native permission request type.')
    await this.authority.validate(identity, toolName, input)
    if (signal.aborted || this.controller.signal.aborted) return { behavior: 'deny', message: 'The native callback was aborted.', interrupt: true }
    if (!this.configuration.tools.includes(toolName)) return { behavior: 'deny', message: 'The tool is not available in the accepted configuration.' }
    if (this.configuration.permissionRules.some((rule) => rule.tool === toolName && rule.effect === 'deny')) return { behavior: 'deny', message: 'The accepted policy denies this tool.' }
    const key = JSON.stringify([identity.ownerPrincipalId, identity.nativeSessionId, identity.nativeTurnId ?? null,
      identity.nativeMessageId ?? null, identity.attemptId, identity.toolUseId, identity.nativeRequestId,
      identity.parentToolUseId ?? null, identity.agentId ?? null, identity.generation, identity.nativeRequestType])
    const value = { toolName, input: structuredClone(input) }
    const previous = this.requests.get(key)
    if (previous) {
      if (!isDeepStrictEqual(previous.input, value)) throw new HarnessExecutionError('CLAUDE_CALLBACK_CONFLICT', 'The native request identity was reused with different input.')
      return previous.promise
    }
    const combined = AbortSignal.any([signal, this.controller.signal])
    let onAbort: (() => void) | undefined
    const aborted = new Promise<ClaudeToolDecision>((finish) => {
      onAbort = () => finish({ behavior: 'deny', message: 'The native callback was aborted.', interrupt: true })
      if (combined.aborted) onAbort(); else combined.addEventListener('abort', onAbort, { once: true })
    })
    const resolving = Promise.resolve().then(() => this.resolve(identity, toolName, value.input, combined, () => {
      const current = this.requests.get(key)
      if (current?.stage === 'pending' && !combined.aborted) { current.stage = 'response_in_flight' }
    }))
    const promise = Promise.race([resolving, aborted]).finally(() => {
      if (onAbort) combined.removeEventListener('abort', onAbort)
    })
    const entry = { input: value, promise, identity: structuredClone(identity), signal: combined, stage: 'pending' as 'pending' | 'response_in_flight' | 'consumed' }
    this.requests.set(key, entry)
    if (toolName !== 'AskUserQuestion') this.changed(identity)
    void promise.then(() => { entry.stage = 'consumed' }, () => { entry.stage = 'consumed' })
    return promise
  }

  private async resolve(identity: ClaudeCallbackIdentity, toolName: string, input: Record<string, unknown>, signal: AbortSignal, onAnswer: () => void): Promise<ClaudeToolDecision> {
    if (signal.aborted) return { behavior: 'deny', message: 'The native callback was aborted.', interrupt: true }
    // The always-applied native hook must enforce the same accepted policy for auto-approved native calls.
    const request = toolName === 'AskUserQuestion' ? ClaudeQuestionInputSchema.parse(input) : input
    let abort: (() => void) | undefined
    const aborted = new Promise<ClaudeInteractionAnswer>((resolve) => {
      abort = () => resolve({ outcome: 'cancel' })
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const answer = await Promise.race([this.authority.request(identity, toolName, request, signal), aborted])
      onAnswer()
      if (signal.aborted) return { behavior: 'deny', message: 'The native callback was aborted.', interrupt: true }
      await this.authority.validate(identity, toolName, input)
      if (answer.outcome === 'deny' && answer.reason) return { behavior: 'deny', message: answer.reason }
      await this.authority.validateResponse(identity, answer)
      if (signal.aborted) return { behavior: 'deny', message: 'The native callback was aborted.', interrupt: true }
      if (toolName === 'AskUserQuestion' && answer.outcome === 'answered') {
        const questions = ClaudeQuestionInputSchema.parse(input).questions
        const values = ClaudeQuestionAnswersSchema.parse(answer.answers)
        if (Object.keys(values).length !== questions.length || questions.some((question) => !Object.hasOwn(values, question.question))) {
          throw new HarnessExecutionError('CLAUDE_QUESTION_ANSWER_INVALID', 'Answers must address the exact native questions.')
        }
        const answers: Record<string, string> = {}
        for (const question of questions) {
          const value = values[question.question]!
          if ((!question.multiSelect && value.selected.length > 1) || new Set(value.selected).size !== value.selected.length
            || value.selected.some((label) => !question.options.some((option) => option.label === label))
            || (!value.selected.length && !value.freeText?.trim())) throw new HarnessExecutionError('CLAUDE_QUESTION_ANSWER_INVALID', 'The selected answer is invalid for this native question.')
          answers[question.question] = [...value.selected, ...(value.freeText ? [value.freeText] : [])].join(', ')
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } }
      }
      if (toolName !== 'AskUserQuestion' && answer.outcome === 'allow_once') return { behavior: 'allow', updatedInput: structuredClone(input) }
      return { behavior: 'deny', message: ('reason' in answer ? answer.reason : undefined) ?? `The interaction was ${answer.outcome}.`, ...(answer.outcome === 'cancel' ? { interrupt: true } : {}) }
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }
}
