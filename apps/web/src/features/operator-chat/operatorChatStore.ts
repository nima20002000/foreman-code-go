import { create } from 'zustand'

const storageKey = 'graphql.operator-chat.ui'
interface OperatorChatUiState {
  open: boolean
  historyOpen: boolean
  selectedConversationId?: string
  setOpen(open: boolean): void
  setHistoryOpen(open: boolean): void
  select(id: string): void
}

function savedState(): Partial<Pick<OperatorChatUiState, 'open' | 'historyOpen' | 'selectedConversationId'>> {
  try { return JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Partial<OperatorChatUiState> } catch { return {} }
}

const initial = typeof window === 'undefined' ? {} : savedState()
function persist(state: Pick<OperatorChatUiState, 'open' | 'historyOpen' | 'selectedConversationId'>) {
  try { window.localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* storage is optional */ }
}

export const useOperatorChatStore = create<OperatorChatUiState>((set) => ({
  open: initial.open ?? false,
  historyOpen: initial.historyOpen ?? true,
  selectedConversationId: initial.selectedConversationId,
  setOpen: (open) => set((state) => { const next = { ...state, open }; persist(next); return { open } }),
  setHistoryOpen: (historyOpen) => set((state) => { const next = { ...state, historyOpen }; persist(next); return { historyOpen } }),
  select: (selectedConversationId) => {
    set((state) => { const next = { ...state, selectedConversationId }; persist(next); return { selectedConversationId } })
  },
}))
