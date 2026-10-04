import type { CompactionState, ContextSnapshot, SessionMode } from '@graphql/contracts'
import type { OpenCodeMessage } from './opencodeProtocol.js'

export function openCodeSessionAgent(mode: SessionMode | undefined, regularAgent: string): string {
  return mode === 'plan' ? 'plan' : regularAgent
}

export function openCodeCompactionResult(state: CompactionState, messages: readonly OpenCodeMessage[]): CompactionState {
  const baseline = messages.findIndex(message => message.info.id === state.nativeOperationId)
  if (baseline < 0) return state
  const later = messages.slice(baseline + 1)
  const manual = later.filter(message => message.info.sessionID === state.nativeSessionId
    && message.parts.some(part => part.type === 'compaction' && part.auto === false))
  if (manual.length !== 1) return state
  const answer = later.find(message => message.info.role === 'assistant' && message.info.summary === true
    && message.info.parentID === manual[0]!.info.id && message.info.sessionID === state.nativeSessionId)
  if (!answer || !answer.info.finish) return state
  return { ...state, status: answer.info.error ? 'failed' : 'completed',
    message: answer.info.error ? 'OpenCode compaction failed.' : 'Context compacted.', observedAt: new Date().toISOString() }
}

export function openCodeContextSnapshot(messages: readonly OpenCodeMessage[], sessionId: string,
  model: string, capacity: number | null): ContextSnapshot | null {
  const selected = [...messages].reverse().find(message => message.info.sessionID === sessionId
    && message.info.role === 'assistant' && message.info.summary !== true && message.info.finish)
  if (!selected) return null
  const tokens = selected.info.tokens as { input?: number; output?: number; cache?: { read?: number; write?: number } } | undefined
  if (!tokens || typeof tokens.input !== 'number' || typeof tokens.output !== 'number') return null
  const time = selected.info.time as { created?: number; completed?: number } | undefined
  const sequence = time?.completed ?? time?.created ?? 0
  return { nativeSessionId: sessionId, model, sequence, observedAt: new Date().toISOString(), source: 'opencode',
    accuracy: 'estimated', usedTokens: tokens.input + tokens.output + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
    capacityTokens: capacity, lifetimeTokens: null, cost: null,
    stale: messages.some(message => message.info.summary === true && Number((message.info.time as { created?: number })?.created) > sequence) }
}
