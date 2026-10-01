import { describe, expect, it } from 'vitest'
import { AcceptedChatResponseControlSchema } from './interaction-activity.js'

const control = {
  schemaVersion: 1, kind: 'respond', conversationId: 'conversation', modelRequestId: 'request',
  scope: { kind: 'operator_chat', conversationId: 'conversation' },
  native: { harness: 'codex', providerVersion: 'pinned', sessionId: 'session', turnId: 'turn', requestId: 'native-request', requestType: 'approval' },
  choice: { optionId: 'allow', semantic: 'approve_once' },
}
describe('accepted native response identity', () => {
  it.each(['codex', 'opencode'])('requires an observed %s turn', (harness) => {
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...control.native, harness } }).success).toBe(true)
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...control.native, harness, turnId: undefined } }).success).toBe(false)
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...control.native, harness, turnId: undefined, messageId: 'message', generation: 'callback' } }).success).toBe(false)
  })
  it('retains Claude message and callback generation without inventing a turn', () => {
    const native = { ...control.native, harness: 'claude', turnId: undefined, messageId: 'actual-message', generation: 'actual-callback' }
    expect(AcceptedChatResponseControlSchema.parse({ ...control, native }).native).toMatchObject({ messageId: 'actual-message', generation: 'actual-callback' })
    for (const missing of ['messageId', 'generation']) {
      expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...native, [missing]: undefined } }).success).toBe(false)
    }
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, native: { ...native, turnId: 'actual-message' } }).success).toBe(false)
  })
  it('rejects a receipt from another conversation scope', () => {
    expect(AcceptedChatResponseControlSchema.safeParse({ ...control, scope: { ...control.scope, conversationId: 'other' } }).success).toBe(false)
  })
})
