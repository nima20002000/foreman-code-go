import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

interface ComputerUiState {
  activity?: { session: number; key: string } | undefined
  draggedKey?: string | undefined
  openActivity(key: string): void
  closeActivity(): void
  drag(key?: string): void
}
export const useComputerUi = create<ComputerUiState>(set => ({
  openActivity: key => set({ activity: { session: sessionGeneration(), key } }),
  closeActivity: () => set({ activity: undefined }),
  drag: key => set({ draggedKey: key }),
}))
