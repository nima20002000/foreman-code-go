import { create } from 'zustand'

/** Interaction only. Selected identities and server responses never enter Zustand. */
export const useRunsSelectorUi = create<{ openId: string | null; setOpen: (id: string | null) => void }>((set) => ({
  openId: null,
  setOpen: (openId) => set({ openId }),
}))
