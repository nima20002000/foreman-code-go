import { AgentActiveTimeField } from './AgentActiveTimeField'
import { JobNodePicker } from '../../jobs'
import { attachJob } from './model'
import { BoardNotice } from './BoardNotice'
import { Inbox, Redo2, Save, Undo2 } from 'lucide-react'
import { ActionMenu, Button, ConfirmDialog, EmptyState, Icon, IconButton, TextField, Toolbar } from '../../../shared/ui/nocturne'
import { nodeTitle, removeRelationship } from './model'
import { nextDraftDirty, type NextDraftEdit } from './state'
import { WorkflowSaveError } from './WorkflowSaveError'
import { EditIntentStatus } from './EditIntentStatus'
import { ApprovalFields, AttachAgentField, EntryFields } from './AuthoringFields'
import { DraftCanvas } from './DraftCanvas'
import { NewBoardAgent } from '../../workflow-board/AgentControls'
import { AgentPickerPanel } from '../../workflow-board/AgentPickerPanel'
import { WorkflowName } from '../../workflow-board/WorkflowName'
import { WorkflowWorktreeField } from '../../workflow-board/WorkflowWorktreeField'
import { BoardUndoNotice } from '../../workflow-board/BoardUndoNotice'
import { BoardAlerts, type BoardUpdateFailure } from '../../workflow-board/BoardAlerts'
import { RemoveWorkflowButton } from '../../workflows/RemoveWorkflowButton'
import { useApprovalInboxStore } from '../../approvals'
import { RepeatEditor } from '../../repeats/RepeatEditor'
import type { useDraftEditorController } from './useDraftEditorController'

const kindName = (kind: 'execution' | 'approval') => kind === 'approval' ? 'Approval' : 'Handoff'

export function DraftEditorView({ draftKey, edit, updateFailures, controller }: {
  draftKey: string
  edit: NextDraftEdit
  updateFailures?: readonly BoardUpdateFailure[]
  controller: ReturnType<typeof useDraftEditorController>
}) {
  const { graph, context, board, editIntent, undoScope, core, preflight, pendingStart,
    reloading, stopAndSave, discardChanges, reload, startMutation, starting, start, recoverStart,
    workspace, managedWorkflow, pendingApprovals, agents, hints, requestSave, historyAction, openAgent, panels,
    scheduleWrite, historyPending } = controller
  const { panel, settingsPanel, workflowName, openSaveField, openNode, setOpenNode, confirm, setConfirm, runAfterSave,
    message, setGeometryPending, canvas, presentation, change, geometry, report, inspect, openPanel, prepare } = core
  const { dirty, needsSave, canUndo, canRedo, startReloadRequired, startDisabled, startReason, saveBusy,
    affectedRuns, affectedWorkflows, stopBlocked, errorText, locationMessage, panelTitle } = controller.status
  return <section className="workflow-graph board-typed-editor" aria-label="Workflow authoring">
    <div className="workflow-graph-canvas">
      <DraftCanvas ref={canvas} draftKey={draftKey} graph={graph} agents={agents} kind="execution"
        baseGraph={edit.context.savedDraft?.graph ?? edit.context.draft.graph}
        semanticLocked={edit.busy || reloading || editIntent.locked || starting || !!edit.pending || !!pendingStart}
        change={change} geometry={geometry} pending={setGeometryPending} report={report} inspect={inspect}
        removalDisabled={edit.busy || reloading || editIntent.locked}
        open={openNode} setOpen={setOpenNode} panels={panels} />
      {!graph.nodes.length ? <div className="board-empty"><EmptyState icon="bot" title="Add your first agent"
        description="Start with an orchestrator that plans the work, or a worker that does it."
        action={<Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={() => openPanel('agents')}>Add node</Button>} /></div> : null}
      <header className="board-topbar">
        <div className="board-title">
          <WorkflowName ref={workflowName} name={graph.name} disabled={saveBusy || starting || editIntent.locked}
            onRename={(name) => change((current) => ({ ...current, name }))} />
          <WorkflowWorktreeField workspaceId={graph.workspaceId} value={graph.defaultWorktree}
            savedValue={(edit.context.savedDraft ?? edit.context.draft).graph.defaultWorktree}
            disabled={edit.busy || reloading || editIntent.locked || starting || !!edit.pending || !!pendingStart}
            onChange={defaultWorktree => change(current => {
              const updated = { ...current }
              if (defaultWorktree) updated.defaultWorktree = defaultWorktree
              else delete updated.defaultWorktree
              return updated
            })} />
        </div>
        <div className="board-control-cluster">
          {needsSave || edit.pending || editIntent.locked || canUndo || canRedo ? <Toolbar label="Draft actions">
            {canUndo ? <IconButton label="Undo" variant="ghost" disabled={saveBusy || starting || editIntent.locked || historyPending || scheduleWrite.pending}
              onClick={() => historyAction('undo')}><Undo2 aria-hidden="true" size={16} /></IconButton> : null}
            {canRedo ? <IconButton label="Redo" variant="ghost" disabled={saveBusy || starting || editIntent.locked || historyPending || scheduleWrite.pending}
              onClick={() => historyAction('redo')}><Redo2 aria-hidden="true" size={16} /></IconButton> : null}
            {dirty ? <IconButton label="Discard changes" variant="ghost" disabled={saveBusy || starting} onClick={() => setConfirm('discard')}><Icon name="close" size={22} /></IconButton> : null}
            {needsSave || edit.pending || editIntent.locked ? <>
            {edit.pending ? <Button disabled={saveBusy || starting} onClick={requestSave}>Retry save</Button> : null}
            {editIntent.locked ? <Button disabled={saveBusy || starting || !!editIntent.storageError || stopBlocked} onClick={requestSave}>
              {affectedRuns.length ? 'Stop affected Runs and save' : 'Reconcile Save'}</Button>
              : <IconButton label="Save changes" disabled={saveBusy || starting || !!editIntent.storageError} onClick={requestSave}><Save aria-hidden="true" size={16} /></IconButton>}
            </> : null}
          </Toolbar> : null}
        {board?.navigationControls}
        <Toolbar label="Workflow controls">
          <RemoveWorkflowButton workspaceId={graph.workspaceId} workflowId={graph.id} name={graph.name}
            revision={managedWorkflow.data?.revision ?? context.draft.publishedRevision}
            renderTrigger={(remove) => <ActionMenu label="Workflow actions" icon="gear" width={220} disabled={saveBusy || starting || editIntent.locked} items={[
              { id: 'rename', label: 'Rename', onSelect: () => workflowName.current?.begin() },
              { id: 'remove', label: 'Remove workflow', icon: 'trash', danger: true, disabled: !managedWorkflow.isSuccess || dirty,
                description: dirty ? 'Save or discard draft changes first.' : undefined,
                onSelect: () => void prepare(remove) },
            ]} />} />
          <IconButton label="Add agent or job to graph" onClick={() => openPanel('agents')}><Icon name="plus" size={16} /></IconButton>
          <IconButton label="Workflow settings" onClick={() => openPanel('workflow')}><Icon name="settings" size={16} /></IconButton>
          <Button variant="secondary" className="n-icon-button workflow-approval-inbox" aria-label={`Open human approval inbox${pendingApprovals ? `, ${pendingApprovals} pending` : ''}`}
            title="Approval inbox" onClick={() => useApprovalInboxStore.getState().openInbox({ workspaceId: graph.workspaceId, workflowId: graph.id })}><Inbox aria-hidden="true" size={16} />
            {pendingApprovals ? <span className="workflow-approval-inbox-badge" aria-hidden="true">{pendingApprovals}</span> : null}</Button>
          {!graph.handoffs ? <Button size="sm" variant="ghost" onClick={() => openPanel('repeat')}>Repeats</Button> : null}
          {board ? <IconButton label="Activities" onClick={board.openRuns}><Icon name="history" size={16} /></IconButton> : null}
          <Button variant="primary" leading={<Icon name="play" size={14} />} aria-label={pendingStart ? 'Reconcile Start' : needsSave ? 'Save and run' : 'Start saved version'}
            title={startReason} disabled={startDisabled} loading={starting} onClick={() => void (pendingStart ? start() : prepare(() => needsSave ? startMutation.mutateAsync({ saveFirst: true }) : start())).catch(report)}>{pendingStart ? 'Confirm start' : needsSave ? 'Save and run' : 'Run'}</Button>
        </Toolbar>
        </div>
      </header>
      <BoardUndoNotice scope={undoScope} />
      <BoardAlerts scope={draftKey} hints={hints} validation={edit.validation} error={editIntent.mutation.error ?? undefined} updateFailures={updateFailures}
        pending={editIntent.mutation.isPending} openField={openSaveField} openIssue={(issue) => {
          if (issue.nodeId) openAgent(issue.nodeId)
          else if (issue.relationshipId) inspect(() => presentation.getState().setFocusedEdgeId(issue.relationshipId))
          else openPanel(issue.code === 'ENTRY_REQUIRED' && !graph.nodes.length ? 'agents' : 'workflow')
        }} />
      <div className="board-notices" aria-live="polite">
        {scheduleWrite.unconfirmed && scheduleWrite.command?.history ? <BoardNotice tone="warning"
          title="The schedule change may have gone through."
          action={<Button size="sm" disabled={scheduleWrite.pending || historyPending}
            onClick={() => historyAction(scheduleWrite.command!.history!.direction)}>Retry schedule change</Button>}>
          Confirm this change before editing the schedule or leaving the Board.</BoardNotice> : null}
        {!pendingStart && workspace.data && workspace.data.locationValidation.status !== 'ready'
          ? <BoardNotice tone="warning" title={locationMessage}
            action={<Button size="sm" onClick={board?.openLocation}>{workspace.data.locationValidation.status === 'unconfigured'
              ? 'Choose folder' : 'Review folder'}</Button>} /> : null}
        {pendingStart ? <BoardNotice tone="warning" title="An earlier start may have gone through."
          action={<><Button size="sm" disabled={starting} onClick={() => void start().catch(report)}>Check again</Button>
            <Button size="sm" disabled={starting} onClick={() => void recoverStart().catch(report)}>Recover Start</Button></>}>
          Confirm it before starting another run. Recovery finds the accepted Run or cancels the pending Start.</BoardNotice> : null}
        {startReloadRequired ? <BoardNotice tone="warning" title="Reload the saved draft before starting another Run."
          action={<Button size="sm" disabled={reloading} onClick={() => void reload()}>Reload saved draft</Button>}>
          Review the latest saved settings before starting again.</BoardNotice> : null}
        {message ? <BoardNotice tone="success" title={message} /> : null}
        {editIntent.storageError ? <BoardNotice tone="danger" live title="Changes can’t be kept in this browser.">{editIntent.storageError}</BoardNotice> : null}
        {editIntent.query.error ? <BoardNotice tone="warning" title="Couldn’t check the status of your last save.">Your changes are still here. {editIntent.query.error.message}</BoardNotice> : null}
        {editIntent.mutation.error ? <WorkflowSaveError error={editIntent.mutation.error} pending={editIntent.outboxPending || !!editIntent.intent && !['saved', 'discarded'].includes(editIntent.intent.state)} openField={openSaveField} /> : null}
        {editIntent.locked && !editIntent.sameDisplayedPayload ? <BoardNotice tone="warning" title="You made more edits after saving started.">They stay here and won’t be overwritten.</BoardNotice> : null}
        {editIntent.query.data?.intent && !['saved', 'discarded'].includes(editIntent.query.data.intent.state) ? <EditIntentStatus data={editIntent.query.data} /> : null}
        {errorText ? <BoardNotice noticeKey={errorText} tone="danger" live title={edit.error?.uncertain ? 'We couldn’t confirm whether that worked.' : 'Something went wrong.'}>
          {errorText}{edit.error?.issues?.length ? <ul>{edit.error.issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul> : null}
        </BoardNotice> : null}
      </div>
      <aside className="board-side-panel" hidden={panel !== 'repeat'} style={panel === 'repeat' ? undefined : { display: 'none' }} aria-label="Business repeats">
        <header><h2>Business repeats</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <RepeatEditor graph={graph} change={change} disabled={edit.busy || reloading || editIntent.locked || !!edit.pending || !!pendingStart} />
      </aside>
      {panel === 'agents' ? <AgentPickerPanel close={() => openPanel(null)}>
        {graph.handoffs?<section><h3>Saved jobs</h3><p>This workflow uses work handoffs, which job nodes can’t join. Switch to one-pass dependencies to add a job; the change is saved as a new version with the usual Stop-and-save checks.</p><Button disabled={edit.busy || reloading || editIntent.locked || starting} onClick={()=>change(value=>{const next={...value};delete next.handoffs;return next})}>Use one-pass dependencies</Button></section>:null}
        {!graph.handoffs?<JobNodePicker workspaceId={graph.workspaceId} onChoose={definition=>{change(value=>attachJob(value,definition,`node-${crypto.randomUUID()}`));openPanel(null)}}/>:null}
        <fieldset disabled={edit.busy || reloading || editIntent.locked || starting}>
          <NewBoardAgent draftKey={draftKey} edit={edit} report={report} />
          <AttachAgentField graph={graph} context={context} change={change} report={report} />
        </fieldset>
      </AgentPickerPanel> : null}
      {panel && panel !== 'repeat' && panel !== 'agents' ? <aside ref={settingsPanel} className="board-side-panel" aria-label={panelTitle || 'Board controls'}>
        <header><h2>{panelTitle}</h2><IconButton variant="ghost" label="Close panel" onClick={() => openPanel(null)}><Icon name="close" size={16} /></IconButton></header>
        <fieldset disabled={edit.busy || reloading || editIntent.locked}>
          {panel === 'workflow' ? <>
            {graph.handoffs ? <p className="next-draft-hint">Set each work connection’s Run-wide handoff limit on its line. The Board keeps these edits as a draft until Save.</p> : null}
            <EntryFields graph={graph} context={context} agentEdits={edit.agentEdits} change={change} />
            <ApprovalFields graph={graph} context={context} agentEdits={edit.agentEdits} change={change} report={report} />
            <section className="next-draft-section" aria-label="Execution bounds"><h3>Limits</h3>
              {graph.executionPolicy ? <AgentActiveTimeField policy={graph.executionPolicy}
                defaultMs={preflight.data?.capabilities.agentActiveTimeBudget.defaultMs}
                onChange={(executionPolicy) => change((item) => ({ ...item, executionPolicy }))} /> : null}
              {graph.executionPolicy ? <div className="next-draft-inline">
                <TextField data-save-field="limits" label="Maximum parallelism" hint="Agents running at once" type="number" min={1} max={100} value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } })) }} />
                <TextField data-save-field="executions" label="Maximum node executions" hint="Agent turns per run" type="number" min={1} max={10000} value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''} onChange={(event) => { const value = event.target.valueAsNumber; change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } })) }} />
              </div> : <Button data-save-field="limits" size="sm" onClick={() => change((item) => ({ ...item, executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set limits</Button>}
              {graph.requiredAgentCount !== undefined ? <div className="next-draft-inline">
                <TextField label="Required Agent count" type="number" min={0} max={10000} value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''} onChange={(event) => { const requiredAgentCount = event.target.valueAsNumber; change((item) => ({ ...item, requiredAgentCount })) }} />
                <Button size="sm" variant="ghost" onClick={() => change((item) => { const next = { ...item }; delete next.requiredAgentCount; return next })}>Remove fixed Agent count</Button>
              </div> : null}
            </section>
            <section className="next-draft-section"><h3>Execution folder</h3>
              <p className="next-draft-hint">{workspace.data?.locationValidation.status === 'ready' ? 'Runs work in this workspace’s folder.' : locationMessage}</p>
              <Button size="sm" onClick={board?.openLocation}>Change folder</Button>
            </section>
            <section className="next-draft-section"><h3>Draft</h3>
              <p className="next-draft-hint">{context.draft.baseWorkflowVersionId ? <>Based on saved version <code>{context.draft.baseWorkflowVersionId}</code>.</> : 'This workflow hasn’t been saved yet.'}</p>
              <Button size="sm" disabled={!!edit.pending} onClick={() => {
                if (nextDraftDirty(edit)) setConfirm('reload'); else void reload()
              }}>Reload saved draft</Button>
            </section>
          </> : null}
        </fieldset>
      </aside> : null}
      <nav className="board-keyboard-list" aria-label="Agents and connections">
        {graph.nodes.map((node) => <Button size="sm" variant="ghost" key={node.id} onClick={() => openAgent(node.id)}>
          {graph.entryNodeId === node.id ? 'Entry · ' : ''}{nodeTitle(graph, node.id)}</Button>)}
        {graph.edges.map((edge) => <Button size="sm" variant="ghost" key={edge.id}
          disabled={edit.busy || reloading || editIntent.locked}
          onClick={() => change((value) => removeRelationship(value, edge.id))}>
          Remove {kindName(edge.kind)} · {nodeTitle(graph, edge.source)} → {nodeTitle(graph, edge.target)}</Button>)}
      </nav>
    </div>
    <ConfirmDialog open={confirm === 'save' && affectedRuns.length > 0 && !stopBlocked} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Stop running work and save?"
      description={`${affectedRuns.length} affected ${affectedRuns.length === 1 ? 'Run requires' : 'Runs require'} Stop or cleanup across ${affectedWorkflows} ${affectedWorkflows === 1 ? 'workflow' : 'workflows'}.${affectedRuns.some((item) => item.pin.workflowId !== graph.id) ? ' This includes shared-Agent work in another workflow.' : ''} Stop-and-save stops every affected Run and waits for full cleanup before saving. Stopped runs are not restarted.`}
      confirmLabel="Stop runs and save" onConfirm={() => { setConfirm(undefined); void prepare(() => runAfterSave.current ? startMutation.mutateAsync({ saveFirst: true, allowStop: true }) : stopAndSave(true)).catch(report) }} />
    <ConfirmDialog open={confirm === 'discard'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Discard your changes?"
      description="Your unsaved edits are removed. Agent positions on the board are kept. Running work isn’t affected."
      confirmLabel="Discard changes" onConfirm={() => { setConfirm(undefined); void prepare(discardChanges).catch(report) }} />
    <ConfirmDialog open={confirm === 'reload'} onOpenChange={(open) => { if (!open) setConfirm(undefined) }} title="Reload the saved draft?"
      description="Your unsaved edits are replaced by the latest saved draft."
      confirmLabel="Reload saved draft" onConfirm={() => { setConfirm(undefined); void reload(true) }} />
  </section>
}
