import { OperatorConversationStateSchema, OperatorConversationStreamEventSchema,
  type OperatorConversationState, type OperatorConversationStreamEvent } from '@graphql/contracts'
import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal } from './sessionBoundary'

export function subscribeOperatorChat(id: string, listeners: {
  snapshot(state: OperatorConversationState): void
  event(event: OperatorConversationStreamEvent): void
  reconnect(): void
}): () => void {
  if (sessionIsSwitching() || typeof EventSource === 'undefined') return () => {}
  const generation = sessionGeneration()
  const signal = sessionSignal()
  const source = new EventSource(`/api/operator/conversations/${encodeURIComponent(id)}/events`)
  let closed = false
  const close = () => { if (!closed) { closed = true; source.close(); signal.removeEventListener('abort', close) } }
  const valid = () => {
    try { assertSession(generation); return !closed } catch { close(); return false }
  }
  source.addEventListener('snapshot', (event: MessageEvent<string>) => {
    if (!valid()) return
    try {
      const state = OperatorConversationStateSchema.parse(JSON.parse(event.data))
      if (state.conversation.id === id) listeners.snapshot(state)
    } catch { listeners.reconnect() }
  })
  for (const type of ['delta', 'message', 'state', 'error']) source.addEventListener(type, (event: Event) => {
    if (!valid()) return
    if (!('data' in event) || typeof event.data !== 'string') { listeners.reconnect(); return }
    try {
      const data = OperatorConversationStreamEventSchema.parse(JSON.parse(event.data))
      if (data.conversationId === id) listeners.event(data)
    } catch { listeners.reconnect() }
  })
  signal.addEventListener('abort', close, { once: true })
  if (signal.aborted) close()
  return close
}
