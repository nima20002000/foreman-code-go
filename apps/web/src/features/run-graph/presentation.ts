import type { GraphActivity, RunGraphCurrentState } from '@graphql/contracts/wave25'

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
export function presentRunGraphNode(node: NodeFact | undefined): { lifecycle: string; activity: string; tone: 'neutral' | 'accent' | 'warning' } {
  if (!node) return { lifecycle: 'Lifecycle unavailable', activity: 'Activity unavailable', tone: 'neutral' }
  const { activity, state } = node
  const lifecycle = lifecycleLabels[state.lifecycle] ?? 'Lifecycle unavailable'
  if (['interrupted', 'uncertain', 'unknown'].includes(state.lifecycle)) return { lifecycle, activity: 'Activity unavailable', tone: 'neutral' }
  if (activity.status === 'stale') return { lifecycle, activity: 'Activity stale', tone: 'neutral' }
  if (activity.status === 'none') return { lifecycle, activity: 'No current activity', tone: 'neutral' }
  if (activity.status !== 'active' || !activity.action || !activity.execution) return { lifecycle, activity: 'Activity unavailable', tone: 'neutral' }
  const acknowledged = activity.action === 'waiting_approval' ? Boolean(activity.interactionId)
    : Boolean(activity.acknowledgementId && activity.correlationId
      && (activity.action !== 'reviewing' || activity.reviewJobId && activity.interactionId))
  if (!acknowledged) return { lifecycle, activity: 'Activity unavailable', tone: 'neutral' }
  return { lifecycle, activity: actionLabels[activity.action], tone: activity.action === 'waiting_approval' ? 'warning' : 'accent' }
}
