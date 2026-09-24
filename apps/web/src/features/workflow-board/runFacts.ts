import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@graphql/contracts'
import type { AgentNodeState, Tone } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from '../run-graph/cache'
import { presentRunGraphNode } from '../run-graph/presentation'
import type { RunGraphRecord } from '../run-graph/types'
import type { EdgeSignal } from '../graph/signalEdge'
import { useWorkflowBoard } from './context'

/** Cache-only observer of the selected Run. The board's Run sync owns fetching; the draft owns no Run facts. */
export function useSelectedRunRecord(): RunGraphRecord | undefined {
  const scope = useWorkflowBoard()?.run
  return useQuery<RunGraphRecord>({ queryKey: scope ? graphRecordKey(scope, sessionGeneration()) : ['workbench', 'no-board-run'],
    enabled: false, queryFn: () => { throw new Error('Board nodes must never fetch Run facts.') } }).data
}

export type RunNodeView = { state: AgentNodeState; label: string; activity?: string; inRun: boolean }
type Lifecycle = NonNullable<ReturnType<typeof lifecycleOf>>
const words: Record<Lifecycle, [AgentNodeState, string]> = {
  not_activated: ['idle', 'Not started'], queued: ['queued', 'Queued'], starting: ['queued', 'Starting'], running: ['running', 'Running'],
  waiting: ['waiting', 'Waiting'], succeeded: ['completed', 'Completed'], failed: ['failed', 'Failed'], canceled: ['idle', 'Cancelled'],
  skipped: ['idle', 'Skipped'], interrupted: ['unavailable', 'Interrupted'], uncertain: ['unavailable', 'Unconfirmed'], unknown: ['unavailable', 'Unavailable'],
}
/** The canvas state and fixed status word for one recorded lifecycle. */
export const lifecycleView = (lifecycle: string | undefined): [AgentNodeState, string] =>
  (lifecycle && Object.hasOwn(words, lifecycle) ? words[lifecycle as Lifecycle] : undefined) ?? words.unknown
function lifecycleOf(record: RunGraphRecord | undefined, nodeId: string) {
  if (record?.facts?.reader !== 'graph') return undefined
  return record.facts.snapshot.state.nodes.find((item) => item.state.workflowNodeId === nodeId)?.state.lifecycle
}

/** A draft node's state in the selected Run, or Idle when no Run is selected. Unknown facts are never shown as success. */
export function runNodeView(record: RunGraphRecord | undefined, selected: boolean, nodeId: string, agentId: string): RunNodeView {
  if (!selected) return { state: 'idle', label: 'Idle', inRun: false }
  if (!record?.facts || record.transport.phase === 'denied') return { state: 'unavailable', label: 'Unavailable', inRun: false }
  if (record.facts.reader === 'legacy') return { state: 'unavailable', label: 'Unavailable', inRun: false }
  const snapshot = record.facts.snapshot
  if (!snapshot.topology.nodes.some((item) => item.workflowNodeId === nodeId && item.agentId === agentId)) return { state: 'idle', label: 'Not in this Run', inRun: false }
  const fact = snapshot.state.nodes.find((item) => item.state.workflowNodeId === nodeId)
  const [state, label] = words[fact?.state.lifecycle ?? 'unknown'] ?? words.unknown
  const view = presentRunGraphNode(fact, { stale: record.transport.phase !== 'live', stopped: snapshot.state.run.stopRequested === true })
  const activity = view.activity.includes('unavailable') || view.activity === 'No current activity' ? undefined : view.activity
  return { state, label: activity === 'Waiting for approval' ? activity : label, activity, inRun: true }
}

/** Light on a connection mirrors its receiver's recorded state: handed over while it works, red when it failed.
 * Only a relationship pinned in the selected Run can carry light; a draft-only connection never does. */
export function runEdgeSignal(record: RunGraphRecord | undefined, relationshipId: string, source: string, target: string): EdgeSignal | undefined {
  if (record?.facts?.reader !== 'graph' || !record.facts.snapshot.topology.relationships.some((item) =>
    item.relationshipId === relationshipId && item.source === source && item.target === target && item.kind === 'execution')) return undefined
  const from = lifecycleOf(record, source), to = lifecycleOf(record, target)
  if (!from || !to) return undefined
  if (to === 'failed') return 'error'
  if (['queued', 'starting', 'running', 'waiting'].includes(to) && from === 'succeeded') return 'task'
  return undefined
}

const ACTIVE = ['queued', 'running', 'waiting', 'interrupted']
export const isActiveRun = (run: Pick<WorkflowRunSummary, 'executionState' | 'cleanupPending'>) => ACTIVE.includes(run.executionState) || Boolean(run.cleanupPending)
export function runLabel(state: string, outcome: string) {
  if (state === 'running') return 'Running'
  if (state === 'waiting') return 'Waiting'
  if (state === 'queued') return 'Queued'
  if (state === 'interrupted') return 'Interrupted'
  return outcome === 'succeeded' ? 'Completed' : outcome === 'failed' ? 'Failed' : outcome === 'canceled' ? 'Cancelled' : 'Finished'
}
export function runTone(state: string, outcome: string): Tone {
  if (state === 'running' || state === 'queued') return 'info'
  if (state === 'waiting' || state === 'interrupted') return 'warning'
  return outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'danger' : 'neutral'
}
export const when = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not started'
