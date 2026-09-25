import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@graphql/contracts'
import type { RepeatGraphCurrentV3 } from '@graphql/contracts/wave25'
import type { AgentNodeState, Tone } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import type { EdgeSignal } from '../graph/signalEdge'
import { currentRunKey } from './currentRunQuery'
import { useWorkflowBoard } from './context'

/** Cache-only subscriber: one selected-Run observer owns fetching. */
export function useSelectedRunRecord(): RepeatGraphCurrentV3 | undefined {
  const scope = useWorkflowBoard()?.run
  const query = useQuery<RepeatGraphCurrentV3>({ queryKey: scope ? currentRunKey(scope) : ['workbench', 'no-board-run', sessionGeneration()],
    enabled: false, queryFn: () => { throw new Error('The current Run observer owns fetching.') } })
  return query.isError ? undefined : query.data
}
export type RunNodeView = { state: AgentNodeState; label: string; activity?: string; inRun: boolean }
const words: Record<string, [AgentNodeState, string]> = {
  not_activated: ['idle', 'Not started'], queued: ['queued', 'Queued'], starting: ['queued', 'Starting'], running: ['running', 'Running'],
  waiting: ['waiting', 'Waiting'], succeeded: ['completed', 'Completed'], failed: ['failed', 'Failed'], canceled: ['idle', 'Cancelled'],
  skipped: ['idle', 'Skipped'], excluded: ['idle', 'Not selected'], interrupted: ['unavailable', 'Interrupted'],
  uncertain: ['unavailable', 'Unconfirmed'], unknown: ['unavailable', 'Unavailable'],
}
export const lifecycleView = (lifecycle?: string): [AgentNodeState, string] => words[lifecycle ?? 'unknown'] ?? words.unknown!
function latestNode(record: RepeatGraphCurrentV3, nodeId: string) {
  // Occurrence index, then technical attempt. Timestamps and timers are never authority.
  return record.state.executions.filter((item) => item.identity.workflowNodeId === nodeId).sort((a, b) =>
    (b.identity.occurrence?.occurrenceIndex ?? 0) - (a.identity.occurrence?.occurrenceIndex ?? 0)
    || b.identity.attempt - a.identity.attempt)[0]
}
function lifecycleOf(record: RepeatGraphCurrentV3, nodeId: string): string {
  const execution = latestNode(record, nodeId)
  if (execution) return execution.state === 'completed' ? execution.resultOutcome ?? 'unknown' : execution.state
  const resolved = record.state.resolutions.filter((item) => item.ref.nodeId === nodeId).sort((a, b) =>
    (b.ref.occurrence?.occurrenceIndex ?? 0) - (a.ref.occurrence?.occurrenceIndex ?? 0))[0]
  return resolved?.value.resolution ?? 'not_activated'
}
export function runNodeView(record: RepeatGraphCurrentV3 | undefined, selected: boolean, nodeId: string, agentId: string): RunNodeView {
  if (!selected) return { state: 'idle', label: 'Idle', inRun: false }
  if (!record) return { state: 'unavailable', label: 'Unavailable', inRun: false }
  if (!record.topology.nodes.some((node) => node.workflowNodeId === nodeId && node.agentId === agentId)) return { state: 'idle', label: 'Not in this Run', inRun: false }
  const [state, label] = lifecycleView(lifecycleOf(record, nodeId))
  const execution = latestNode(record, nodeId)
  const occurrence = execution?.identity.occurrence
  return { state, label, inRun: true, ...(occurrence ? { activity: `Business occurrence ${occurrence.occurrenceIndex} · technical attempt ${execution.identity.attempt}` } : {}) }
}
export function runEdgeSignal(record: RepeatGraphCurrentV3 | undefined, relationshipId: string, source: string, target: string): EdgeSignal | undefined {
  if (!record?.topology.relationships.some((edge) => edge.relationshipId === relationshipId && edge.kind === 'execution'
    && edge.source === source && edge.target === target)) return undefined
  const from = latestNode(record, source), to = latestNode(record, target)
  if (!from || !to) return undefined
  // A prior round's success cannot light a later round's edge. A durable binding is required.
  const bound = record.state.bindings.some((binding) => binding.relationshipId === relationshipId
    && binding.sender.executionId === from.identity.executionId && binding.recipient.executionId === to.identity.executionId)
  if (!bound) return undefined
  if (to.resultOutcome === 'failed') return 'error'
  if (['queued', 'starting', 'running', 'waiting'].includes(to.state) && from.resultOutcome === 'succeeded') return 'task'
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
