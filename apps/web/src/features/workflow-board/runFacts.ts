import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@foreman-code/contracts'
import type { RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import type { AgentNodeState, Tone } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { currentRunKey } from './currentRunQuery'
import { useWorkflowBoard } from './context'

/** Cache-only subscriber: no Query observer with a competing queryFn. Only
 * CurrentRunObserver owns current-state fetching and invalidation/refetch work. */
export function useSelectedRunRecord(): RepeatGraphCurrentV3 | undefined {
  const scope = useWorkflowBoard()?.run, cache = useQueryClient(), generation = sessionGeneration()
  const { workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion } = scope ?? {}
  const key = useMemo(() => workspaceId && workflowId && runId && workflowVersionId && executionSemanticsVersion === 3
    ? currentRunKey({ workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion }, generation) : undefined,
    [workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion, generation])
  const subscribe = useCallback((notify: () => void) => cache.getQueryCache().subscribe(notify), [cache])
  const snapshot = useCallback(() => key ? cache.getQueryState<RepeatGraphCurrentV3>(key) : undefined, [cache, key])
  const state = useSyncExternalStore(subscribe, snapshot, () => undefined)
  return state?.status === 'error' || state?.fetchStatus === 'paused' ? undefined : state?.data
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
  if (!record.topology.nodes.some((node) => node.workflowNodeId === nodeId && node.kind!=='job' && node.agentId === agentId)) return { state: 'idle', label: 'Not in this Run', inRun: false }
  const [state, label] = lifecycleView(lifecycleOf(record, nodeId))
  const execution = latestNode(record, nodeId)
  const occurrence = execution?.identity.occurrence
  return { state, label, inRun: true, ...(occurrence ? { activity: `Business occurrence ${occurrence.occurrenceIndex} · technical attempt ${execution.identity.attempt}` } : {}) }
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
