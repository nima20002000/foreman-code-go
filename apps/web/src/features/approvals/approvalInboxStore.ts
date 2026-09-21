import { create } from 'zustand'

interface ApprovalInboxScope {
  workspaceId: string
  workflowId?: string
}

interface ApprovalInboxUiState extends ApprovalInboxScope {
  open: boolean
  openInbox(scope: ApprovalInboxScope): void
  closeInbox(): void
}

export const useApprovalInboxStore = create<ApprovalInboxUiState>((set) => ({
  open: false,
  workspaceId: '',
  openInbox: (scope) => set({ ...scope, open: true }),
  closeInbox: () => set({ open: false }),
}))
