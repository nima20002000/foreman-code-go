import { create } from 'zustand'

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
  drafts: {},
  setDraft: (conversationId, value) =>
    set((state) => ({ drafts: { ...state.drafts, [conversationId]: value } })),
  clearDraft: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.drafts)) return state
      const drafts = { ...state.drafts }
      delete drafts[conversationId]
      return { drafts }
    }),
}))

export function getConversationDraft(conversationId: string): string {
  return useConversationDraftStore.getState().drafts[conversationId] ?? ''
}
