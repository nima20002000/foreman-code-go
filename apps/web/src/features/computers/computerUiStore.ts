import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

interface ComputerUiState {
  activity?: { session: number; key: string } | undefined
  draggedKey?: string | undefined
  github?: { session: number; key: string } | undefined
  openGitHub(key: string): void
  closeGitHub(): void
  sync?: { session: number; key: string } | undefined
  openSync(key: string): void
  closeSync(): void
  openActivity(key: string): void
  closeActivity(): void
  drag(key?: string): void
}
export const useComputerUi = create<ComputerUiState>(set => ({
  openActivity: key => set({ activity: { session: sessionGeneration(), key } }),
  closeActivity: () => set({ activity: undefined }),
  drag: key => set({ draggedKey: key }),
  openGitHub: key => set({ github: { session: sessionGeneration(), key } }),
  closeGitHub: () => set({ github: undefined }),
  openSync: key => set({ sync: { session: sessionGeneration(), key } }),
  closeSync: () => set({ sync: undefined }),
}))
