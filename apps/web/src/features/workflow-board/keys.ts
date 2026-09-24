import { sessionGeneration } from '../../shared/api/sessionBoundary'
export const boardDraftContextKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'board-draft-context', sessionGeneration(), workspaceId, workflowId] as const
export const boardRunListKey = (workspaceId: string, workflowId: string) =>
  ['workbench', 'board-runs', sessionGeneration(), workspaceId, workflowId] as const
