import { expect, it } from 'vitest'
import { projectOperatorEnvelope, operatorTextPartKey, OPERATOR_TEXT_BYTES, projectOperatorText } from './operatorTextProjection'
const envelope = (text: string, kind: 'text.append' | 'text.replace', eventId: string, final = false) => ({ schemaVersion: 1,
  owner: { kind: 'chat_request', conversationId: 'chat', requestId: 'A' }, native: { harness: 'codex', sessionId: 'session', turnId: 'turn', itemId: 'item' },
  source: { schemaVersion: 1, system: 'codex', eventId, observedAt: '2026-10-01T00:00:00Z' },
  change: { kind, itemId: 'item', text, finality: final ? 'authoritative_final' : 'provisional' } })
it('actual Operator envelope consumer deduplicates, replaces with empty final and refuses delayed deltas', () => {
  const key = operatorTextPartKey({ harness: 'codex', sessionId: 'session', turnId: 'turn', itemId: 'item' })
  let projected = projectOperatorEnvelope(undefined, 'chat', 'A', envelope('long provisional', 'text.append', '1'), [])
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('long provisional', 'text.append', '1'), [])
  expect(projected?.parts[key]).toBe('long provisional')
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('', 'text.replace', '2', true), [])
  projected = projectOperatorEnvelope(projected, 'chat', 'A', envelope('late', 'text.append', '3'), [])
  expect(projected?.parts[key]).toBe(''); expect(projected?.timeline).toEqual([])
})
it('a reconnect cannot append a buffered delta already represented by canonical partial text', () => {
  const saved = [{ id: 'message', conversationId: 'chat', requestId: 'A', role: 'assistant' as const, nativeMessageId: 'item', nativeMessageComplete: false, content: 'already persisted' }]
  expect(projectOperatorEnvelope(undefined, 'chat', 'A', envelope('persisted', 'text.append', '1'), saved)).toBeUndefined()
  expect(projectOperatorEnvelope(undefined, 'foreign', 'A', envelope('foreign', 'text.replace', '2', true), [])).toBeUndefined()
})
it('bounds provisional live bytes without truncating an authoritative HTTP message', () => {
  expect(projectOperatorText(undefined, 'A', { requestId: 'A', partId: 'item', mode: 'append', text: 'x'.repeat(OPERATOR_TEXT_BYTES + 1) })?.parts.item).toBeUndefined()
})


it('native items sharing a provider block index cannot merge their live text', () => {
  const first = envelope('first', 'text.append', 'shared-uuid')
  const second = { ...envelope('second', 'text.append', 'shared-uuid'), native: { ...first.native, itemId: 'second', partId: '0' }, change: { ...first.change, itemId: 'second', partId: '0', text: 'second' } }
  const one = { ...first, native: { ...first.native, partId: '0' }, change: { ...first.change, partId: '0' } }
  let result = projectOperatorEnvelope(undefined, 'chat', 'A', one, [])
  result = projectOperatorEnvelope(result, 'chat', 'A', second, [])
  expect(Object.values(result!.parts)).toEqual(['first', 'second'])
})
it('never turns a native user echo into the parent assistant answer', () => {
  const user = envelope('input echo', 'text.append', 'echo')
  expect(projectOperatorEnvelope(undefined, 'chat', 'A', { ...user, change: { ...user.change, channel: 'user' } }, [])).toBeUndefined()
})
