import { describe, expect, it, vi } from 'vitest'
import type { NativeHarnessEvent } from '@graphql/contracts'
import { fixture } from './helpers/agentChatF1.js'

const part = (sequence: number, output: string): NativeHarnessEvent => ({ sequence, connectionId: 'transport-1',
  occurredAt: '2026-10-01T00:00:00Z', type: 'message.part.updated', payload: { part: {
    sessionID: 'session', messageID: 'assistant', id: 'tool', type: 'tool', tool: 'custom', state: { status: 'running', title: output, output },
  } } })
const metadata: NativeHarnessEvent = { sequence: 3, connectionId: 'transport-1', occurredAt: '2026-10-01T00:00:00Z',
  type: 'message.updated', payload: { info: { role: 'assistant', sessionID: 'session', parentID: 'turn-A', id: 'assistant' } } }

// Mounts the real pump, admission gate, stream writer and history observer. The persistence port is inspected here;
// the same mounted service plus PostgreSQL persistence is exercised by activity-persistence.integration.test.ts.
describe('Agent activity production source wiring', () => {
  it('flushes two running parts admitted after metadata and marks same-status history authoritative', async () => {
    const f = fixture()
    Object.defineProperty(f.manager, 'harness', { value: 'opencode' })
    f.manager.session.harness = 'opencode'; f.store.row.harness = 'opencode'
    const append = vi.fn(f.service['activity'].append).mockResolvedValue(undefined)
    f.service['activity'].append = append
    const manager: import('../src/modules/harnesses/port.js').NativeHarnessSessionManager = f.manager
    manager.startTurn = async function* (_session, input) {
      f.manager.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId: 'turn-A',
        events: [metadata, part(0, 'history correction')], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } })
      await input.onSubmitted?.('turn-A')
      yield part(1, 'first running'); yield part(2, 'second running'); yield metadata
    }
    try {
      await f.send('A'); await f.idle()
      expect(append.mock.calls.map((call) => call[2].output)).toEqual(['first running', 'second running', 'history correction'])
      expect(append.mock.calls[0]?.[3]).toMatchObject({ nativeSessionId: 'session', nativeTurnId: 'turn-A',
        authoritativeReconciliation: false, source: { connectionId: 'transport-1', sequence: '1', system: 'opencode_transport' } })
      expect(append.mock.calls[1]?.[3]?.source?.sequence).toBe('2')
      expect(append.mock.calls[2]?.[3]).toMatchObject({ nativeSessionId: 'session', nativeTurnId: 'turn-A',
        authoritativeReconciliation: true, source: { system: 'opencode_history' } })
      expect(append.mock.calls[2]?.[3]?.source?.sequence).toBeUndefined()
    } finally { await f.service.shutdown() }
  })
  it('retains a text prefix before metadata and appends the later suffix through the mounted consumer', async () => {
    const f = fixture(), deltas: Array<{ text: unknown; mode: unknown }> = [], committed: string[] = []
    Object.defineProperty(f.manager, 'harness', { value: 'opencode' })
    f.manager.session.harness = 'opencode'; f.store.row.harness = 'opencode'
    f.service['messages'].appendAssistantMessage = async (_id, _request, _native, text) => { committed.push(text); return true }
    const manager: import('../src/modules/harnesses/port.js').NativeHarnessSessionManager = f.manager
    manager.startTurn = async function* (_session, input) {
      f.manager.histories.set(input.clientCorrelationId, { correlationId: input.clientCorrelationId, nativeTurnId: 'turn-A',
        events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } })
      await input.onSubmitted?.('turn-A')
      yield { ...part(1, ''), payload: { part: { sessionID: 'session', messageID: 'assistant', id: 'text-part', type: 'text', text: 'prefix ' } } }
      yield { ...metadata, sequence: 2 }
      yield { sequence: 3, connectionId: 'transport-1', occurredAt: '2026-10-01T00:00:00Z', type: 'message.part.delta',
        payload: { sessionID: 'session', messageID: 'assistant', partID: 'text-part', field: 'text', delta: 'suffix' } }
    }
    const unsubscribe = f.service.events.subscribe('conversation', (event) => {
      if (event.type === 'delta') deltas.push({ text: event.data.text, mode: event.data.mode })
    })
    try {
      await f.send('A'); await f.idle()
      expect(committed).toEqual(['prefix '])
      expect(deltas).toEqual([{ text: 'prefix ', mode: 'replace' }, { text: 'suffix', mode: 'append' }])
    } finally { unsubscribe(); await f.service.shutdown() }
  })

})
