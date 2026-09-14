import { create } from 'zustand'

export const DEFAULT_NAVIGATION_WIDTH = 216
export const MIN_NAVIGATION_WIDTH = 192
export const MAX_NAVIGATION_WIDTH = 360

const COLLAPSED_STORAGE_KEY = 'graphql-navigation-collapsed'
const WIDTH_STORAGE_KEY = 'graphql-navigation-width'

type ExpandableWorkspaceSection = 'agents' | 'workflows'

interface NavigationUiState {
  collapsed: boolean
  width: number
  activeWorkspaceId?: string
  workspacesExpanded: boolean
  expandedWorkspaceIds: Readonly<Record<string, boolean>>
  expandedSections: Readonly<Record<string, Partial<Record<ExpandableWorkspaceSection, boolean>>>>
  setCollapsed: (collapsed: boolean) => void
  setWidth: (width: number) => void
  rememberWorkspace: (workspaceId: string) => void
  setWorkspacesExpanded: (expanded: boolean) => void
  expandOnlyWorkspace: (workspaceId: string) => void
  setWorkspaceExpanded: (workspaceId: string, expanded: boolean) => void
  setSectionExpanded: (
    workspaceId: string,
    section: ExpandableWorkspaceSection,
    expanded: boolean,
  ) => void
  reset: () => void
}

function getSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage
  } catch {
    return undefined
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    getSessionStorage()?.setItem(key, value)
  } catch {
    // Navigation remains usable when browser storage is unavailable or full.
  }
}

function removeSessionValue(key: string): void {
  try {
    getSessionStorage()?.removeItem(key)
  } catch {
    // Resetting in-memory state is still sufficient for the current page.
  }
}

function readCollapsed(): boolean {
  return getSessionStorage()?.getItem(COLLAPSED_STORAGE_KEY) === 'true'
}

function clampWidth(width: number): number {
  return Math.min(MAX_NAVIGATION_WIDTH, Math.max(MIN_NAVIGATION_WIDTH, Math.round(width)))
}

function readWidth(): number {
  const stored = Number(getSessionStorage()?.getItem(WIDTH_STORAGE_KEY))
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_NAVIGATION_WIDTH
}

function initialState() {
  return {
    collapsed: readCollapsed(),
    width: readWidth(),
    activeWorkspaceId: undefined,
    workspacesExpanded: true,
    expandedWorkspaceIds: {},
    expandedSections: {},
  }
}

/**
 * Local interaction state for the left navigation. Keeping this outside route
 * components prevents expansion, collapse, width, and workspace context from
 * resetting whenever the active page swaps one shell route for another.
 */
export const useNavigationUiStore = create<NavigationUiState>((set) => ({
  ...initialState(),
  setCollapsed: (collapsed) => {
    writeSessionValue(COLLAPSED_STORAGE_KEY, String(collapsed))
    set((state) => state.collapsed === collapsed ? state : { collapsed })
  },
  setWidth: (width) => {
    const nextWidth = clampWidth(width)
    writeSessionValue(WIDTH_STORAGE_KEY, String(nextWidth))
    set((state) => state.width === nextWidth ? state : { width: nextWidth })
  },
  rememberWorkspace: (workspaceId) => {
    set((state) => state.activeWorkspaceId === workspaceId ? state : { activeWorkspaceId: workspaceId })
  },
  setWorkspacesExpanded: (workspacesExpanded) =>
    set((state) => state.workspacesExpanded === workspacesExpanded ? state : { workspacesExpanded }),
  expandOnlyWorkspace: (workspaceId) =>
    set((state) => {
      const expandedIds = Object.entries(state.expandedWorkspaceIds)
        .filter(([, expanded]) => expanded)
        .map(([id]) => id)
      if (expandedIds.length === 1 && expandedIds[0] === workspaceId) return state
      return { expandedWorkspaceIds: { [workspaceId]: true } }
    }),
  setWorkspaceExpanded: (workspaceId, expanded) =>
    set((state) => state.expandedWorkspaceIds[workspaceId] === expanded
      ? state
      : { expandedWorkspaceIds: { ...state.expandedWorkspaceIds, [workspaceId]: expanded } }),
  setSectionExpanded: (workspaceId, section, expanded) =>
    set((state) => state.expandedSections[workspaceId]?.[section] === expanded
      ? state
      : {
          expandedSections: {
            ...state.expandedSections,
            [workspaceId]: { ...state.expandedSections[workspaceId], [section]: expanded },
          },
        }),
  reset: () => {
    removeSessionValue(COLLAPSED_STORAGE_KEY)
    removeSessionValue(WIDTH_STORAGE_KEY)
    set({
      collapsed: false,
      width: DEFAULT_NAVIGATION_WIDTH,
      activeWorkspaceId: undefined,
      workspacesExpanded: true,
      expandedWorkspaceIds: {},
      expandedSections: {},
    })
  },
}))
