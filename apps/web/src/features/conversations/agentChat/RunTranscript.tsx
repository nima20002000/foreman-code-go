import type { AgentChatSourceTranscript } from '@foreman-code/contracts/agent-chat'
import { AgentChatMessage } from './AgentChatMessage'

export function RunTranscript({ transcript, name }: { transcript: AgentChatSourceTranscript; name: string }) {
  return <section aria-label="Workflow execution transcript">
    {transcript.hasEarlierMessages ? <p className="agent-chat-note">Latest 100 execution messages</p> : null}
    <ol className="agent-chat-messages" aria-label="Execution messages">
      {transcript.messages.filter(message => message.activityChannel !== 'reasoning').map(message => <li key={message.id}>
        <AgentChatMessage message={message} name={name} />
      </li>)}
    </ol>
  </section>
}
