import { useRef, useState } from 'react'
import { createStore, useStore } from 'zustand'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { Button, Drawer, Icon, type IconName } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { JobResult } from '../jobs/JobResult'
import { jobError } from '../jobs/model'
import { useWorkflowJobHistory } from '../jobs/query'
import { formatDuration } from '../resource-telemetry/telemetryView'
import './workflowJobs.css'

function createJobsPanelStore() {
  return createStore<{
    open: boolean
    selectedId: string | null
    setOpen(open: boolean): void
    select(id: string | null): void
  }>(set => ({
    open: false, selectedId: null,
    setOpen: open => set({ open, selectedId: null }),
    select: selectedId => set({ selectedId }),
  }))
}

export function WorkflowJobsButton(props: { workspaceId: string; workflowId: string }) {
  return <JobsPanel key={JSON.stringify([sessionGeneration(), props.workspaceId, props.workflowId])} {...props} />
}

function JobsPanel({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const [store] = useState(createJobsPanelStore)
  const open = useStore(store, state => state.open)
  const selectedId = useStore(store, state => state.selectedId)
  const trigger = useRef<HTMLButtonElement>(null)
  const history = useWorkflowJobHistory(workspaceId, workflowId, open)
  const selected = history.items.find(item => item.execution.id === selectedId)
  return <>
    <Button ref={trigger} size="sm" variant="ghost" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => store.getState().setOpen(true)}>Jobs</Button>
    <Drawer open={open} onOpenChange={store.getState().setOpen} title="Jobs" size="lg"
      className="workflow-board-runs-dialog" closeLabel="Close jobs" returnFocusRef={trigger}>
      {open && <div className="workflow-board-run-panel">
        {history.isError ? <p role="alert">{jobError(history.error)}
          <Button size="sm" variant="ghost" onClick={() => void history.refetch()}>Retry</Button>
        </p> : <>
          {selected ? <>
            <Button size="sm" variant="ghost" onClick={() => store.getState().select(null)}>Back to jobs</Button>
            <JobResult key={selected.execution.id} workspaceId={workspaceId} executionId={selected.execution.id}
              expectedDefinitionVersionId={selected.execution.acceptedSpec.definitionVersionId}
              {...(selected.execution.initiatingAgent ? { expectedInitiatingAgent: selected.execution.initiatingAgent } : {})} />
          </> : <>
            {history.isPending ? <p role="status">Loading jobs…</p> : null}
            {!history.isPending && !history.items.length ? <p>No jobs yet.</p> : null}
            <ul className="board-job-list" aria-label="Workflow jobs">
              {history.items.map(item => <li key={item.execution.id}>
                <JobRow name={item.name} execution={item.execution}
                  onClick={() => store.getState().select(item.execution.id)} />
              </li>)}
            </ul>
            {history.hasNextPage ? <Button size="sm" variant="ghost" disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}>Older jobs</Button> : null}
          </>}
        </>}
      </div>}
    </Drawer>
  </>
}

function jobStatus(execution: JobExecutionRecord): { label: string; icon: IconName; tone: string } {
  const { outcome, phase } = execution.process
  if (outcome === 'succeeded') return { label: 'Succeeded', icon: 'check', tone: 'success' }
  if (outcome === 'cancelled') return { label: 'Canceled', icon: 'stop', tone: 'neutral' }
  if (outcome) return { label: 'Failed', icon: 'close', tone: 'danger' }
  if (phase === 'running') return { label: 'Running', icon: 'play', tone: 'neutral' }
  if (phase === 'preparing') return { label: 'Preparing', icon: 'clock', tone: 'neutral' }
  return { label: 'Queued', icon: 'clock', tone: 'neutral' }
}

function relativeTime(value: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), 'minute')
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), 'hour')
  return formatter.format(-Math.floor(seconds / 86400), 'day')
}

function JobRow({ name, execution, onClick }: { name: string; execution: JobExecutionRecord; onClick(): void }) {
  const status = jobStatus(execution)
  const duration = execution.startedAt
    ? formatDuration(Math.max(0, Date.parse(execution.finishedAt ?? execution.updatedAt) - Date.parse(execution.startedAt)))
    : '—'
  const label = execution.initiatingAgent && !name.startsWith('CI: ') ? `CI: ${name}` : name
  return <Button className="board-job-row" size="sm" variant="ghost" onClick={onClick}>
    <span className="board-job-name" title={label}>{label}</span>
    <span className={`board-job-status board-job-status-${status.tone}`} aria-label={status.label} title={status.label}>
      <Icon name={status.icon} size={15} />
    </span>
    <span title={execution.finishedAt ? 'Duration' : 'Duration through last result update'}>{duration}</span>
    <span className="board-job-computer" title={execution.acceptedSpec.target.labelAtAcceptance}>
      {execution.acceptedSpec.target.labelAtAcceptance}
    </span>
    <time dateTime={execution.createdAt} title={new Date(execution.createdAt).toLocaleString()}>
      {relativeTime(execution.createdAt)}
    </time>
  </Button>
}
