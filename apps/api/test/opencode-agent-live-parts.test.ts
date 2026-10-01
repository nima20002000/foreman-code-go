import { expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@graphql/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { fixture } from './helpers/agentChatF1.js'

it('buffers OpenCode text until exact parent metadata, then publishes prefix and suffix through the mounted Agent', async () => {
  const f = fixture(), committed: string[] = [], deltas: Array<{ text: unknown; mode: unknown }> = []
  const checkpoints: Array<{ committed: string[]; deltas: Array<{ text: unknown; mode: unknown }> }> = []
  Object.defineProperty(f.manager, 'harness', { value: 'opencode' })
  f.manager.session.harness = 'opencode'; f.store.row.harness = 'opencode'
  f.service['messages'].appendAssistantMessage = async (_id, _request, _native, text) => { committed.push(text); return true }
  const manager: NativeHarnessSessionManager = f.manager
  const base = { connectionId: 'agent-connection', occurredAt: '2026-10-01T00:00:00Z' }
  const prefix: NativeHarnessEvent = { ...base, sequence: 1, type: 'message.part.updated', payload: { part: {
    sessionID: 'session', messageID: 'assistant', id: 'text-part', type: 'text', text: 'prefix ',
  } } }
  manager.startTurn = async function* (_session, input) {
    f.manager.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId: 'turn-A',
      events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } })
    await input.onSubmitted?.('turn-A')
    yield { ...prefix, payload: { part: { ...prefix.payload.part as object, sessionID: 'foreign', text: 'foreign' } } }
    yield prefix
    checkpoints.push({ committed: [...committed], deltas: [...deltas] })
    yield { ...base, sequence: 2, type: 'message.updated', payload: { info: {
      sessionID: 'session', id: 'assistant', role: 'assistant', parentID: 'turn-A',
    } } }
    checkpoints.push({ committed: [...committed], deltas: [...deltas] })
    yield { ...base, sequence: 3, type: 'message.part.delta', payload: {
      sessionID: 'session', messageID: 'assistant', partID: 'text-part', field: 'text', delta: 'suffix',
    } }
  }
  const unsubscribe = f.service.events.subscribe('conversation', event => {
    if (event.type === 'delta') deltas.push({ text: event.data.text, mode: event.data.mode })
  })
  try {
    await f.send('A'); await f.idle()
    expect(checkpoints).toEqual([
      { committed: [], deltas: [] },
      { committed: ['prefix '], deltas: [{ text: 'prefix ', mode: 'replace' }] },
    ])
    expect(committed).toEqual(['prefix '])
    expect(deltas).toEqual([{ text: 'prefix ', mode: 'replace' }, { text: 'suffix', mode: 'append' }])
  } finally { unsubscribe(); await f.service.shutdown() }
})
