import { createContext, useContext, type ReactNode } from 'react'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'

/** Callbacks and presentation context only; neither drafts nor Run facts live here. */
export const WorkflowBoardContext = createContext<{
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection
  selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void
  openLocation(): void
  openRuns(): void
  navigationControls?: ReactNode
  authoringActive?: boolean
  /** Active or recovering Runs in the workspace; saving meaningful edits may stop them. */
  activeRuns: number
} | null>(null)
export const useWorkflowBoard = () => useContext(WorkflowBoardContext)
