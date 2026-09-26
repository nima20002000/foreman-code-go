import { EmptyState, Spinner } from '../../shared/ui/nocturne'

/** Chat panel. Only real activity is shown; there is no agent messaging endpoint yet, so there is no composer. */
export function AgentChatPanel({ name, activity, running }: { name: string; activity?: string; running?: boolean }) {
  return <div className="agent-chat-panel">
    {activity ? <p className="agent-chat-now">{running ? <Spinner label="Working" /> : null}<span><strong>{name}</strong> · {activity}</span></p> : null}
    <EmptyState icon="info" title={activity ? 'No messages yet' : 'No activity yet'}
      description="Public messages and tool activity from this agent appear here during a run. Messaging an agent directly is not available yet." />
  </div>
}
