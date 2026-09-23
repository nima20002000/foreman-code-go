import { describe, expect, it } from 'vitest'
import { matchingDeliveryEvidence, type NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'

describe('Exact native approval delivery evidence', () => {
  it('accepts only the exact persisted decision and session receipt', () => {
    const f = deliveryFixture()
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual(f.proof)
  })
  it('treats duplicate identical receipts as the same evidence', () => {
    const f = deliveryFixture()
    f.history.responseDeliveries = [f.proof, { ...f.proof, source: 'provider_history' }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual(f.proof)
  })
  it.each([false, true])('rejects conflicting decision receipts regardless of arrival order, reverse=%s', (reverse) => {
    const f = deliveryFixture()
    const conflict: NativeResponseDeliveryEvidence = { ...f.proof, optionId: 'reject', semantic: 'reject' }
    f.history.responseDeliveries = reverse ? [conflict, f.proof] : [f.proof, conflict]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('does not accept one request type over a conflicting type with the same native identity', () => {
    const f = deliveryFixture()
    f.history.responseDeliveries = [f.proof, { ...f.proof, nativeRequestType: 'other-request-type' }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  const mismatches: Array<[string, Partial<NativeResponseDeliveryEvidence>]> = [
    ['provider', { harness: 'opencode' }], ['version', { providerVersion: 'other-version' }],
    ['session', { nativeSessionId: 'other-session' }], ['request', { nativeRequestId: 'other-request' }],
    ['request type', { nativeRequestType: 'other-type' }], ['option', { optionId: 'other-option' }], ['decision', { semantic: 'reject' }],
  ]
  it.each(mismatches)('denies a mismatched %s receipt', (_name, patch) => {
    const f = deliveryFixture()
    f.history.responseDeliveries = [{ ...f.proof, ...patch }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('does not equate terminal work, connection closure, or an empty pending list with delivery', () => {
    const f = deliveryFixture()
    f.history.responseDeliveries = []
    f.history.terminalResult = { outcome: 'succeeded' }
    f.history.events = [{ type: 'transport.closed', sequence: 0, occurredAt: f.interaction.createdAt, payload: {} }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('retains uncertainty when the exact request is still pending', () => {
    const f = deliveryFixture()
    f.history.pendingInteractions = [{ session: f.session, turn: { nativeTurnId: 'turn-worker', nativeRequestId: f.interaction.nativeRequestId },
      nativeRequestType: f.interaction.nativeRequestType, request: {}, responseOptions: f.interaction.responseOptions }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toBeUndefined()
  })
  it('does not conflate a different pending review with this request', () => {
    const f = deliveryFixture()
    f.history.pendingInteractions = [{ session: f.session, turn: { nativeTurnId: 'other-turn', nativeRequestId: 'different-request' },
      nativeRequestType: f.interaction.nativeRequestType, request: {}, responseOptions: f.interaction.responseOptions }]
    expect(matchingDeliveryEvidence(f.interaction, f.session, f.history)).toEqual(f.proof)
  })
  it('rejects evidence before a decision and does not mutate any durable fact', () => {
    const f = deliveryFixture()
    const before = structuredClone(f.interaction)
    matchingDeliveryEvidence(f.interaction, f.session, f.history)
    expect(f.interaction).toEqual(before)
    const pending = { ...f.interaction, status: 'pending' as const }
    delete pending.selectedOptionId
    delete pending.selectedSemantic
    delete pending.nativeResponse
    delete pending.decidedAt
    expect(matchingDeliveryEvidence(pending, f.session, f.history)).toBeUndefined()
  })
})
