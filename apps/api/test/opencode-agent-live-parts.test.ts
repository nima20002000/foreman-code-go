import { expect, it } from 'vitest'
import { ActivityChangeEnvelopeV1Schema, type NativeHarnessEvent } from '@graphql/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { fixture } from './helpers/agentChatF1.js'

it('buffers OpenCode text until exact parent metadata, then publishes prefix and suffix through the mounted Agent', async () => {
  const f = fixture(), committed: string[] = [], deltas: Array<{ text: unknown; mode: unknown }> = []
  const checkpoints: Array<{ committed: string[]; deltas: Array<{ text: unknown; mode: unknown }> }> = []
  Object.defineProperty(f.manager, 'harness', { value: 'opencode' })
  f.manager.session.harness = 'opencode'; f.store.row.harness = 'opencode'
  f.service['messages'].appendAssistantTextOperation = async (id, requestId, operation) => {
    expect(id).toBe(f.store.row.id)
    expect(requestId).toBe(f.store.row.active_request_id)
    expect(operation.identity.sessionId).toBe(f.store.row.native_session_id)
    expect(operation.identity.turnId).toBe(f.store.row.active_native_turn_id)
    expect(operation.identity.parentId).toBe('assistant')
    committed.push(operation.text)
    return { status: 'committed', revision: String(f.store.row.revision), messageRevision: String(f.store.row.revision) }
  }
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
    if (event.type === 'delta') {
      const envelope = ActivityChangeEnvelopeV1Schema.parse(event.data.activityChange)
      expect(envelope.owner).toEqual({ kind: 'chat_request', conversationId: 'conversation', requestId: 'A' })
      expect(envelope.native).toMatchObject({ harness: 'opencode', sessionId: 'session', turnId: 'turn-A' })
      expect(envelope.change.kind === 'text.append' || envelope.change.kind === 'text.replace').toBe(true)
      if (envelope.change.kind === 'text.append' || envelope.change.kind === 'text.replace') {
        expect(committed).toContain(envelope.change.text)
        deltas.push({ text: envelope.change.text, mode: envelope.change.kind === 'text.append' ? 'append' : 'replace' })
      }
    }
  })
  try {
    await f.send('A'); await f.idle()
    expect(f.store.turns.get('A')).toMatchObject({ delivery: 'completed', native_turn_id: 'turn-A', result: { outcome: 'succeeded' } })
    expect(f.store.row.native_session_id).toBe('session')
    expect(checkpoints).toEqual([
      { committed: [], deltas: [] },
      { committed: ['prefix '], deltas: [{ text: 'prefix ', mode: 'replace' }] },
    ])
    expect(committed).toEqual(['prefix ', 'suffix'])
    expect(deltas).toEqual([{ text: 'prefix ', mode: 'replace' }, { text: 'suffix', mode: 'append' }])
  } finally { unsubscribe(); await f.service.shutdown() }
})
