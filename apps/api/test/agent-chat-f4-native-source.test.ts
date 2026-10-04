import { describe, expect, it } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'

import { nativeSourceContent } from './helpers/agentChatNativeSource.js'

describe('F4 A-R21 full native source-history comparison', () => {
  for (const harness of ['codex', 'opencode'] as const) {
    const session: NativeSessionReference = { harness, nativeSessionId: 'source', providerVersion: 'fixture' }
    const record = () => harness === 'codex'
      ? { id: 'turn', itemsView: 'full', items: [{ id: 'message', type: 'agentMessage', text: 'KIWI' }] }
      : { info: { id: 'message', sessionID: 'source', role: 'assistant' }, parts: [{ id: 'part', type: 'text', text: 'KIWI' }] }
    it(`${harness}: detects changed contents and identities despite unchanged record counts`, () => {
      const before = nativeSourceContent(session, [record()])
      expect(nativeSourceContent(session, [record()])).toBe(before)
      const changedContent = JSON.parse(JSON.stringify(record()).replace('KIWI', 'MANGO')) as Record<string, unknown>
      const changedIdentity = JSON.parse(JSON.stringify(record()).replace('message', 'another-message')) as Record<string, unknown>
      expect(nativeSourceContent(session, [changedContent])).not.toBe(before)
      expect(nativeSourceContent(session, [changedIdentity])).not.toBe(before)
      expect(() => nativeSourceContent(session, [])).toThrow(/empty/)
      expect(() => nativeSourceContent(session, [record(), record()])).toThrow(/repeated/)
    })
  }
  it('rejects partial Codex items and cross-session OpenCode messages rather than claiming proof', () => {
    expect(() => nativeSourceContent({ harness: 'codex', nativeSessionId: 'source', providerVersion: 'fixture' },
      [{ id: 'turn', itemsView: 'summary', items: [] }])).toThrow(/full/)
    expect(() => nativeSourceContent({ harness: 'opencode', nativeSessionId: 'source', providerVersion: 'fixture' },
      [{ info: { id: 'message', sessionID: 'other' }, parts: [] }])).toThrow(/another session/)
  })
})
