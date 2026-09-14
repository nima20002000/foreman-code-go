import { create } from 'zustand'

/** Order key for the workspace entries that share the Workspaces parent. */
export const WORKSPACES_ORDER_KEY = 'workspaces'

/** Order key for the top-level destinations outside the workspace tree. */
export const GLOBAL_NAVIGATION_ORDER_KEY = 'global-navigation'

/** Order key for the sections that share one workspace parent. */
export function workspaceSectionsOrderKey(workspaceId: string): string {
  return `workspace:${workspaceId}:sections`
}

/**
 * Applies a session-local sibling order to the ids currently projected by the
 * server. Ids that no longer exist are dropped and newly projected ids keep
 * their natural position after the ordered ones, so a changed list can never
 * lose or hide an entry.
 */
export function applyStoredOrder(
  ids: readonly string[],
  storedOrder: readonly string[] | undefined,
): string[] {
  if (!storedOrder || storedOrder.length === 0) return [...ids]
  const known = new Set(ids)
  const ordered = [...new Set(storedOrder)].filter((id) => known.has(id))
  if (ordered.length === 0) return [...ids]
  const orderedSet = new Set(ordered)
  return [...ordered, ...ids.filter((id) => !orderedSet.has(id))]
}

/** Moves `id` to `targetIndex`, clamped to the list bounds. */
export function moveItemToIndex(
  ids: readonly string[],
  id: string,
  targetIndex: number,
): string[] {
  const from = ids.indexOf(id)
  if (from === -1) return [...ids]
  const to = Math.max(0, Math.min(targetIndex, ids.length - 1))
  if (from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** Moves `id` directly before or after a sibling, within the same list. */
export function moveItemRelative(
  ids: readonly string[],
  id: string,
  targetId: string,
  position: 'before' | 'after',
): string[] {
  if (id === targetId) return [...ids]
  const withoutItem = ids.filter((value) => value !== id)
  const targetIndex = withoutItem.indexOf(targetId)
  if (targetIndex === -1) return [...ids]
  withoutItem.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, id)
  return withoutItem
}

export interface NavigationReorderAnnouncement {
  message: string
  nonce: number
}

interface NavigationOrderStore {
  /** Sibling order per parent key: this is local interaction state, not URL or server state. */
  orders: Readonly<Record<string, readonly string[]>>
  announcement: NavigationReorderAnnouncement | null
  setOrder: (parentKey: string, ids: readonly string[]) => void
  announce: (message: string) => void
  reset: () => void
}

/**
 * Sibling order for the sidebar menus. Zustand keeps it stable across route
 * remounts in the current session; it is intentionally not persisted, not in
 * the URL, and not in Query.
 */
export const useNavigationOrderStore = create<NavigationOrderStore>((set) => ({
  orders: {},
  announcement: null,
  setOrder: (parentKey, ids) =>
    set((state) => ({ orders: { ...state.orders, [parentKey]: [...ids] } })),
  announce: (message) =>
    set((state) => ({
      announcement: { message, nonce: (state.announcement?.nonce ?? 0) + 1 },
    })),
  reset: () => set({ orders: {}, announcement: null }),
}))
