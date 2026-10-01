import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@graphql/contracts'
import { fixture } from './helpers/agentChatF1.js'

/** Real Agent service/pump and scripted repository, controlled provider and text-commit port.
 * This checks production ordering; it is not PostgreSQL/native qualification. */
describe('Agent chat production text stream', () => {
  it('orders provisional text before its committed empty final and drops delayed deltas', async () => {
    const f = fixture(), timeline: string[] = []
    const start = f.manager.startTurn.bind(f.manager)
    f.service['messages'].appendAssistantMessage = async () => { timeline.push('commit'); return true }
    f.manager.startTurn = async function* (session, input, signal) {
      yield* start(session, input, signal)
      const event = (sequence: number, text: string): NativeHarnessEvent => ({ connectionId: 'connection-a', sequence,
        occurredAt: new Date().toISOString(), type: 'assistant.delta', payload: { itemId: 'item-a', text } })
      yield event(1, 'a'); yield event(2, 'b')
      yield { ...event(3, ''), type: 'item.completed', payload: { item: { id: 'item-a', type: 'agentMessage', text: '' } } }
      yield event(4, 'late')
    }
    const unsubscribe = f.service.events.subscribe(f.store.row.id, (event) => { if (event.type === 'delta') timeline.push(String(event.data.text)) })
    try {
      await f.send('text'); await f.idle()
      expect(timeline).toEqual(['ab', 'commit', ''])
      expect(f.manager.starts).toEqual(['text'])
    } finally { unsubscribe(); await f.service.shutdown() }
  })
  it('never advertises a declined final mutation or appends a later delta to it', async () => {
    const f = fixture(), deltas: unknown[] = []
    const start = f.manager.startTurn.bind(f.manager)
    f.service['messages'].appendAssistantMessage = async () => false
    f.manager.startTurn = async function* (session, input, signal) {
      yield* start(session, input, signal)
      yield { sequence: 1, occurredAt: new Date().toISOString(), type: 'item.completed',
        payload: { item: { id: 'item-a', type: 'agentMessage', text: 'uncommitted' } } }
      yield { sequence: 2, occurredAt: new Date().toISOString(), type: 'assistant.delta', payload: { itemId: 'item-a', text: 'late' } }
    }
    const unsubscribe = f.service.events.subscribe(f.store.row.id, (event) => { if (event.type === 'delta') deltas.push(event.data) })
    try { await f.send('rejected'); await f.idle(); expect(deltas).toEqual([]) }
    finally { unsubscribe(); await f.service.shutdown() }
  })
})
