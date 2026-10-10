import { useCallback, useEffect, useMemo, useRef, type ReactNode, type SyntheticEvent } from 'react'
import { useLocation } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'
import { Dialog, Drawer } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { RunBoardSlot } from '../run-board'
import { runsSelectorApi, useSelectedRun, useSelectedRunSnapshot } from '../runs-selector'
import { BoardNavigationControls } from './BoardNavigationControls'
import { CurrentRunObserver } from './CurrentRunObserver'
import { WorkflowBoardContext } from './context'
import { RunActivityPanel } from './RunActivityPanel'
import { isActiveRun, shortRunId } from './runFacts'
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
  // Canonical and legacy Run links share the pinned canvas and retained editor.
  const legacyRun = requestedRun?.workspaceId === workspaceId && requestedRun.workflowId === workflowId
    && !location.search.selectedRunId ? requestedRun : undefined
  // A Run picked from Runs opens on this Board (live node cards and their native
  // subagents), not on the separate saved-topology page; only legacy Runs without a
  // captured version stay there.
  const picked = useSelectedRunSnapshot(selectedRun).snapshot
  const pickedRunId = location.search.selectedRunId
  useEffect(() => {
    if (picked?.kind !== 'available' || picked.runId !== pickedRunId || location.pathname.includes('/runs/')) return
    selectRun({ workspaceId, workflowId, runId: picked.runId, workflowVersionId: picked.workflowVersionId, executionSemanticsVersion: 3 })
  }, [picked, pickedRunId, location.pathname, selectRun, workspaceId, workflowId])
  // A live Run takes over the Board so its nodes and native subagents show real
  // state. "Stop showing this run" returns to editing and is not undone.
  const dismissed = useRef(new Set<string>())
  const shownRunId = useRef<string | undefined>(undefined)
  if (shownRunId.current && shownRunId.current !== legacyRun?.runId) dismissed.current.add(shownRunId.current)
  shownRunId.current = legacyRun?.runId
  const live = !requestedRun && !pickedRunId && !location.pathname.includes('/runs/')
    ? summaries.filter((item) => item.workspaceId === workspaceId && item.workflowId === workflowId && isActiveRun(item)
      && !dismissed.current.has(item.id)).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]
    : undefined
  const liveSnapshot = useQuery({ queryKey: ['board-live-run-snapshot', workspaceId, workflowId, live?.id],
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId, workflowId, runId: live!.id }, { signal }),
    enabled: Boolean(live), staleTime: Infinity }).data?.snapshot
  useEffect(() => {
    if (!live || liveSnapshot?.kind !== 'available' || liveSnapshot.runId !== live.id) return
    selectRun({ workspaceId, workflowId, runId: live.id, workflowVersionId: liveSnapshot.workflowVersionId, executionSemanticsVersion: 3 })
  }, [live, liveSnapshot, selectRun, workspaceId, workflowId])
  const boardSelection = legacyRun ? { ...selectedRun, identity: { ...selectedRun.identity, runId: null } } : selectedRun
  const current = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId === null
  const currentRef = useRef(current)
  currentRef.current = current
  const locationKey = JSON.stringify(['board-location-dialog', workspaceId, workflowId])
  const locationOpen = useInspectionPresentation((state) => !!state.open[locationKey])
  const setLocationOpen = useCallback((open: boolean) => {
    if (!open || currentRef.current) useInspectionPresentation.getState().setOpen(locationKey, open)
  }, [locationKey])
  const runsKey = JSON.stringify(['board-run-drawer', workspaceId, workflowId])
  const runsOpen = useInspectionPresentation((state) => !!state.open[runsKey])
  const toolbar = useRef<HTMLDivElement>(null)
  const setRunsOpen = useCallback((open: boolean) => {
    if (open && !currentRef.current) return
    useInspectionPresentation.getState().setOpen(runsKey, open)
    if (!open) setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        toolbar.current?.querySelector<HTMLButtonElement>('button[aria-label="Activities"]')?.focus()
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
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns, authoringActive: current,
    navigationControls: current ? <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={selectedRun} /> : undefined,
  }), [workspaceId, workflowId, legacyRun, selectRun, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns, setRunsOpen, setLocationOpen, selectedRun, current])
  const authoringEvent = (event: SyntheticEvent) => {
    // React capture also covers descendants portalled outside the inert subtree.
    if (!currentRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  return <WorkflowBoardContext.Provider value={value}>
    <div ref={toolbar} className="unified-workflow-board" data-testid="unified-workflow-board" style={{ flexDirection: 'column' }}>
      {!current ? <header className="board-topbar" aria-label="Board toolbar"
        style={{ position: 'static', flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end', padding: 'var(--space-2)', boxSizing: 'border-box', minWidth: 0 }}>
        <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={selectedRun} />
      </header> : null}
      <RunBoardSlot selection={boardSelection}>
        <div className="workflow-board-authoring" onClickCapture={authoringEvent} onKeyDownCapture={authoringEvent} onSubmitCapture={authoringEvent}>
          {children}
          {legacyRun ? <CurrentRunObserver scope={legacyRun} /> : null}
          {legacyRun ? <div className="board-run-tag" role="status">
            <RunContextLabel scope={legacyRun} />
          </div> : null}
          <Drawer open={current && runsOpen} onOpenChange={setRunsOpen} title="Activities" className="workflow-board-runs-dialog"
            closeLabel="Close runs" size="lg" closeOnOutsideClick>
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
  return <span>Run <code title={scope.runId}>{shortRunId(scope.runId)}</code></span>
}
