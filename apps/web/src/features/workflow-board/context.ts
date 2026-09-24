import { createContext, useContext } from 'react'
import type { RunGraphScope, WorkspaceBoardInspection } from '@graphql/contracts/wave25'

/** Callbacks and presentation context only; neither drafts nor Run facts live here. */
export const WorkflowBoardContext = createContext<{
  workspaceId: string; workflowId: string; run?: RunGraphScope
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection
  selectInspection(inspection: WorkspaceBoardInspection): void
  conversionRequested: boolean
  closeConversion(): void
  selectRun(scope?: RunGraphScope): void
  requestConversion(): void
  openLocation(): void
  openRuns(): void
  /** Active or recovering Runs in the workspace; saving meaningful edits may stop them. */
  activeRuns: number
} | null>(null)
export const useWorkflowBoard = () => useContext(WorkflowBoardContext)
