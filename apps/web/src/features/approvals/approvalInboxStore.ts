import { create } from 'zustand'

interface ApprovalInboxScope {
  workspaceId: string
  workflowId?: string
  interactionId?: string
}

interface ApprovalInboxUiState extends ApprovalInboxScope {
  open: boolean
  sidebarOpen: boolean
  openInbox(scope: ApprovalInboxScope): void
  closeInbox(): void
  setSidebarOpen(open: boolean): void
  selectInteraction(interactionId?: string): void
}

export const useApprovalInboxStore = create<ApprovalInboxUiState>((set) => ({
  open: false,
  sidebarOpen: true,
  workspaceId: '',
  openInbox: (scope) => set({ ...scope, open: true }),
  closeInbox: () => set({ open: false, interactionId: undefined }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  selectInteraction: (interactionId) => set({ interactionId }),
}))
