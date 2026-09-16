import { createHash } from 'node:crypto'

import type { NativeSessionReference } from '@graphql/contracts'

import type { NativeHistory } from '../harnesses/port.js'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export interface TurnEvidence {
  acknowledged: boolean
  terminal: boolean
  nativeIdle: boolean
  nativeBusy: boolean
  providerId?: string
}

/** Only exact provider identities count. A reconcile request echo or an old result does not. */
export function reviewTurnEvidence(
  session: NativeSessionReference,
  history: NativeHistory,
  correlationId: string,
  knownProviderId?: string,
): TurnEvidence {
  let providerId = knownProviderId
  const messageId = session.harness === 'opencode' && session.providerVersion === '1.18.31'
    ? `msg_${createHash('sha256').update(correlationId).digest('hex').slice(0, 24)}` : undefined
  let acknowledged = Boolean(knownProviderId)
  let terminal = false
  let nativeIdle = false
  let nativeBusy = false
  let completedAssistant = false
  for (const event of history.events) {
    const payload = event.payload
    if ((typeof payload.threadId === 'string' && payload.threadId !== session.nativeSessionId)
      || (typeof payload.sessionID === 'string' && payload.sessionID !== session.nativeSessionId)) continue
    const turn = object(payload.turn)
    const turnId = typeof payload.turnId === 'string' ? payload.turnId : typeof turn.id === 'string' ? turn.id : undefined
    if (event.type === 'turn.started' || event.type === 'turn/started') {
      nativeIdle = false
      nativeBusy = true
      if (payload.clientCorrelationId === correlationId && turnId && (!providerId || providerId === turnId)) {
        providerId = turnId
        acknowledged = true
      }
    }
    if ((event.type === 'turn.completed' || event.type === 'turn/completed')
      && turnId && providerId === turnId) {
      terminal = true
      nativeIdle = true
      nativeBusy = false
    }
    if (event.type === 'thread.reconciled' || event.type === 'thread.attached') {
      const thread = object(payload.thread)
      if (thread.id !== session.nativeSessionId || !Array.isArray(thread.turns)) continue
      // The correlationId on thread.reconciled is only our query, not provider acknowledgement.
      for (const value of thread.turns) {
        const candidate = object(value)
        const items = Array.isArray(candidate.items) ? candidate.items.map(object) : []
        const matches = providerId !== undefined ? candidate.id === providerId
          : candidate.clientUserMessageId === correlationId
            || items.some((item) => item.clientUserMessageId === correlationId)
        if (!matches || typeof candidate.id !== 'string') continue
        providerId = candidate.id
        acknowledged = true
        terminal = ['completed', 'failed', 'interrupted'].includes(String(candidate.status))
      }
      const last = object(thread.turns.at(-1))
      const status = object(thread.status).type ?? thread.status
      nativeIdle = status === 'idle' && (thread.turns.length === 0
        || ['completed', 'failed', 'interrupted'].includes(String(last.status)))
      nativeBusy = status === 'active' || last.status === 'inProgress'
      if (terminal && last.id === providerId && !nativeBusy) nativeIdle = true
    }
    if (event.type === 'message.updated' && messageId && (!providerId || providerId === messageId)) {
      const info = object(payload.info)
      if (info.sessionID !== session.nativeSessionId) continue
      if ((info.role === 'user' && info.id === messageId)
        || (info.role === 'assistant' && info.parentID === messageId)) {
        providerId = messageId
        acknowledged = true
        nativeIdle = false
        nativeBusy = true
        if (info.role === 'assistant' && typeof object(info.time).completed === 'number') {
          completedAssistant = true
          if (['stop', 'length', 'content-filter'].includes(String(info.finish)) || info.error) {
            terminal = true
            nativeBusy = false
            nativeIdle = true
          }
        }
      }
    }
    // Session status can refresh a stale lane, but cannot identify which review finished.
    if (event.type === 'session.idle' || (event.type === 'session.status' && object(payload.status).type === 'idle')) {
      if (completedAssistant) terminal = true
      nativeIdle = true
      nativeBusy = false
    }
    if (event.type === 'session.status' && ['busy', 'retry'].includes(String(object(payload.status).type))) {
      nativeIdle = false
      nativeBusy = true
    }
  }
  if (history.pendingInteractions.length) {
    nativeIdle = false
    nativeBusy = true
  }
  return { acknowledged, terminal, nativeIdle, nativeBusy, ...(providerId ? { providerId } : {}) }
}

export function definitelyRejected(error: unknown): boolean {
  const failure = object(error)
  const code = object(object(failure.result).error).code ?? failure.code
  // A definite SSE/history failure says nothing about an earlier prompt mutation.
  return failure.certainty === 'definite' && code === 'OPENCODE_NATIVE_DELIVERY_REJECTED'
}
