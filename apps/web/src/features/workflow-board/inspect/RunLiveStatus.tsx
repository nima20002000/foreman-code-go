import type { AgentNodeState } from '../../../shared/ui/nocturne'
import { Badge, Button } from '../../../shared/ui/nocturne'
import { ciComputerLabel, ciJobLabel, type InteractionWait, type RunCiJob } from './runLiveStatus'

export type RunLiveNode = { id: string; name: string; state: AgentNodeState; label: string }

/** The top of a live Run Board: whose turn it is, what the others wait on, and the Run's unfinished CI. */
export function RunLiveStatus({ live, nodes, waits, ci, onOpenDecision }: {
  live: boolean
  nodes: readonly RunLiveNode[]
  waits: ReadonlyMap<string, InteractionWait>
  ci: readonly RunCiJob[]
  onOpenDecision(): void
}) {
  if (!live && ci.length === 0) return null
  const names = new Map(nodes.map((node) => [node.id, node.name]))
  const working = nodes.filter((node) => node.state === 'running')
  const waiting = nodes.filter((node) => node.state === 'waiting' || node.state === 'queued')
  return <section className="run-live-status" aria-label="Run status">
    {live ? <p className="run-live-now" role="status" data-working={working.length > 0 || undefined}>
      <i aria-hidden="true" />
      {working.length ? <><strong>Working now:</strong> {working.map((node) => node.name).join(', ')}</>
        : <strong>No Agent is working right now</strong>}
    </p> : null}
    {live && waiting.length ? <ul className="run-live-waits" aria-label="Waiting Agents">
      {waiting.map((node) => {
        const wait = waits.get(node.id)
        return <li key={node.id} data-state={node.state}>
          <Badge tone="warning" dot>{node.label}</Badge> <span>{node.name}</span>
          {wait?.actionable ? <Button size="sm" variant="secondary" onClick={onOpenDecision}
            aria-label={`Open ${wait.label === 'Waiting for your decision' ? 'decision' : 'approval'} for ${node.name}`}>
            {wait.label === 'Waiting for your decision' ? 'Open decision' : 'Open approval'}</Button> : null}
        </li>
      })}
    </ul> : null}
    {ci.length ? <ul className="run-live-ci" aria-label="CI jobs">
      {ci.map(({ ci: job, nodeId }) => <li key={job.id} data-state={job.state}>
        <Badge tone={job.state === 'running' ? 'info' : 'neutral'} dot>CI {job.state}</Badge>
        <span className="run-live-ci-name">{ciJobLabel(job)}</span>
        <span>requested by {names.get(nodeId) ?? 'an Agent'}</span>
        <span>{ciComputerLabel(job)}</span>
        {job.step ? <span>step {job.step}</span> : null}
      </li>)}
    </ul> : null}
  </section>
}
