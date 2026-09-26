import { createStore } from 'zustand'

/** Local selection only; revisions are captured when the user selects a card. */
export function createResourceSelection() {
  return createStore<{
    selecting: boolean
    selected: Record<string, number>
    confirming: boolean
    notice: string
    start: () => void
    toggle: (id: string, revision: number) => void
    confirm: (open: boolean) => void
    clear: (notice?: string) => void
  }>((set) => ({
    selecting: false, selected: {}, confirming: false, notice: '',
    start: () => set({ selecting: true, selected: {}, notice: '' }),
    toggle: (id, revision) => set((state) => {
      const selected = { ...state.selected }
      if (id in selected) delete selected[id]
      else if (Object.keys(selected).length < 100) selected[id] = revision
      return { selected }
    }),
    confirm: (confirming) => set({ confirming }),
    clear: (notice = '') => set({ selecting: false, selected: {}, confirming: false, notice }),
  }))
}
