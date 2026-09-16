import { create } from 'zustand'

const storageKey = 'graphql.conversation-drafts'

function loadDrafts(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch { return {} }
}

function saveDrafts(drafts: Record<string, string>) {
  try { window.localStorage.setItem(storageKey, JSON.stringify(drafts)) } catch { /* local storage is optional */ }
}

export interface ConversationDraftState {
  drafts: Record<string, string>
  setDraft: (conversationId: string, value: string) => void
  clearDraft: (conversationId: string) => void
}

/**
 * Drafts are intentionally local interaction state. The conversation ID is
 * the key so changing the selected agent cannot move text between threads.
 */
export const useConversationDraftStore = create<ConversationDraftState>((set) => ({
  drafts: loadDrafts(),
  setDraft: (conversationId, value) =>
    set((state) => {
      const drafts = { ...state.drafts, [conversationId]: value }; saveDrafts(drafts); return { drafts }
    }),
  clearDraft: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.drafts)) return state
      const drafts = { ...state.drafts }
      delete drafts[conversationId]
      saveDrafts(drafts)
      return { drafts }
    }),
}))

export function getConversationDraft(conversationId: string): string {
  return useConversationDraftStore.getState().drafts[conversationId] ?? ''
}
