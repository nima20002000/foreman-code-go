import { ActivitySnapshotV1Schema, projectActivityStatus, type ActivitySnapshotV1, type ActivityScope, type WorkRef, type WorkSummary } from '@graphql/contracts'
import type { PostgresAgentChatRepository } from './agentChatRepository.js'

type State = NonNullable<Awaited<ReturnType<PostgresAgentChatRepository['state']>>>
/** Adapt existing receipt ownership; neither latest message nor provider session confers ownership. */
export function agentActivitySnapshot(loaded: State): ActivitySnapshotV1 {
  const { row, turns } = loaded
  const ref = (requestId: string): WorkRef => ({ kind: 'chat_request', conversationId: row.id, requestId })
  const owner = row.active_request_id ? ref(row.active_request_id) : null
  const native = row.native_session_id ? { harness: row.harness, sessionId: row.native_session_id,
    ...(row.active_native_turn_id ? { turnId: row.active_native_turn_id } : {}) } : undefined
  const scope: ActivityScope = row.origin_run_id && row.origin_execution_id && loaded.selection
    ? { kind: 'selected_run_chat', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
      nodeId: row.workflow_node_id, agentId: row.agent_id, selection: { workspaceId: row.workspace_id, workflowId: row.workflow_id,
        runId: row.origin_run_id, workflowVersionId: loaded.selection.workflowVersionId, executionId: row.origin_execution_id, attemptKey: loaded.selection.attemptKey } }
    : { kind: 'agent_chat', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id, nodeId: row.workflow_node_id, agentId: row.agent_id }
  if (row.origin_run_id && !loaded.selection) throw new Error('Selected Run chat lost its exact persisted origin.')
  const work: WorkSummary[] = owner ? [{ ref: owner,
    phase: row.cancel_requested ? 'interrupting' : row.pending_interaction ? 'waiting' : row.turn_state === 'starting' ? 'preparing' : 'active',
    outcome: null, delivery: turns.find((turn) => turn.requestId === row.active_request_id)?.delivery ?? 'unknown',
    evidence: row.turn_state === 'uncertain' ? 'reconciling' : 'confirmed', startedAt: loaded.activeStartedAt?.toISOString() ?? null,
    ...(native ? { native } : {}) }] : []
  for (const activity of loaded.activityPage.activities) {
    if (activity.kind === 'thinking' || !['pending', 'running', 'unknown'].includes(activity.status)) continue
    work.push({ ref: { kind: activity.kind === 'subagent' ? 'subagent' : 'tool', itemId: activity.id },
      phase: 'active', outcome: null, delivery: null, evidence: activity.status === 'unknown' ? 'unknown' : 'confirmed', startedAt: null })
  }
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope, revision: String(row.revision),
    ...projectActivityStatus({ work, queued: turns.filter((turn) => turn.delivery === 'queued').map((turn) => ref(turn.requestId)),
      latest: loaded.latestRequestId ? ref(loaded.latestRequestId) : null }),
    // Native callback availability is qualified separately by C; a pending callback is not a durable interaction receipt.
    pendingInteractions: [],
    activities: loaded.activityPage.activities.map((activity) => ({
      id: activity.id, revision: loaded.activityPage.itemRevisions[activity.id] ?? String(activity.revision), order: activity.sequence, owner: ref(activity.requestId),
      source: { schemaVersion: 1, system: 'conversation_record', observedAt: null },
      evidence: activity.status === 'unknown' ? 'unknown' : 'confirmed',
      ...(activity.kind === 'thinking' ? { kind: 'reasoning_summary', summary: activity.title }
        : { kind: activity.kind === 'subagent' ? 'subagent' : 'tool', title: activity.title, status: activity.status }),
    })),
    page: { before: null, nextCursor: loaded.activityPage.nextCursor, hasMore: loaded.activityPage.nextCursor !== null },
  })
}
