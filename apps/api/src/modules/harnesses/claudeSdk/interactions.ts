import type { ClaudeLiveCallbackQuery } from './callbackAvailability.js'
import type { NativeResponseAvailability } from '../responseAvailability.js'
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
  attemptId: string
  toolUseId: string
  /** Control request ID, distinct from tool_use and message IDs; absent on PreToolUse hooks. */
  nativeRequestId?: string
  agentId?: string
  parentToolUseId?: string
}
export type ClaudeToolDecision = { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean }
export type ClaudeInteractionAnswer = { outcome: 'allow_once' | 'deny' | 'cancel' | 'expired' }
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
  }>()
  private readonly controller = new AbortController()
  constructor(configuration: ClaudeHarnessConfiguration, private readonly authority: ClaudeInteractionAuthority) {
    this.configuration = structuredClone(configuration)
  }
  close(): void { this.controller.abort() }

  /** Inspect only the owned SDK callback map; availability is never delivery evidence. */
  inspectCallbackAvailability(query: ClaudeLiveCallbackQuery): NativeResponseAvailability {
    const base = { nativeSessionId: query.nativeSessionId, nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType }
    const unavailable = (reason: NativeResponseAvailability['reason']): NativeResponseAvailability => ({ ...base, qualified: false, state: 'unavailable', path: null, reason })
    if (this.controller.signal.aborted) return unavailable('callback_lost')
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
    return { ...base, ...(request.identity.nativeTurnId ? { nativeTurnId: request.identity.nativeTurnId } : {}), generation: query.generation,
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }
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
      if (current?.stage === 'pending' && !combined.aborted) current.stage = 'response_in_flight'
    }))
    const promise = Promise.race([resolving, aborted]).finally(() => {
      if (onAbort) combined.removeEventListener('abort', onAbort)
    })
    const entry = { input: value, promise, identity: structuredClone(identity), signal: combined, stage: 'pending' as 'pending' | 'response_in_flight' | 'consumed' }
    this.requests.set(key, entry)
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
      return { behavior: 'deny', message: `The interaction was ${answer.outcome}.`, ...(answer.outcome === 'cancel' ? { interrupt: true } : {}) }
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }
}
