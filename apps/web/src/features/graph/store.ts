import { create } from 'zustand'

import type { Agent, WorkflowDefinition } from '@graphql/contracts'

import { sameWorkflow } from './mapper'

export type GraphSaveSnapshot = {
  workflow: WorkflowDefinition
  agentOverrides: Record<string, Agent>
}

export type GraphDraft = GraphSaveSnapshot & {
  dirty: true
}

type GraphDraftStore = {
  drafts: Record<string, GraphDraft>
  updateDraft: (
    workflowKey: string,
    savedWorkflow: WorkflowDefinition,
    update: (workflow: WorkflowDefinition) => WorkflowDefinition,
    agents?: readonly Agent[],
  ) => void
  completeSave: (
    workflowKey: string,
    submitted: GraphSaveSnapshot,
    savedWorkflow: WorkflowDefinition,
    savedAgents: readonly Agent[],
  ) => void
  discardDraft: (workflowKey: string) => void
  clearAllDrafts: () => void
}

/**
 * Graph and agent edits have one workflow-scoped lifetime. Query remains the
 * owner of saved state; only unsaved overrides live here. All updates are
 * immutable so a save can retain its exact submitted snapshot across remounts.
 */
export const useGraphDraftStore = create<GraphDraftStore>((set) => ({
  drafts: {},
  updateDraft: (workflowKey, savedWorkflow, update, agents = []) =>
    set((state) => {
      const draft = state.drafts[workflowKey]
      const nextWorkflow = update(draft?.workflow ?? savedWorkflow)
      const overrides = { ...draft?.agentOverrides }
      for (const agent of agents) overrides[agent.id] = agent
      const referenced = new Set(nextWorkflow.nodes.map((node) => node.agentId))
      const agentOverrides = Object.fromEntries(
        Object.entries(overrides).filter(([id]) => referenced.has(id)),
      )
      if (!sameWorkflow(nextWorkflow, savedWorkflow) || Object.keys(agentOverrides).length > 0) {
        return {
          drafts: {
            ...state.drafts,
            [workflowKey]: { workflow: nextWorkflow, agentOverrides, dirty: true },
          },
        }
      }
      if (!draft) return state
      const drafts = { ...state.drafts }
      delete drafts[workflowKey]
      return { drafts }
    }),
  completeSave: (workflowKey, submitted, savedWorkflow, savedAgents) =>
    set((state) => {
      const draft = state.drafts[workflowKey]
      if (!draft) return state
      const savedById = new Map(savedAgents.map((agent) => [agent.id, agent]))
      const agentOverrides: Record<string, Agent> = {}
      for (const [id, agent] of Object.entries(draft.agentOverrides)) {
        const sent = submitted.agentOverrides[id]
        const saved = savedById.get(id)
        // Never acknowledge settings the server did not confirm.
        if (!sent || !saved) {
          agentOverrides[id] = agent
          continue
        }
        if (JSON.stringify(agent) === JSON.stringify(sent)) continue
        // Preserve newer values, but advance the base of our own in-flight
        // edit so its next save does not conflict with the just-saved version.
        agentOverrides[id] = agent.configurationVersionId === sent.configurationVersionId
          ? {
              ...agent,
              configurationVersionId: saved.configurationVersionId,
              createdAt: saved.createdAt ?? agent.createdAt,
              updatedAt: saved.updatedAt,
            }
          : agent
      }
      const workflow = sameWorkflow(draft.workflow, submitted.workflow)
        ? savedWorkflow
        : {
            ...draft.workflow,
            id: savedWorkflow.id,
            workspaceId: savedWorkflow.workspaceId,
            version: savedWorkflow.version,
            createdAt: savedWorkflow.createdAt,
            updatedAt: savedWorkflow.updatedAt,
          }
      const drafts = { ...state.drafts }
      delete drafts[workflowKey]
      if (!sameWorkflow(workflow, savedWorkflow) || Object.keys(agentOverrides).length > 0) {
        drafts[workflowDraftKey(savedWorkflow.workspaceId, savedWorkflow.id)] = {
          workflow,
          agentOverrides,
          dirty: true,
        }
      }
      return { drafts }
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
