import { create } from 'zustand'

import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@graphql/contracts'

export interface SessionWorkflowInput {
  workspaceId: string
  name: string
  description?: string
}

interface SessionWorkflowState {
  /** Session-created workflow definitions keyed by their generated draft id. */
  workflows: Record<string, WorkflowDefinition>
  workflowNameOverrides: Readonly<Record<string, string>>
  hiddenWorkflowIds: readonly string[]
  createSessionWorkflow: (input: SessionWorkflowInput) => WorkflowDefinition
  saveSessionWorkflow: (workflow: WorkflowDefinition) => void
  removeWorkspaceWorkflows: (workspaceId: string) => void
  renameWorkflow: (workflowId: string, name: string) => void
  removeWorkflow: (workflowId: string) => void
  clearSessionWorkflows: () => void
}

let draftSequence = 0

function nextDraftId(): string {
  draftSequence += 1
  return `draft-${draftSequence.toString(36)}`
}

/**
 * Workflows created from the New workflow page exist only in this browser
 * session. They are local interaction state, not server state: no request is
 * sent, the workspace query is not touched, and a reload removes them.
 */
export const useSessionWorkflowStore = create<SessionWorkflowState>((set) => ({
  workflows: {},
  workflowNameOverrides: {},
  hiddenWorkflowIds: [],
  createSessionWorkflow: (input) => {
    const name = input.name.trim()
    const description = input.description?.trim()
    const workflow = WorkflowDefinitionSchema.parse({
      id: nextDraftId(),
      workspaceId: input.workspaceId,
      name,
      ...(description ? { description } : {}),
      executionCondition: { kind: 'manual' },
      nodes: [],
      edges: [],
    })
    set((state) => ({ workflows: { ...state.workflows, [workflow.id]: workflow } }))
    return workflow
  },
  saveSessionWorkflow: (workflow) =>
    set((state) => {
      if (!state.workflows[workflow.id]) return state
      return { workflows: { ...state.workflows, [workflow.id]: workflow } }
    }),
  removeWorkspaceWorkflows: (workspaceId) =>
    set((state) => ({
      workflows: Object.fromEntries(
        Object.entries(state.workflows).filter(([, workflow]) => workflow.workspaceId !== workspaceId),
      ),
    })),
  renameWorkflow: (workflowId, name) =>
    set((state) => {
      const workflow = state.workflows[workflowId]
      return {
        workflows: workflow
          ? { ...state.workflows, [workflowId]: { ...workflow, name } }
          : state.workflows,
        workflowNameOverrides: { ...state.workflowNameOverrides, [workflowId]: name },
      }
    }),
  removeWorkflow: (workflowId) =>
    set((state) => {
      const workflows = { ...state.workflows }
      delete workflows[workflowId]
      return {
        workflows,
        hiddenWorkflowIds: [...new Set([...state.hiddenWorkflowIds, workflowId])],
      }
    }),
  clearSessionWorkflows: () => set({
    workflows: {},
    workflowNameOverrides: {},
    hiddenWorkflowIds: [],
  }),
}))
