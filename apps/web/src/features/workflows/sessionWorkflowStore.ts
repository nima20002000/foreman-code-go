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
  createSessionWorkflow: (input: SessionWorkflowInput) => WorkflowDefinition
  saveSessionWorkflow: (workflow: WorkflowDefinition) => void
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
  clearSessionWorkflows: () => set({ workflows: {} }),
}))
