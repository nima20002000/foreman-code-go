import { OperatorConversationStateSchema, OperatorConversationStreamEventSchema,
  type OperatorConversationState, type OperatorConversationStreamEvent } from '@foreman-code/contracts'
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
  let ready = false, highWater = -1
  const seen = new Set<number>()
  const bindings: Array<[string, EventListener]> = []
  const source = new EventSource(`/api/operator/conversations/${encodeURIComponent(id)}/events`)
  let closed = false
  const close = () => { if (!closed) { closed = true; for (const [type, listener] of bindings) source.removeEventListener(type, listener); source.close(); signal.removeEventListener('abort', close) } }
  const valid = () => {
    try { assertSession(generation); return !closed && !signal.aborted } catch { close(); return false }
  }
  const refresh = () => {
    if (!valid()) return
    ready = false
    listeners.connection?.(source.readyState === EventSource.CLOSED ? 'unavailable' : 'reconnecting')
    if (valid()) listeners.reconnect()
  }
  const bind = (type: string, listener: EventListener) => { bindings.push([type, listener]); source.addEventListener(type, listener) }
  bind('open', () => {
    if (!valid()) return
    ready = false; highWater = -1; seen.clear()
    listeners.connection?.('reconnecting')
    if (valid()) listeners.reconnect()
  })
  bind('snapshot', (wire: Event) => {
    const event = wire as MessageEvent<string>
    if (!valid()) return
    try {
      const state = OperatorConversationStateSchema.parse(JSON.parse(event.data))
      if (state.conversation.id !== id) { refresh(); return }
      ready = true; highWater = -1; seen.clear()
      listeners.snapshot(state)
      if (valid()) listeners.connection?.('connected')
    } catch { refresh() }
  })
  for (const type of ['delta', 'message', 'state', 'error', 'activity']) bind(type, (event: Event) => {
    if (!valid()) return
    // A transport error has no payload. A provider's JSON "error" event is
    // still a live connection and must not be mistaken for a stopped run.
    if (!('data' in event) || typeof event.data !== 'string') { refresh(); return }
    try {
      const data = OperatorConversationStreamEventSchema.parse(JSON.parse(event.data))
      if (data.conversationId !== id) { refresh(); return }
      if (!ready) {
        if (data.type !== 'state' || data.data.snapshotRequired !== true) { refresh(); return }
        ready = true; highWater = -1; seen.clear(); listeners.reconnect(); if (valid()) listeners.connection?.('connected'); return
      }
      if (seen.has(data.id)) return
      seen.add(data.id); if (seen.size > 256) seen.delete(seen.values().next().value!)
      if (data.id <= highWater) { if (valid()) listeners.reconnect(); return }
      if (highWater >= 0 && data.id > highWater + 1 && valid()) listeners.reconnect()
      highWater = data.id
      if (valid()) listeners.event(data)
      if (valid()) listeners.connection?.('connected')
    } catch { refresh() }
  })
  listeners.connection?.('connecting')
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return close
}
