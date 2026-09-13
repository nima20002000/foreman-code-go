import { create } from 'zustand'

import type { WorkflowDefinition } from '@graphql/contracts'

export type GraphDraft = {
  workflow: WorkflowDefinition
  dirty: true
}

type GraphDraftStore = {
  drafts: Record<string, GraphDraft>
  updateDraft: (
    workflowKey: string,
    savedWorkflow: WorkflowDefinition,
    update: (workflow: WorkflowDefinition) => WorkflowDefinition,
  ) => void
  discardDraft: (workflowKey: string) => void
  clearAllDrafts: () => void
}

/**
 * Unsaved edits belong to the graph feature and are keyed by workflow identity.
 * Saved workflow data remains in TanStack Query; this store never becomes a
 * second source of truth for server state.
 */
export const useGraphDraftStore = create<GraphDraftStore>((set) => ({
  drafts: {},
  updateDraft: (workflowKey, savedWorkflow, update) =>
    set((state) => {
      const current = state.drafts[workflowKey]?.workflow ?? savedWorkflow
      return {
        drafts: {
          ...state.drafts,
          [workflowKey]: { workflow: update(current), dirty: true },
        },
      }
    }),
  discardDraft: (workflowKey) =>
    set((state) => {
      if (!state.drafts[workflowKey]) return state
      const drafts = { ...state.drafts }
      delete drafts[workflowKey]
      return { drafts }
    }),
  clearAllDrafts: () => set({ drafts: {} }),
}))

export function workflowDraftKey(workspaceId: string, workflowId: string): string {
  return `${workspaceId}::${workflowId}`
}

export function getGraphDraft(workflowKey: string): GraphDraft | undefined {
  return useGraphDraftStore.getState().drafts[workflowKey]
}
