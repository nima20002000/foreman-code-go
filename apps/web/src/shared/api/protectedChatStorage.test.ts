import { describe, expect, it, vi } from 'vitest'
import { bindProtectedChatInstance, identityEpoch, protectedKey } from './protectedChatStorage'

describe('protected chat instance binding', () => {
  it('fails closed when the new binding cannot be persisted', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked') })
    try { expect(() => bindProtectedChatInstance('unpersistable-instance')).toThrow('Storage blocked') }
    finally { setItem.mockRestore() }
  })
  it('isolates legacy and changed database identities without deleting drafts or pending sends', () => {
    localStorage.clear()
    const draft = protectedKey('draft', 'chat')
    const outbox = protectedKey('outbox', 'chat')
    localStorage.setItem(draft, 'draft')
    localStorage.setItem(outbox, 'pending receipt')
    const initialEpoch = identityEpoch()
    expect(bindProtectedChatInstance('checkout:installation-a')).toBe(true)
    expect(identityEpoch()).not.toBe(initialEpoch)
    const boundEpoch = identityEpoch()
    // StrictMode repeats still report that this document must reload.
    expect(bindProtectedChatInstance('checkout:installation-a')).toBe(true)
    expect(identityEpoch()).toBe(boundEpoch)
    expect(bindProtectedChatInstance('checkout:installation-b')).toBe(true)
    expect(identityEpoch()).not.toBe(boundEpoch)
    expect(localStorage.getItem(protectedKey('draft', 'chat'))).toBeNull()
    expect(localStorage.getItem(protectedKey('outbox', 'chat'))).toBeNull()
    expect(localStorage.getItem(draft)).toBe('draft')
    expect(localStorage.getItem(outbox)).toBe('pending receipt')
  })
})
