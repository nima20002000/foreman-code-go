import { useCallback, useEffect, useMemo, useRef, type ReactNode, type SyntheticEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation } from '@tanstack/react-router'
import type { WorkflowRunSummary } from '@graphql/contracts'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@graphql/contracts/wave25'
import { Button, Dialog, Drawer, Icon, IconButton, Toolbar } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { RunBoardSlot } from '../run-board'
import { RunsSelector, useSelectedRun } from '../runs-selector'
import { ScheduleClockButton } from '../schedules'
import { CurrentRunObserver } from './CurrentRunObserver'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { boardDraftContextKey } from './keys'
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
  const location = useLocation()
  const selectedRun = useSelectedRun({ workspaceId, workflowId })
  // The existing Board keeps its editor and pinned Run inspector for its own
  // runId search. The new selector and Run deep links show immutable history.
  const legacyRun = requestedRun?.workspaceId === workspaceId && requestedRun.workflowId === workflowId
    && !location.search.selectedRunId && !location.pathname.includes('/runs/') ? requestedRun : undefined
  const boardSelection = legacyRun ? { ...selectedRun, identity: { ...selectedRun.identity, runId: null } } : selectedRun
  const current = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId === null
  const currentRef = useRef(current)
  currentRef.current = current
  // Shares the persisted-boundary query. Never infer saved-ness from a client id,
  // an unsaved graph, or the selected historical snapshot's version.
  const saved = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }), staleTime: 3000, retry: false })
  const locationKey = JSON.stringify(['board-location-dialog', workspaceId, workflowId])
  const locationOpen = useInspectionPresentation((state) => !!state.open[locationKey])
  const setLocationOpen = useCallback((open: boolean) => {
    if (!open || currentRef.current) useInspectionPresentation.getState().setOpen(locationKey, open)
  }, [locationKey])
  const runsKey = JSON.stringify(['board-run-drawer', workspaceId, workflowId])
  const runsOpen = useInspectionPresentation((state) => !!state.open[runsKey])
  const toolbar = useRef<HTMLElement>(null)
  const detailsTrigger = useRef<HTMLButtonElement>(null)
  const setRunsOpen = useCallback((open: boolean) => {
    if (open && !currentRef.current) return
    useInspectionPresentation.getState().setOpen(runsKey, open)
    if (!open) setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        ;(detailsTrigger.current ?? toolbar.current?.querySelector<HTMLButtonElement>('button[aria-label="Runs"]'))?.focus()
      }
    }, 0)
  }, [runsKey])
  const linkedInspection = legacyRun && (inspection.runNodeId || inspection.runRelationshipId || inspection.runExchangeKey)
    ? JSON.stringify([legacyRun, inspection]) : undefined
  useEffect(() => { if (linkedInspection) setRunsOpen(true) }, [linkedInspection, setRunsOpen])
  useEffect(() => {
    if (!current) setRunsOpen(false)
  }, [current, setRunsOpen])
  useEffect(() => () => {
    useInspectionPresentation.getState().setOpen(runsKey, false)
    useInspectionPresentation.getState().setOpen(locationKey, false)
  }, [runsKey, locationKey])
  useEffect(() => {
    // The preserved editor owns a window-level undo/redo listener. inert only
    // blocks its DOM, not that listener. Leave text inputs and dialogs alone.
    const shortcut = (event: KeyboardEvent) => {
      if (currentRef.current || (!event.ctrlKey && !event.metaKey) || event.altKey
        || !['z', 'y', 's'].includes(event.key.toLowerCase())) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      event.preventDefault(); event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  }, [])
  const activeRuns = summaries.filter((item) => item.workspaceId === workspaceId && item.workflowId === workflowId && isActiveRun(item)).length
  // History is rendered only by RunBoardSlot. Do not feed legacy Run pins to the
  // hidden editor/SelectedRunCanvas, or fabricate missing version/semantics pins.
  const value = useMemo(() => ({ workspaceId, workflowId, run: legacyRun, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent,
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns,
  }), [workspaceId, workflowId, legacyRun, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns, setRunsOpen, setLocationOpen])
  const authoringEvent = (event: SyntheticEvent) => {
    // React capture also covers descendants portalled outside the inert subtree.
    if (!currentRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  return <WorkflowBoardContext.Provider value={value}>
    <div className="unified-workflow-board" data-testid="unified-workflow-board" style={{ flexDirection: 'column' }}>
      <header ref={toolbar} className="board-topbar" aria-label="Board toolbar"
        style={{ position: 'static', flex: '0 0 auto', justifyContent: 'flex-end', padding: 'var(--space-2)', boxSizing: 'border-box', minWidth: 0 }}>
        <Toolbar label="Schedule and runs">
          <ScheduleClockButton workspaceId={workspaceId} workflowId={workflowId} isSaved={Boolean(saved.data?.draft.baseWorkflowVersionId)} />
          <RunsSelector selection={selectedRun} />
          <span aria-hidden="true" data-board-slot="files" style={{ flex: '0 0 28px', width: 28 }} />
        </Toolbar>
      </header>
      <RunBoardSlot selection={boardSelection}>
        <div className="workflow-board-authoring" onClickCapture={authoringEvent} onKeyDownCapture={authoringEvent} onSubmitCapture={authoringEvent}>
          {children}
          {legacyRun ? <CurrentRunObserver scope={legacyRun} /> : null}
          {legacyRun ? <div className="board-run-banner" role="status">
            <Icon name="history" size={15} />
            <RunContextLabel scope={legacyRun} />
            <Button ref={detailsTrigger} size="sm" variant="ghost" onClick={() => setRunsOpen(true)}>Details</Button>
            <IconButton size="sm" variant="ghost" label="Stop showing this run" onClick={() => selectRun()}><Icon name="close" size={14} /></IconButton>
          </div> : null}
          <Drawer open={current && runsOpen} onOpenChange={setRunsOpen} title="Runs" className="workflow-board-runs-dialog"
            closeLabel="Close runs" size="lg" closeOnOutsideClick returnFocusRef={detailsTrigger}>
            {current ? <RunActivityPanel summaries={summaries} /> : null}
          </Drawer>
          <Dialog open={current && locationOpen} onOpenChange={setLocationOpen} title="Execution folder" closeLabel="Close execution folder"
            description="Where agents work on files. It applies to future runs; runs already started keep their folder.">
            <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="field" />
          </Dialog>
        </div>
      </RunBoardSlot>
    </div>
  </WorkflowBoardContext.Provider>
}

function RunContextLabel({ scope }: { scope: RepeatGraphScopeV3 }) {
  const record = useSelectedRunRecord()
  return <span>Showing run <code>{scope.runId.slice(-8)}</code> · {record
    ? record.state.run.executionState === 'completed' ? 'Past Run facts' : `Active Run · recorded cut ${record.asOfSequence}`
    : 'Status unavailable'} · pinned version <code>{scope.workflowVersionId}</code></span>
}
