import type { AgentChatContext } from '@graphql/contracts/agent-chat'
import { EmptyState, Spinner } from '../../shared/ui/nocturne'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { SelectedRunChatPanel } from '../conversations/agentChat/SelectedRunChatPanel'
import { AgentConversation } from '../conversations/agentChat/AgentConversation'
import { agentChatContextKey } from '../conversations/agentChat/model'

/** The existing Board popover panel. A full selection is required before any chat HTTP request. */
export function AgentChatPanel({ name, activity, running, context, onNewConversation, selectedRun, selectedRunNodeId }: {
  name: string; activity?: string; running?: boolean; context?: AgentChatContext; onNewConversation?: () => void; selectedRun?: SelectedRunState; selectedRunNodeId?: string
}) {
  const generation = useHarnessSessionEpoch()
  if (sessionIsSwitching()) return null
  if (selectedRun && (!selectedRun.active || selectedRun.invalid || selectedRun.identity.runId !== null)) {
    if (context && (context.workspaceId !== selectedRun.identity.workspaceId || context.workflowId !== selectedRun.identity.workflowId)) {
      return <p role="status">Selection changed</p>
    }
    const nodeId = selectedRunNodeId ?? (context?.workspaceId === selectedRun.identity.workspaceId
      && context.workflowId === selectedRun.identity.workflowId ? context.workflowNodeId : undefined)
    return <SelectedRunChatPanel key={`${generation}:${selectedRun.generation.id}`} selection={selectedRun} workflowNodeId={nodeId} />
  }
  const runActivity = activity ? <p className="agent-chat-now">{running ? <Spinner label="Working" /> : null}<span><strong>{name}</strong> · {activity}</span></p> : null
  return <div className="agent-chat-panel">
    {context ? <AgentConversation key={`${generation}:${agentChatContextKey(context)}`} context={context} name={name} runActivity={runActivity} onNewConversation={onNewConversation} />
      : <>{runActivity}<EmptyState icon="info" title="Select a saved Agent to chat" description="Open this Agent on its workflow Board. Chat requires the workspace, workflow, node, Agent and selected Run context." /></>}
  </div>
}
