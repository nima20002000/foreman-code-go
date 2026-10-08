import { expect, it } from 'vitest'
import { openCodeCompactionResult, openCodeContextSnapshot, openCodeSessionAgent } from './opencodeSessionControls.js'

it('restores the accepted custom primary agent on Plan exit', () => {
  expect(openCodeSessionAgent('plan', 'reviewer')).toBe('plan')
  expect(openCodeSessionAgent('regular', 'reviewer')).toBe('reviewer')
})
it('matches a manual compaction and its native summary after the accepted history boundary', () => {
  const state = { requestId: 'command', nativeSessionId: 'session', nativeOperationId: 'before', status: 'running' as const,
    message: '', beforeTokens: null, observedAt: '2026-10-04T00:00:00.000Z' }
  const messages = [
    { info: { id: 'before', sessionID: 'session' }, parts: [] },
    { info: { id: 'manual', sessionID: 'session' }, parts: [{ type: 'compaction', auto: false }] },
    { info: { id: 'summary', sessionID: 'session', parentID: 'manual', role: 'assistant', summary: true, finish: 'stop' }, parts: [] },
  ]
  expect(openCodeCompactionResult(state, messages).status).toBe('completed')
  expect(openCodeCompactionResult({ ...state, nativeSessionId: 'foreign' }, messages).status).toBe('running')
})
it('keeps current occupancy separate from lifetime cost and does not double count reasoning', () => {
  const messages = [{ info: { id: 'message', sessionID: 'session', role: 'assistant', finish: 'stop', time: { completed: 100 },
    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } }, cost: 0.02 }, parts: [] }]
  expect(openCodeContextSnapshot(messages, 'session', 'provider/model', 1000)).toMatchObject({
    usedTokens: 100, capacityTokens: 1000, lifetimeTokens: null, cost: null,
  })
})

it('recovers a correlated provider rejection without a successful finish reason', () => {
  const state = { requestId: 'command', nativeSessionId: 'session', nativeOperationId: 'before',
    status: 'uncertain' as const, message: '', beforeTokens: null, observedAt: '2026-10-04T00:00:00.000Z' }
  const messages = [
    { info: { id: 'before', sessionID: 'session' }, parts: [] },
    { info: { id: 'manual', sessionID: 'session' }, parts: [{ type: 'compaction', auto: false }] },
    { info: { id: 'summary', sessionID: 'session', parentID: 'manual', role: 'assistant', summary: true,
      error: { name: 'ProviderError', data: { message: 'Rejected' } } }, parts: [] },
  ]
  expect(openCodeCompactionResult(state, messages).status).toBe('failed')
  expect(openCodeCompactionResult(state, messages.slice(0, 2)).status).toBe('uncertain')
  expect(openCodeCompactionResult(state, messages.map(message => ({ ...message,
    info: { ...message.info, parentID: 'foreign' } }))).status).toBe('uncertain')
})

it.each(['failed', 'completed', 'no-op'] as const)('preserves a known %s outcome over later history', status => {
  const state = { requestId: 'command', nativeSessionId: 'session', nativeOperationId: 'before',
    status, message: 'Known outcome', beforeTokens: null, observedAt: '2026-10-04T00:00:00.000Z' }
  const messages = [
    { info: { id: 'before', sessionID: 'session' }, parts: [] },
    { info: { id: 'manual', sessionID: 'session' }, parts: [{ type: 'compaction', auto: false }] },
    { info: { id: 'summary', sessionID: 'session', parentID: 'manual', role: 'assistant',
      summary: true, finish: 'stop' }, parts: [] },
  ]
  expect(openCodeCompactionResult(state, messages)).toEqual(state)
})
