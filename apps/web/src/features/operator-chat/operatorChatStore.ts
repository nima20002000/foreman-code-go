import { create } from 'zustand'
import { identityChangedEvent, parseChatPreferences, protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

export const operatorChatNarrowQuery = '(max-width: 600px)'
export function isNarrowOperatorChat(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(operatorChatNarrowQuery).matches
}

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
  open: initial.open ?? false,
  historyOpen: isNarrowOperatorChat() ? false : initial.historyOpen ?? true,
  selectedConversationId: initial.selectedConversationId,
  setOpen: (open) => { if (!sessionIsSwitching()) set((state) => {
    const next = { open, historyOpen: isNarrowOperatorChat() ? false : state.historyOpen }
    persist({ ...state, ...next }); return next
  }) },
  setHistoryOpen: (historyOpen) => { if (!sessionIsSwitching()) set((state) => { persist({ ...state, historyOpen }); return { historyOpen } }) },
  select: (selectedConversationId) => { if (!sessionIsSwitching()) set((state) => {
    const next = { selectedConversationId, historyOpen: isNarrowOperatorChat() ? false : state.historyOpen }
    persist({ ...state, ...next }); return next
  }) },
  reset: () => set({ open: false, historyOpen: !isNarrowOperatorChat(), selectedConversationId: undefined }),
}))
if (typeof window !== 'undefined') window.addEventListener(identityChangedEvent, () => useOperatorChatStore.getState().reset())
