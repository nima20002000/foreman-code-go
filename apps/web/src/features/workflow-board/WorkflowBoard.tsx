import { useMemo, useState, type ReactNode } from 'react'
import type { WorkflowRunSummary } from '@graphql/contracts'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@graphql/contracts/wave25'
import { Button, Dialog, Drawer, Icon, IconButton } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { CurrentRunObserver } from './currentRunQuery'
import { WorkflowBoardContext } from './context'
import { RunActivityPanel } from './RunActivityPanel'
import { isActiveRun } from './runFacts'
import './workflowBoard.css'

/** This component is keyed by workspace/workflow only, NEVER by selected Run. */
export function WorkflowBoard({ workspaceId, workflowId, run: requestedRun, selectRun, inspection, selectInspection, summaries, children, selectedAgentId, selectDraftAgent }: {
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection; selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void; summaries: readonly WorkflowRunSummary[]; children: ReactNode
}) {
  // A Run from another workflow never labels this board.
  const run = requestedRun?.workspaceId === workspaceId && requestedRun.workflowId === workflowId ? requestedRun : undefined
  const [locationOpen, setLocationOpen] = useState(false)
  const [runsOpen, setRunsOpen] = useState(false)
  const activeRuns = summaries.filter((item) => item.workspaceId === workspaceId && item.workflowId === workflowId && isActiveRun(item)).length
  const value = useMemo(() => ({ workspaceId, workflowId, run, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent,
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns,
  }), [workspaceId, workflowId, run, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns])
  return <WorkflowBoardContext.Provider value={value}>
    <div className="unified-workflow-board" data-testid="unified-workflow-board">
      <div className="workflow-board-authoring">{children}</div>
      {/* Holds the selected Run's sync so board nodes can show its state; renders nothing. */}
      {run ? <CurrentRunObserver scope={run} /> : null}
      {run ? <div className="board-run-banner" role="status">
        <Icon name="history" size={15} />
        <span>Showing run <code>{run.runId.slice(-8)}</code></span>
        <Button size="sm" variant="ghost" onClick={() => setRunsOpen(true)}>Details</Button>
        <IconButton size="sm" variant="ghost" label="Stop showing this run" onClick={() => selectRun()}><Icon name="close" size={14} /></IconButton>
      </div> : null}
    </div>
    <Drawer open={runsOpen} onOpenChange={setRunsOpen} title="Runs" description="Pick a run to see its progress on the board. Editing never changes a run."
      closeLabel="Close runs" size="lg" closeOnOutsideClick>
      <RunActivityPanel summaries={summaries} />
    </Drawer>
    <Dialog open={locationOpen} onOpenChange={setLocationOpen} title="Execution folder" closeLabel="Close execution folder"
      description="Where agents work on files. It applies to future runs; runs already started keep their folder.">
      <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="field" />
    </Dialog>
  </WorkflowBoardContext.Provider>
}
