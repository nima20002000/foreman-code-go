import { create } from 'zustand'
import type { Agent } from '@graphql/contracts'

import {
  deleteAgentForSession,
  readDeletedAgentIds,
  readLocalAgents,
  writeLocalAgents,
} from './localAgents'

export interface AgentDirectoryAnnouncement {
  message: string
  nonce: number
}

interface AgentDirectoryState {
  orders: Readonly<Record<string, readonly string[]>>
  catalogs: Readonly<Record<string, { localAgents: readonly Agent[]; deletedAgentIds: readonly string[] }>>
  announcement: AgentDirectoryAnnouncement | null
  setOrder: (workspaceId: string, ids: readonly string[]) => void
  hydrateWorkspace: (workspaceId: string) => void
  setLocalAgents: (workspaceId: string, agents: readonly Agent[]) => void
  deleteAgent: (workspaceId: string, agentId: string) => void
  announce: (message: string) => void
  reset: () => void
}

/**
 * Agent card ordering is interaction state: it belongs to one workspace and
 * survives route remounts for the current session, but is not server data or
 * URL state. Unknown and removed ids are intentionally retained here so a
 * later query refresh can put an existing agent back in its previous place.
 */
export const useAgentDirectoryStore = create<AgentDirectoryState>((set) => ({
  orders: {},
  catalogs: {},
  announcement: null,
  setOrder: (workspaceId, ids) =>
    set((state) => ({ orders: { ...state.orders, [workspaceId]: [...ids] } })),
  hydrateWorkspace: (workspaceId) =>
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [workspaceId]: {
          localAgents: readLocalAgents(workspaceId),
          deletedAgentIds: readDeletedAgentIds(workspaceId),
        },
      },
    })),
  setLocalAgents: (workspaceId, agents) => {
    writeLocalAgents(workspaceId, agents)
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [workspaceId]: {
          localAgents: [...agents],
          deletedAgentIds:
            state.catalogs[workspaceId]?.deletedAgentIds ?? readDeletedAgentIds(workspaceId),
        },
      },
    }))
  },
  deleteAgent: (workspaceId, agentId) => {
    const catalog = deleteAgentForSession(workspaceId, agentId)
    set((state) => ({
      catalogs: {
        ...state.catalogs,
        [workspaceId]: catalog,
      },
    }))
  },
  announce: (message) =>
    set((state) => ({
      announcement: { message, nonce: (state.announcement?.nonce ?? 0) + 1 },
    })),
  reset: () => set({ orders: {}, catalogs: {}, announcement: null }),
}))

/** Apply a workspace's order to the current query/local projection. */
export function applyAgentOrder(
  ids: readonly string[],
  storedOrder: readonly string[] | undefined,
): string[] {
  if (!storedOrder || storedOrder.length === 0) return [...ids]
  const available = new Set(ids)
  const ordered = [...new Set(storedOrder)].filter((id) => available.has(id))
  const orderedSet = new Set(ordered)
  return [...ordered, ...ids.filter((id) => !orderedSet.has(id))]
}

export function moveAgentToIndex(
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

export function moveAgentRelative(
  ids: readonly string[],
  id: string,
  targetId: string,
  position: 'before' | 'after',
): string[] {
  if (id === targetId) return [...ids]
  const without = ids.filter((value) => value !== id)
  const targetIndex = without.indexOf(targetId)
  if (targetIndex === -1) return [...ids]
  without.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, id)
  return without
}
