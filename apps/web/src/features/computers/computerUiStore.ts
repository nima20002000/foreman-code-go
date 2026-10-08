import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

interface ComputerUiState {
  activity?: { session: number; key: string } | undefined
  openActivity(key: string): void
  closeActivity(): void
}
export const useComputerUi = create<ComputerUiState>(set => ({
  openActivity: key => set({ activity: { session: sessionGeneration(), key } }),
  closeActivity: () => set({ activity: undefined }),
}))
