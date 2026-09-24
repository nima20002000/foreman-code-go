import { useMemo, useState, type ReactNode } from 'react'
import type { WorkflowRunSummary } from '@graphql/contracts'
import type { RunGraphScope, WorkspaceBoardInspection } from '@graphql/contracts/wave25'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { WorkflowBoardContext } from './context'
import { RunActivityPanel } from './RunActivityPanel'
import './workflowBoard.css'

/** This component is keyed by workspace/workflow only, NEVER by selected Run. */
export function WorkflowBoard({ workspaceId, workflowId, run, selectRun, inspection, selectInspection, summaries, children, selectedAgentId, selectDraftAgent }: {
  workspaceId: string; workflowId: string; run?: RunGraphScope
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection; selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RunGraphScope): void; summaries: readonly WorkflowRunSummary[]; children: ReactNode
}) {
  const [conversionRequested, setConversionRequested] = useState(false)
  const [locationOpen, setLocationOpen] = useState(false)
  const value = useMemo(() => ({ workspaceId, workflowId, run, selectRun, inspection, selectInspection, conversionRequested, selectedAgentId, selectDraftAgent,
    requestConversion: () => setConversionRequested(true), closeConversion: () => setConversionRequested(false),
    openLocation: () => setLocationOpen(true),
  }), [workspaceId, workflowId, run, selectRun, inspection, selectInspection, conversionRequested, selectedAgentId, selectDraftAgent])
  return <WorkflowBoardContext.Provider value={value}>
    <div className="unified-workflow-board" data-testid="unified-workflow-board">
      <div className="workflow-board-authoring">{children}</div>
      <div className="workflow-board-context">
        <RunActivityPanel summaries={summaries} />
        <details className="workflow-board-location n-theme" open={locationOpen} onToggle={(event) => setLocationOpen(event.currentTarget.open)}>
          <summary>Workspace execution folder</summary>
          <p>For future Runs only. Existing Runs keep their accepted location.</p>
          <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="field" />
        </details>
      </div>
    </div>
  </WorkflowBoardContext.Provider>
}
