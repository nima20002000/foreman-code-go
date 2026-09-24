import { useQuery } from '@tanstack/react-query'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { graphRecordKey } from '../run-graph/cache'
import { presentRunGraphNode } from '../run-graph/presentation'
import type { RunGraphRecord } from '../run-graph/types'
import { useWorkflowBoard } from './context'

/** Cache-only observer. RunActivityPanel owns synchronization; the draft owns no Run facts. */
export function DraftRunBadge({ nodeId, agentId }: { nodeId: string; agentId: string }) {
  const board = useWorkflowBoard(), scope = board?.run
  const record = useQuery<RunGraphRecord>({ queryKey: scope ? graphRecordKey(scope, sessionGeneration()) : ['workbench', 'no-board-run'],
    enabled: false, queryFn: () => { throw new Error('Board badges must never fetch Run facts.') } }).data
  if (!scope) return null
  if (!record?.facts || record.transport.phase === 'denied') return <small className="board-run-badge">Selected Run facts unavailable</small>
  if (record.facts.reader === 'legacy') return <small className="board-run-badge">Legacy Run facts are in Run activity</small>
  const snapshot = record.facts.snapshot
  const node = snapshot.topology.nodes.find((item) => item.workflowNodeId === nodeId && item.agentId === agentId)
  if (!node) return <small className="board-run-badge">Not part of selected Run</small>
  const fact = snapshot.state.nodes.find((item) => item.state.workflowNodeId === nodeId)
  const view = presentRunGraphNode(fact, { stale: record.transport.phase !== 'live', stopped: snapshot.state.run.stopRequested === true })
  return <small className="board-run-badge" title={`Run ${scope.runId}; pinned configuration ${node.agentConfigurationVersionId}. Not next-draft activity.`}>
    Selected Run · {view.lifecycle} · {view.activity}
  </small>
}
