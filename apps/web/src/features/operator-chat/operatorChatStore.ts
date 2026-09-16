import { create } from 'zustand'
import { identityChangedEvent, parseChatPreferences, protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

interface OperatorChatUiState {
  open: boolean
  historyOpen: boolean
  selectedConversationId?: string
  setOpen(open: boolean): void
  setHistoryOpen(open: boolean): void
  select(id: string): void
  reset(): void
}
function savedState() {
  try { return parseChatPreferences(JSON.parse(window.localStorage.getItem(protectedKey('ui')) ?? '{}')) } catch { return {} }
}
const initial = typeof window === 'undefined' ? {} : savedState()
function persist(state: Pick<OperatorChatUiState, 'open' | 'historyOpen' | 'selectedConversationId'>) {
  if (sessionIsSwitching()) return
  try { window.localStorage.setItem(protectedKey('ui'), JSON.stringify(state)) } catch { /* Preferences are optional. */ }
}
export const useOperatorChatStore = create<OperatorChatUiState>((set) => ({
  open: initial.open ?? false, historyOpen: initial.historyOpen ?? true, selectedConversationId: initial.selectedConversationId,
  setOpen: (open) => { if (!sessionIsSwitching()) set((state) => { persist({ ...state, open }); return { open } }) },
  setHistoryOpen: (historyOpen) => { if (!sessionIsSwitching()) set((state) => { persist({ ...state, historyOpen }); return { historyOpen } }) },
  select: (selectedConversationId) => { if (!sessionIsSwitching()) set((state) => { persist({ ...state, selectedConversationId }); return { selectedConversationId } }) },
  reset: () => set({ open: false, historyOpen: true, selectedConversationId: undefined }),
}))
if (typeof window !== 'undefined') window.addEventListener(identityChangedEvent, () => useOperatorChatStore.getState().reset())
