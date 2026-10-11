import { Monitor } from 'lucide-react'
import type { ComputerActivity, ComputerActivityList } from '@foreman-code/contracts/computer-activity'
import { computerKey, useComputerActivity } from '../../shared/api/computerActivity'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { Alert, Button, Dialog, LoadingState } from '../../shared/ui/nocturne'
import { formatDuration } from '../resource-telemetry/telemetryView'
import { ComputerUtilization } from './ComputerUtilization'
import { computerState } from './computerState'
import { useComputerUi } from './computerUiStore'
import { useComputerActivityFreshness } from './useComputerActivityFreshness'
import './computers.css'

/** Every paired computer with live CPU, memory and disk; selecting one opens its activity. */
export function SidebarComputers() {
  const query = useComputerActivity()
  const open = useComputerUi(state => state.openActivity)
  const fresh = useComputerActivityFreshness(query.dataUpdatedAt, query.fetchStatus)
  const computers = query.isError ? [] : query.data?.computers ?? []
  return <>
    {computers.length > 0 && <ul className="sidebar-computers" aria-label="Computers">
      {computers.map(computer => {
        // Without a fresh observation, presence and activity are last-known facts, not current state.
        const online = fresh && computer.online
        const busy = fresh && (computer.jobs.length > 0 || computer.agents.length > 0)
        return <li key={computerKey(computer.target)} data-online={online}>
          <button type="button" className="sidebar-computer" aria-label={`Activity on ${computer.name}`}
            title={`${computer.name}: ${fresh ? computerState(computer, query.data?.activityComplete ?? false) : 'Status stale'}`}
            onClick={() => open(computerKey(computer.target))}>
            <span className="sidebar-computer-icon"><Monitor size={16} aria-hidden="true" />
              {busy && <span className="computer-activity-dot" data-testid="computer-busy" aria-hidden="true" />}</span>
            <span className="sidebar-computer-name">{computer.name}</span>
            <span className="computer-presence-dot" data-online={online} aria-hidden="true" />
          </button>
          <ComputerUtilization target={computer.target} online={online} compact />
        </li>
      })}
    </ul>}
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
