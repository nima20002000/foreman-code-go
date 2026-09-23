import type { GraphActivity, GraphExecutionIdentity, RunGraphCurrentState } from '@graphql/contracts/wave25'

type NodeFact = RunGraphCurrentState['nodes'][number]
const lifecycleLabels: Record<NodeFact['state']['lifecycle'], string> = {
  not_activated: 'Not activated', queued: 'Queued', starting: 'Starting', running: 'Running', waiting: 'Waiting',
  succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled', skipped: 'Skipped',
  interrupted: 'Interrupted', uncertain: 'Uncertain', unknown: 'Lifecycle unavailable',
}
const actionLabels: Record<NonNullable<GraphActivity['action']>, string> = {
  working: 'Working', reading_file: 'Reading file', writing_file: 'Writing file', creating_folder: 'Creating folder',
  using_tool: 'Using tool', using_app_mcp: 'Using App MCP', spawning_subagent: 'Spawning subagent',
  reviewing: 'Reviewing', waiting_approval: 'Waiting for approval',
}

export function sameExecutionIdentity(left: GraphExecutionIdentity | undefined, right: GraphExecutionIdentity | undefined): boolean {
  return Boolean(left && right && left.executionId && left.workflowNodeId && left.agentId && left.agentConfigurationVersionId
    && Number.isSafeInteger(left.attempt) && left.attempt > 0
    && left.workflowNodeId === right.workflowNodeId && left.executionId === right.executionId
    && left.agentId === right.agentId && left.agentConfigurationVersionId === right.agentConfigurationVersionId && left.attempt === right.attempt)
}

/** These are presentation fences, never lifecycle transitions or a writable runtime mirror. */
export function presentRunGraphNode(node: NodeFact | undefined, options: { stale?: boolean; stopped?: boolean } = {}): {
  lifecycle: string; activity: string; tone: 'neutral' | 'accent' | 'warning'
} {
  const state = node?.state
  const activity = node?.activity
  const lifecycle = state && Object.hasOwn(lifecycleLabels, state.lifecycle) ? lifecycleLabels[state.lifecycle] : 'Lifecycle unavailable'
  const unavailable = { lifecycle, activity: 'Activity unavailable', tone: 'neutral' as const }
  if (!state || !activity) return unavailable
  if (options.stopped) return { ...unavailable, activity: 'Activity withheld; inspect current Run facts' }
  if (!Object.hasOwn(lifecycleLabels, state.lifecycle) || ['unknown', 'uncertain', 'interrupted'].includes(state.lifecycle)) return unavailable
  if (activity.status === 'none') return { lifecycle, activity: 'No current activity', tone: 'neutral' }
  if (!['queued', 'starting', 'running', 'waiting', 'succeeded'].includes(state.lifecycle)) return unavailable
  // The successful one-shot step can host independent, acknowledged review work. It is not restarted.
  if (state.lifecycle === 'succeeded' && activity.action !== 'reviewing') return unavailable
  if (!['active', 'stale'].includes(activity.status) || !activity.action || !Object.hasOwn(actionLabels, activity.action)
    || activity.workflowNodeId !== state.workflowNodeId || !sameExecutionIdentity(state.execution, activity.execution)) return unavailable
  const acknowledged = activity.action === 'waiting_approval' ? Boolean(activity.interactionId)
    : Boolean(activity.acknowledgementId && activity.correlationId
      && (activity.action !== 'reviewing' || activity.reviewJobId && activity.interactionId))
  if (!acknowledged) return unavailable
  const label = actionLabels[activity.action]
  if (options.stale || activity.status === 'stale' || node?.attention?.telemetry !== 'current') {
    return { lifecycle, activity: `Last known: ${label} · updates unconfirmed`, tone: 'neutral' }
  }
  return { lifecycle, activity: label, tone: activity.action === 'waiting_approval' ? 'warning' : 'accent' }
}
