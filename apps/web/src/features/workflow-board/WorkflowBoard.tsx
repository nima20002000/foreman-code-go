import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { WorkflowRunSummary } from '@graphql/contracts'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@graphql/contracts/wave25'
import { Button, Dialog, Drawer, Icon, IconButton } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { CurrentRunObserver } from './currentRunQuery'
import { WorkflowBoardContext } from './context'
import { RunActivityPanel } from './RunActivityPanel'
import { isActiveRun, useSelectedRunRecord } from './runFacts'
import { useInspectionPresentation } from './inspect/presentation'
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
  const locationKey = JSON.stringify(['board-location-dialog', workspaceId, workflowId])
  const locationOpen = useInspectionPresentation((state) => !!state.open[locationKey])
  const setLocationOpen = useCallback((open: boolean) => useInspectionPresentation.getState().setOpen(locationKey, open), [locationKey])
  const runsKey = JSON.stringify(['board-run-drawer', workspaceId, workflowId])
  const runsOpen = useInspectionPresentation((state) => !!state.open[runsKey])
  const detailsTrigger = useRef<HTMLButtonElement>(null)
  const setRunsOpen = useCallback((open: boolean) => {
    useInspectionPresentation.getState().setOpen(runsKey, open)
    if (!open) setTimeout(() => {
      // A Run switch can remove the node which originally opened the Drawer.
      // Preserve its normal focus return, using the stable Details button only
      // when that original target no longer exists.
      if (!document.activeElement || document.activeElement === document.body) detailsTrigger.current?.focus()
    }, 0)
  }, [runsKey])
  const linkedInspection = run && (inspection.runNodeId || inspection.runRelationshipId || inspection.runExchangeKey)
    ? JSON.stringify([run, inspection]) : undefined
  useEffect(() => { if (linkedInspection) setRunsOpen(true) }, [linkedInspection, setRunsOpen])
  useEffect(() => () => {
    useInspectionPresentation.getState().setOpen(runsKey, false)
    useInspectionPresentation.getState().setOpen(locationKey, false)
  }, [runsKey, locationKey])
  const activeRuns = summaries.filter((item) => item.workspaceId === workspaceId && item.workflowId === workflowId && isActiveRun(item)).length
  const value = useMemo(() => ({ workspaceId, workflowId, run, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent,
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns,
  }), [workspaceId, workflowId, run, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns, setRunsOpen, setLocationOpen])
  return <WorkflowBoardContext.Provider value={value}>
    <div className="unified-workflow-board" data-testid="unified-workflow-board">
      {run ? <p className="board-run-context-note">Canvas and Run inspector: selected immutable Run. Draft controls: changes for future Runs only.</p> : null}
      <div className="workflow-board-authoring">{children}</div>
      {/* Holds the selected Run's sync so board nodes can show its state; renders nothing. */}
      {run ? <CurrentRunObserver scope={run} /> : null}
      {run ? <div className="board-run-banner" role="status">
        <Icon name="history" size={15} />
        <RunContextLabel scope={run} />
        <Button ref={detailsTrigger} size="sm" variant="ghost" onClick={() => setRunsOpen(true)}>Details</Button>
        <IconButton size="sm" variant="ghost" label="Stop showing this run" onClick={() => selectRun()}><Icon name="close" size={14} /></IconButton>
      </div> : null}
    </div>
    <Drawer open={runsOpen} onOpenChange={setRunsOpen} title="Runs" description="Select current or past Runs in this same Board. The canvas shows the selected Run’s saved topology; draft edits never change it."
      closeLabel="Close runs" size="lg" closeOnOutsideClick>
      <RunActivityPanel summaries={summaries} />
    </Drawer>
    <Dialog open={locationOpen} onOpenChange={setLocationOpen} title="Execution folder" closeLabel="Close execution folder"
      description="Where agents work on files. It applies to future runs; runs already started keep their folder.">
      <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="field" />
    </Dialog>
  </WorkflowBoardContext.Provider>
}

function RunContextLabel({ scope }: { scope: RepeatGraphScopeV3 }) {
  const record = useSelectedRunRecord()
  return <span>Showing run <code>{scope.runId.slice(-8)}</code> · {record
    ? record.state.run.executionState === 'completed' ? 'Past Run facts' : `Active Run · recorded cut ${record.asOfSequence}`
    : 'Status unavailable'} · pinned version <code>{scope.workflowVersionId}</code></span>
}
