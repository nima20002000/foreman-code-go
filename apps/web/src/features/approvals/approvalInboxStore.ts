import { create } from 'zustand'

interface ApprovalInboxScope {
  workspaceId: string
  workflowId?: string
  interactionId?: string
}

interface ApprovalInboxUiState extends ApprovalInboxScope {
  open: boolean
  openInbox(scope: ApprovalInboxScope): void
  closeInbox(): void
  selectInteraction(interactionId?: string): void
}

export const useApprovalInboxStore = create<ApprovalInboxUiState>((set) => ({
  open: false,
  workspaceId: '',
  openInbox: (scope) => set({ ...scope, open: true }),
  closeInbox: () => set({ open: false, interactionId: undefined }),
  selectInteraction: (interactionId) => set({ interactionId }),
}))
