import type { AgentChatContext } from '@graphql/contracts/agent-chat'
import { EmptyState, Spinner } from '../../shared/ui/nocturne'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { AgentConversation } from '../conversations/agentChat/AgentConversation'
import { agentChatContextKey } from '../conversations/agentChat/model'

/** The existing Board popover panel. A full selection is required before any chat HTTP request. */
export function AgentChatPanel({ name, activity, running, context, onNewConversation }: {
  name: string; activity?: string; running?: boolean; context?: AgentChatContext; onNewConversation?: () => void
}) {
  const generation = useHarnessSessionEpoch()
  if (sessionIsSwitching()) return null
  return <div className="agent-chat-panel">
    {activity ? <p className="agent-chat-now">{running ? <Spinner label="Working" /> : null}<span><strong>{name}</strong> · {activity}</span></p> : null}
    {context ? <AgentConversation key={`${generation}:${agentChatContextKey(context)}`} context={context} name={name} onNewConversation={onNewConversation} />
      : <EmptyState icon="info" title="Select a saved Agent to chat" description="Open this Agent on its workflow Board. Chat requires the workspace, workflow, node, Agent and selected Run context." />}
  </div>
}
