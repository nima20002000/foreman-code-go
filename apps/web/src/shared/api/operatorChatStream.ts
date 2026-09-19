import { OperatorConversationStateSchema, OperatorConversationStreamEventSchema,
  type OperatorConversationState, type OperatorConversationStreamEvent } from '@graphql/contracts'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal } from './sessionBoundary'

export type OperatorChatConnection = 'connecting' | 'connected' | 'reconnecting' | 'unavailable'

export function subscribeOperatorChat(id: string, listeners: {
  snapshot(state: OperatorConversationState): void
  event(event: OperatorConversationStreamEvent): void
  reconnect(): void
  connection?(state: OperatorChatConnection): void
}): () => void {
  if (sessionIsSwitching()) return () => {}
  if (typeof EventSource === 'undefined') {
    listeners.connection?.('unavailable')
    return () => {}
  }
  const generation = sessionGeneration()
  const signal = sessionSignal()
  listeners.connection?.('connecting')
  const source = new EventSource(`/api/operator/conversations/${encodeURIComponent(id)}/events`)
  let closed = false
  const close = () => { if (!closed) { closed = true; source.close(); signal.removeEventListener('abort', close) } }
  const valid = () => {
    try { assertSession(generation); return !closed } catch { close(); return false }
  }
  const refresh = () => {
    listeners.connection?.(source.readyState === EventSource.CLOSED ? 'unavailable' : 'reconnecting')
    listeners.reconnect()
  }
  source.addEventListener('open', () => {
    if (!valid()) return
    listeners.connection?.('connected')
    listeners.reconnect()
  })
  source.addEventListener('snapshot', (event: MessageEvent<string>) => {
    if (!valid()) return
    try {
      const state = OperatorConversationStateSchema.parse(JSON.parse(event.data))
      if (state.conversation.id !== id) { refresh(); return }
      listeners.snapshot(state)
      listeners.connection?.('connected')
    } catch { refresh() }
  })
  for (const type of ['delta', 'message', 'state', 'error', 'activity']) source.addEventListener(type, (event: Event) => {
    if (!valid()) return
    // A transport error has no payload. A provider's JSON "error" event is
    // still a live connection and must not be mistaken for a stopped run.
    if (!('data' in event) || typeof event.data !== 'string') { refresh(); return }
    try {
      const data = OperatorConversationStreamEventSchema.parse(JSON.parse(event.data))
      if (data.conversationId !== id) { refresh(); return }
      listeners.event(data)
      listeners.connection?.('connected')
    } catch { refresh() }
  })
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return close
}
