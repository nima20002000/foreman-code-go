import { create } from 'zustand'
import { clearEditIntentStorage } from './nextDraft/editIntentStorage'
import { clearNextDraftStartStorage, createNextDraftSlice, type NextDraftSlice } from './nextDraft/state'
import type { Agent, WorkflowDefinition } from '@graphql/contracts'
import { sameWorkflow } from './mapper'
import { sameEditableGraph, sameManagedValue, type ManagedEditBase, type CloneSources } from './managedGraphState'

export type GraphSaveSnapshot = {
  workflow: WorkflowDefinition
  agentOverrides: Record<string, Agent>
  managedBase?: ManagedEditBase
  cloneSources?: CloneSources
}
export type GraphDraft = GraphSaveSnapshot & { dirty: true }

type GraphDraftStore = NextDraftSlice & {
  drafts: Record<string, GraphDraft>
  managedSaving: Record<string, boolean>
  acknowledgedBases: Record<string, ManagedEditBase>
  updateDraft: (
    workflowKey: string, savedWorkflow: WorkflowDefinition,
    update: (workflow: WorkflowDefinition) => WorkflowDefinition,
    agents?: readonly Agent[], managedBase?: ManagedEditBase, cloneSources?: CloneSources,
  ) => void
  completeSave: (
    workflowKey: string, submitted: GraphSaveSnapshot, savedWorkflow: WorkflowDefinition,
    savedAgents: readonly Agent[], managedBase?: ManagedEditBase,
  ) => void
  acknowledgeManagedBase: (workflowKey: string, base: ManagedEditBase) => void
  restoreDraft: (workflowKey: string, saved: WorkflowDefinition, snapshot: GraphSaveSnapshot) => void
  setManagedSaving: (workflowKey: string, saving: boolean) => void
  discardDraft: (workflowKey: string) => void
  clearAllDrafts: () => void
}

function retainReferences<T>(values: Readonly<Record<string, T>> | undefined, workflow: WorkflowDefinition): Record<string, T> {
  const referenced = new Set(workflow.nodes.map((node) => node.agentId))
  return Object.fromEntries(Object.entries(values ?? {}).filter(([id]) => referenced.has(id)))
}

/** Apply only the server normalization of our acknowledged submission, not newer local edits. */
function rebaseEntities<T extends { id: string }>(current: T[], sent: T[], saved: T[]): T[] {
  const sentById = new Map(sent.map((item) => [item.id, item]))
  const savedById = new Map(saved.map((item) => [item.id, item]))
  return current.map((item) => {
    const before = sentById.get(item.id)
    const after = savedById.get(item.id)
    if (!before || !after) return item
    const merged = { ...item } as Record<string, unknown>
    const currentRecord = item as Record<string, unknown>
    const beforeRecord = before as Record<string, unknown>
    const afterRecord = after as Record<string, unknown>
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!sameManagedValue(currentRecord[key], beforeRecord[key])) continue
      if (Object.hasOwn(after, key)) merged[key] = afterRecord[key]
      else delete merged[key]
    }
    return merged as T
  })
}

export const useGraphDraftStore = create<GraphDraftStore>((set) => ({
  ...createNextDraftSlice(set),
  drafts: {},
  managedSaving: {},
  acknowledgedBases: {},
  updateDraft: (workflowKey, savedWorkflow, update, agents = [], suppliedBase, sources = {}) => set((state) => {
    const previous = state.drafts[workflowKey]
    const managedBase = previous?.managedBase ?? suppliedBase
    const comparison = managedBase?.draft.graph ?? savedWorkflow
    const workflow = update(previous?.workflow ?? savedWorkflow)
    const agentOverrides = retainReferences({ ...previous?.agentOverrides, ...Object.fromEntries(agents.map((agent) => [agent.id, agent])) }, workflow)
    const cloneSources = retainReferences({ ...previous?.cloneSources, ...sources }, workflow)
    const changed = managedBase ? !sameEditableGraph(workflow, comparison) : !sameWorkflow(workflow, comparison)
    if (changed || Object.keys(agentOverrides).length > 0 || (previous && state.managedSaving[workflowKey])) return { drafts: { ...state.drafts, [workflowKey]: {
      workflow, agentOverrides, dirty: true, ...(managedBase ? { managedBase } : {}), cloneSources,
    } } }
    if (!previous) return state
    const drafts = { ...state.drafts }; delete drafts[workflowKey]
    return { drafts }
  }),
  acknowledgeManagedBase: (workflowKey, managedBase) => set((state) => {
    const current = state.drafts[workflowKey]
    const acknowledgedBases = { ...state.acknowledgedBases, [workflowKey]: managedBase }
    if (!current) return { acknowledgedBases }
    return { drafts: { ...state.drafts, [workflowKey]: { ...current, managedBase } }, acknowledgedBases }
  }),
  completeSave: (workflowKey, submitted, savedWorkflow, savedAgents, managedBase) => set((state) => {
    const draft = state.drafts[workflowKey]
    const acknowledgedBases = managedBase ? { ...state.acknowledgedBases, [workflowKey]: managedBase } : state.acknowledgedBases
    if (!draft) return { acknowledgedBases }
    const savedById = new Map(savedAgents.map((agent) => [agent.id, agent]))
    const agentOverrides: Record<string, Agent> = {}
    for (const [id, agent] of Object.entries(draft.agentOverrides)) {
      const sent = submitted.agentOverrides[id]
      const saved = savedById.get(id)
      if (!sent || !saved) { agentOverrides[id] = agent; continue }
      if (sameManagedValue(agent, sent)) continue
      agentOverrides[id] = agent.configurationVersionId === sent.configurationVersionId
        ? { ...agent, configurationVersionId: saved.configurationVersionId,
            createdAt: saved.createdAt ?? agent.createdAt, updatedAt: saved.updatedAt }
        : agent
    }
    const workflow = (managedBase ? sameEditableGraph(draft.workflow, submitted.workflow) : sameWorkflow(draft.workflow, submitted.workflow)) ? savedWorkflow : {
      ...draft.workflow,
      id: savedWorkflow.id, workspaceId: savedWorkflow.workspaceId,
      name: savedWorkflow.name, description: savedWorkflow.description,
      version: savedWorkflow.version, createdAt: savedWorkflow.createdAt, updatedAt: savedWorkflow.updatedAt,
      ...(managedBase ? {
        nodes: rebaseEntities(draft.workflow.nodes, submitted.workflow.nodes, savedWorkflow.nodes),
        edges: rebaseEntities(draft.workflow.edges, submitted.workflow.edges, savedWorkflow.edges),
        approval: sameManagedValue(draft.workflow.approval, submitted.workflow.approval)
          ? savedWorkflow.approval : draft.workflow.approval,
        requiredAgentCount: sameManagedValue(draft.workflow.requiredAgentCount, submitted.workflow.requiredAgentCount)
          ? savedWorkflow.requiredAgentCount : draft.workflow.requiredAgentCount,
        executionPolicy: sameManagedValue(draft.workflow.executionPolicy, submitted.workflow.executionPolicy)
          ? savedWorkflow.executionPolicy : draft.workflow.executionPolicy,
      } : {}),
    }
    const drafts = { ...state.drafts }; delete drafts[workflowKey]
    const changed = managedBase ? !sameEditableGraph(workflow, savedWorkflow) : !sameWorkflow(workflow, savedWorkflow)
    if (changed || Object.keys(agentOverrides).length > 0) drafts[workflowDraftKey(savedWorkflow.workspaceId, savedWorkflow.id)] = {
      workflow, agentOverrides, dirty: true, ...(managedBase ? { managedBase } : {}),
      cloneSources: retainReferences(draft.cloneSources, workflow),
    }
    return { drafts, acknowledgedBases }
  }),
  restoreDraft: (workflowKey, saved, snapshot) => set((state) => {
    // An acknowledged own save may advance the base after this Undo snapshot.
    // Undo changes content, never rewinds that concurrency token.
    const currentBase = state.drafts[workflowKey]?.managedBase
    const acknowledged = state.acknowledgedBases[workflowKey]
    let base = currentBase ?? snapshot.managedBase
    if (acknowledged && (!base || (base.draft.id === acknowledged.draft.id && acknowledged.draft.revision > base.draft.revision))) base = acknowledged
    const byId = new Map(base?.agents.map((agent) => [agent.id, agent]))
    const overrides = Object.fromEntries(Object.entries(snapshot.agentOverrides).map(([id, agent]) => {
      const current = byId.get(id)
      return [id, current ? { ...agent, configurationVersionId: current.configurationVersionId } : agent]
    }))
    const comparison = base?.draft.graph ?? saved
    const drafts = { ...state.drafts }
    const changed = base ? !sameEditableGraph(snapshot.workflow, comparison) : !sameWorkflow(snapshot.workflow, comparison)
    if (changed || Object.keys(overrides).length) drafts[workflowKey] = {
      ...snapshot, agentOverrides: overrides, dirty: true, ...(base ? { managedBase: base } : {}),
    }
    else delete drafts[workflowKey]
    return { drafts }
  }),
  setManagedSaving: (workflowKey, saving) => set((state) => {
    const managedSaving = { ...state.managedSaving }
    if (saving) managedSaving[workflowKey] = true
    else delete managedSaving[workflowKey]
    return { managedSaving }
  }),
  discardDraft: (workflowKey) => set((state) => {
    if (state.managedSaving[workflowKey] || !state.drafts[workflowKey]) return state
    const drafts = { ...state.drafts }; delete drafts[workflowKey]
    return { drafts }
  }),
  clearAllDrafts: () => { clearNextDraftStartStorage(); clearEditIntentStorage(); set({ drafts: {}, managedSaving: {}, acknowledgedBases: {}, nextDrafts: {}, nextDraftPromotions: {}, pendingRunStarts: {} }) },
}))

export function workflowDraftKey(workspaceId: string, workflowId: string): string { return `${workspaceId}::${workflowId}` }
export function getGraphDraft(workflowKey: string): GraphDraft | undefined { return useGraphDraftStore.getState().drafts[workflowKey] }
