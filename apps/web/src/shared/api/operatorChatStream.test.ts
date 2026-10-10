import { afterEach, expect, it, vi } from 'vitest'
import { subscribeOperatorChat } from './operatorChatStream'
class Source extends EventTarget {
  static OPEN = 1
  static CLOSED = 2
  static current: Source
  readyState = 1
  close = vi.fn()
  constructor() { super(); Source.current = this }
  snapshot() { this.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify({ conversation: { id: 'chat', agentId: 'operator', scope: 'application', operatorConfigurationVersionId: 'config', status: 'open' }, messages: [], activeRequestId: 'A', turnState: 'active', revision: 100 }) })) }
  event(id: number) { this.dispatchEvent(new MessageEvent('delta', { data: JSON.stringify({ id, conversationId: 'chat', type: 'delta', data: {} }) })) }
}
afterEach(() => vi.unstubAllGlobals())
it('requires a fresh bootstrap, deduplicates and repairs gaps without comparing SSE IDs to scope revisions', () => {
  vi.stubGlobal('EventSource', Source)
  const calls = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn() }
  const close = subscribeOperatorChat('chat', calls), source = Source.current
  source.event(50); expect(calls.event).not.toHaveBeenCalled()
  source.snapshot(); source.event(1); source.event(1); source.event(3)
  expect(calls.event).toHaveBeenCalledTimes(2); expect(calls.reconnect).toHaveBeenCalledTimes(2)
  source.dispatchEvent(new Event('open')); source.event(0)
  expect(calls.event).toHaveBeenCalledTimes(2)
  source.snapshot(); source.event(0); expect(calls.event).toHaveBeenCalledTimes(3)
  close(); source.snapshot(); source.event(4); expect(calls.snapshot).toHaveBeenCalledTimes(2)
})

it('projects consecutive conversation-local events without resetting the live connection', () => {
  vi.stubGlobal('EventSource', Source)
  const calls = { snapshot: vi.fn(), event: vi.fn(), reconnect: vi.fn(), connection: vi.fn() }
  const close = subscribeOperatorChat('chat', calls)
  try {
    Source.current.snapshot()
    Source.current.event(0)
    Source.current.event(1)
    expect(calls.event.mock.calls.map(([event]) => event.id)).toEqual([0, 1])
    expect(calls.reconnect).not.toHaveBeenCalled()
    expect(calls.connection).toHaveBeenLastCalledWith('connected')
  } finally { close() }
})
