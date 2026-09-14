import { create } from 'zustand'
import type { WorkspaceDetailsResponse } from '@graphql/contracts'

/**
 * Workspaces created through the frontend shell exist only for the current
 * browser session. They are intentionally not persisted: AGENTS.md forbids
 * backend/persistence work, so the store below is the single source of truth
 * for them and a refresh clears the list.
 */
export const SESSION_WORKSPACE_ID_PREFIX = 'session-'

export interface SessionWorkspace {
  id: string
  name: string
}

interface WorkspaceSessionState {
  workspaces: readonly SessionWorkspace[]
  knownWorkspaces: readonly SessionWorkspace[]
  createWorkspace: (name: string) => SessionWorkspace
  registerWorkspace: (workspace: SessionWorkspace) => void
  reset: () => void
}

let fallbackSequence = 0

function randomToken(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  fallbackSequence += 1
  return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}`
}

/**
 * Stable, collision-free IDs for session workspaces. A repeated token (for
 * example a stubbed `crypto.randomUUID`) falls back to a numeric suffix
 * instead of overwriting an existing entry.
 */
export function createSessionWorkspaceId(existingIds: Iterable<string> = []): string {
  const existing = new Set(existingIds)
  const base = `${SESSION_WORKSPACE_ID_PREFIX}${randomToken()}`
  let candidate = base
  let suffix = 2
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function isSessionWorkspaceId(workspaceId: string): boolean {
  return workspaceId.startsWith(SESSION_WORKSPACE_ID_PREFIX)
}

export const useWorkspaceSessionStore = create<WorkspaceSessionState>((set, get) => ({
  workspaces: [],
  knownWorkspaces: [],
  createWorkspace: (name) => {
    const existingIds = get().workspaces.map((workspace) => workspace.id)
    const workspace: SessionWorkspace = {
      id: createSessionWorkspaceId(existingIds),
      name: name.trim(),
    }
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      knownWorkspaces: [...state.knownWorkspaces.filter((entry) => entry.id !== workspace.id), workspace],
    }))
    return workspace
  },
  registerWorkspace: (workspace) =>
    set((state) => {
      const existing = state.knownWorkspaces.find((entry) => entry.id === workspace.id)
      if (existing?.name === workspace.name) return state
      return {
        knownWorkspaces: [
          ...state.knownWorkspaces.filter((entry) => entry.id !== workspace.id),
          workspace,
        ],
      }
    }),
  reset: () => set({ workspaces: [], knownWorkspaces: [] }),
}))

export function findSessionWorkspace(workspaceId: string): SessionWorkspace | undefined {
  return useWorkspaceSessionStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)
}

/**
 * The empty projection a session workspace resolves to. Agents, workflows,
 * runs, and resources start empty, which gives every created workspace an
 * independent scope without any HTTP request or shared fixture data.
 */
export function sessionWorkspaceDetails(workspace: SessionWorkspace): WorkspaceDetailsResponse {
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      agentIds: [],
      workflowIds: [],
    },
    agents: [],
    workflows: [],
    runs: [],
    resources: [],
    browserProfiles: [],
    runners: [],
  }
}
