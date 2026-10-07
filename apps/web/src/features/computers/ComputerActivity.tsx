import { Monitor } from 'lucide-react'
import type { ComputerActivity, ComputerActivityList } from '@foreman-code/contracts/computer-activity'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, IconButton, LoadingState } from '../../shared/ui/nocturne'
import { formatDuration } from '../resource-telemetry/telemetryView'
import { ComputerUtilization } from './ComputerUtilization'
import { computerState } from './computerState'
import { useComputerUi } from './computerUiStore'
import './computers.css'

export function ComputerActivityIcons() {
  const query = useComputerActivity()
  const open = useComputerUi(state => state.openActivity)
  const active = query.isError ? [] : query.data?.computers.filter(value => value.jobs.length || value.agents.length) ?? []
  return <>
    {active.length > 0 && <div className="computer-activity-icons" aria-label="Active computers">
      {active.map(computer => <IconButton key={computerKey(computer.target)} variant="ghost"
        label={`Activity on ${computer.name}`} onClick={() => open(computerKey(computer.target))}>
        <Monitor size={18} aria-hidden="true" /><span className="computer-activity-dot" aria-hidden="true" />
      </IconButton>)}
    </div>}
    <ComputerActivityModal />
  </>
}
export function ComputerActivityModal() {
  const selected = useComputerUi(state => state.activity)
  const close = useComputerUi(state => state.closeActivity)
  const query = useComputerActivity()
  const computer = query.data?.computers.find(value => computerKey(value.target) === selected?.key)
  const open = selected?.session === sessionGeneration()
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }} title={computer?.name ?? 'Computer activity'}
    headerLeading={<Monitor size={20} aria-hidden="true" />} size="md">
    {open && <>
      {query.isPending && <LoadingState label="Loading computer activity…" />}
      {query.isError && <><Alert tone="danger" title="Activity could not be read." />
        <Button onClick={() => void query.refetch()}>Retry activity</Button></>}
      {query.isSuccess && (computer ? <ActivityContents computer={computer} list={query.data} />
        : <Alert tone="neutral" title="This computer is no longer paired." />)}
    </>}
  </Dialog>
}
function ActivityContents({ computer, list }: { computer: ComputerActivity; list: ComputerActivityList }) {
  const now = Date.now()
  return <div className="computer-activity-content">
    <div className="computer-activity-summary"><strong>{computerState(computer, list.activityComplete)}</strong>
      <ComputerUtilization target={computer.target} online={computer.online} /></div>
    {!list.activityComplete && <p className="computer-activity-note">Showing activity you can read{list.truncated ? ' (list limit reached)' : ''}.</p>}
    <section aria-label="Running Jobs"><h3>Jobs <span>{computer.jobs.length}</span></h3>
      {computer.jobs.length ? <ul>{computer.jobs.map(job => <li key={job.id}>
        <div><strong>{job.name}</strong><small>{job.workspaceName}</small></div>
        <span>{job.phase}</span><time>{job.startedAt ? formatDuration(now - Date.parse(job.startedAt)) : 'Preparing'}</time>
      </li>)}</ul> : <p className="computer-activity-note">No running Jobs</p>}
    </section>
    <section aria-label="Agent executions"><h3>Agents <span>{computer.agents.length}</span></h3>
      {computer.agents.length ? <ul>{computer.agents.map(agent => <li key={agent.id}>
        <div><strong>{agent.agentName}</strong><small>{agent.workflowName} · {agent.nodeId}</small></div>
        <span>{agent.state}</span>
      </li>)}</ul> : <p className="computer-activity-note">No running agents</p>}
    </section>
  </div>
}
